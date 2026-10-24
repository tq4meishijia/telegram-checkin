# Telegram 自动签到工具 · 完整技术方案

> 基于 Cloudflare Workers 免费计划的全栈 Serverless 项目
> 用途：模拟真实用户，定时向指定 Telegram 机器人发送指令（如 `/checkin`），带 Web 管理界面
> 配套文件：`AGENT_TASK.md`（明天喂给本地模型执行的任务书）

---

## 1. 需求与核心结论

| 需求 | 结论 |
|---|---|
| 模拟"用户"给机器人发消息 | Bot API 做不到（机器人不能冒充用户、也不能以用户身份触达其他 bot），必须用 **MTProto 用户态客户端** → 选 **GramJS**（npm 包名 `telegram`） |
| 跑在 Cloudflare Workers 免费版 | **可行，已有社区先例**。GramJS 官方文档明确给出 Workers 用法（`npm i telegram@browser`）；另有成熟开源项目用普通版 gramjs + `nodejs_compat` 跑通。本方案以后者为主路径，前者为备用 |
| 定时触发 | Workers Cron Triggers，免费版**全账户限 5 个**、最小粒度 1 分钟 → 用**单个每分钟 cron + D1 扫表**的自研调度，不用多个 cron |
| Web 管理界面 | Workers Static Assets 托管静态 SPA（免构建，原生 HTML/JS），与 API 同一个 Worker |
| 数据存储 | 全部用 **D1**（免费 5GB / 日读 500 万行 / 日写 10 万行，远超用量）。不引入 KV/R2/Durable Objects，减少活动部件 |
| 登录鉴权 | 管理密码（Worker secret）+ HMAC 签名 Cookie；可选叠加 Cloudflare Access（免费 Zero Trust） |

### 1.1 必须先知道的三个风险（按优先级）

1. **账号风险（最重要）**：用户态自动化（userbot）游走在 Telegram 服务条款边缘，存在**限制/封号**可能。**强烈建议用专门的小号**，开启二次验证，低频使用（每天个位数次），加随机抖动，不要短时间高频发送。
2. **免费版 Cron 只有 10ms CPU 时间**：GramJS 加解密是纯 JS 实现，每次连接+发送一条消息的 CPU 消耗大概率在限额内（网络等待不计 CPU），但**存在偶发超限可能**（isolate 有一定弹性）。M1  spike 阶段必须实测，上线后观察 `exceededCpu` 指标。
3. **Session 字符串 = 账号完全控制权**：StringSession 泄露即账号沦陷。本地生成、加密存储（D1）、管理界面必须鉴权、绝不打印到日志。

---

## 2. 架构设计

```
                ┌──────────────────────────────────────────────┐
                │            Cloudflare Worker (免费)            │
                │                                              │
 Cron Trigger   │   ┌─────────────┐      ┌──────────────────┐  │
 * * * * * ─────┼──▶│ cron/runner │─────▶│ tg/client (GramJS)│──┼──▶ Telegram DC
 (每分钟, 仅1个) │   │  扫 due 任务  │      │  connect→send→关  │  │    (MTProto/WS)
                │   └──────┬──────┘      └──────────────────┘  │
                │          │ 写日志                             │
                │   ┌──────▼──────┐      ┌──────────────────┐  │
   浏览器 ◀──────┼──▶│  Hono API   │◀────▶│  D1 (settings/   │  │
   管理 SPA      │   │  + 鉴权中间件 │      │   tasks/run_logs)│  │
                │   └─────────────┘      └──────────────────┘  │
                │   Static Assets: public/ (index.html/app.js) │
                └──────────────────────────────────────────────┘
```

**关键设计决策：**

- **调度不用 cron 表达式解析器，用 `next_run_at` 字段**：每个任务存下一次执行的 UTC 时间，每分钟 cron `SELECT ... WHERE enabled=1 AND next_run_at <= now` 取出执行，执行后重算下一次。比 cron 匹配器简单、天然支持"错过补跑一次"、防重复（乐观锁更新）。这对小模型实现也更友好。
- **每次执行独立短连接**：cron 触发 → new TelegramClient(StringSession) → connect → sendMessage → （可选）等 N 秒抓机器人回复 → disconnect。无状态、无残留，符合 Workers 模型。
- **登录（拿 Session）放本地脚本**：Telegram 首次登录要收短信/客户端验证码+二步验证，是交互式流程，不适合塞进 Worker。本地 `scripts/login.mjs` 跑一次 → 输出 StringSession → 粘贴到管理界面存 D1。Session 长期有效（除非主动踢登录）。
- **时区用 Intl API 处理**：签到时间一般是本地时间（如每天 08:00 Asia/Shanghai），Workers 无系统时区库，用 `Intl.DateTimeFormat` 做"本地墙钟时间 → UTC"换算（算法见附录 A），不引入任何依赖。

---

## 3. 技术选型与版本

| 组件 | 选择 | 说明 |
|---|---|---|
| 运行时 | Workers + `compatibility_flags = ["nodejs_compat"]` | gramjs 需要 `Buffer` 及 `node:net`（映射到 cloudflare:sockets） |
| 语言 | TypeScript | wrangler 原生支持，无需构建配置 |
| Web 框架 | **Hono** ^4 | 轻量、Workers 原生、API 路由+静态回退都顺手 |
| Telegram | **telegram**（GramJS）^2.26.x | **锁版本**。备用路径：`telegram@browser` dist-tag + `useWSS: true` |
| 数据库 | D1 + wrangler migrations | 唯一存储 |
| 前端 | 原生 HTML/JS/CSS 单页（hash 路由） | 零构建，避免小模型处理 bundler 问题 |
| 包管理 | npm（仓库用 package-lock.json；早期文档写的 pnpm 未采用） | 本地 Node ≥ 22 |
| 测试 | vitest（仅测时区换算等纯函数，可选）+ 手测清单 | 不追求覆盖率 |

### 免费额度 vs 预估用量

| 资源 | 免费额度 | 本项目预估 | 余量 |
|---|---|---|---|
| Workers 请求 | 100,000/天 | cron 1,440/天 + 界面操作 <100/天 | ✅ 约 1.5% |
| Cron Triggers | 5 个/账户 | **1 个** | ✅ |
| Cron CPU | 10ms/次 | 发 1 条消息的加解密（实测确认） | ⚠️ 需观察 |
| 出向连接 | 6 并发/请求 | 1（GramJS 单连接） | ✅ |
| D1 | 读 500 万行/写 10 万行/天，5GB | 读写 <5,000 行/天 | ✅ |
| Worker 体积 | 压缩后 3MB | gramjs 约 1-2MB，**偏紧，需实测** | ⚠️ M1 验证 |

---

## 4. 数据模型（migrations/0001_init.sql）

```sql
-- 键值配置：tg_session（StringSession 字符串）、未来扩展项
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  bot_username   TEXT NOT NULL,                -- 目标机器人，如 @some_checkin_bot
  command        TEXT NOT NULL,                -- 要发送的指令，如 /checkin
  schedule_type  TEXT NOT NULL,                -- 'daily' | 'interval'
  schedule_value TEXT NOT NULL,                -- daily: "08:00" 或 "08:00,20:00"；interval: 分钟数如 "720"
  timezone       TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  jitter_minutes INTEGER NOT NULL DEFAULT 0,   -- 执行时随机延后 0..N 分钟（更像真人）
  capture_reply  INTEGER NOT NULL DEFAULT 0,   -- 是否等待并记录机器人回复
  reply_wait_sec INTEGER NOT NULL DEFAULT 10,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,                         -- 下次执行 UTC 时间 ISO 串，NULL=待计算
  last_run_at    TEXT,
  last_status    TEXT,                         -- 'success' | 'failed'
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_due ON tasks(enabled, next_run_at);

CREATE TABLE run_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,                   -- 'success' | 'failed' | 'skipped'
  detail      TEXT,                            -- 机器人回复摘要 或 错误信息
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_logs_task ON run_logs(task_id, id DESC);
```

**执行器逻辑（cron/runner）**：取 due 任务（上限 10 条/轮，串行执行）→ 乐观锁 `UPDATE tasks SET next_run_at=计算中 WHERE id=? AND next_run_at=旧值` 防并发重跑 → GramJS 发送 → 写 run_logs → 重算 next_run_at（daily=时区内下一个 HH:mm；interval=上次+N 分钟，落后太多则快进到未来）→ 每次 cron 顺带按 1% 概率清理 30 天前日志。
**补跑策略**：`next_run_at` 落后当前时间 30 分钟以内仍执行（日志标注 late）；超过 30 分钟直接跳过重排到下一个未来时点，避免 worker 停机后补发一大串。

---

## 5. API 设计（Hono，前缀 /api，除 login 外全部要鉴权 Cookie）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/login | body {password}，校验 `ADMIN_PASSWORD` secret，种 HMAC 签名 Cookie（7 天，HttpOnly, SameSite=Lax） |
| POST | /api/logout | 清 Cookie |
| GET | /api/overview | 仪表盘：今日成功/失败数、未来 24h 待执行任务列表、session 状态 |
| GET/POST | /api/tasks | 任务列表 / 新建（新建时服务端立刻算出 next_run_at） |
| GET/PATCH/DELETE | /api/tasks/:id | 详情 / 更新（改排期则重算 next_run_at）/ 删除 |
| POST | /api/tasks/:id/run | 立即执行一次（不影响排期），返回执行结果 |
| GET | /api/logs?task_id=&limit= | 日志倒序分页 |
| GET | /api/session | session 状态：未配置 / 已配置（不返回字符串本身！）+ getMe 取账号名 |
| PUT | /api/session | body {session_string}，保存并立即 connect 验证一次，返回账号信息 |
| DELETE | /api/session | 清除 |

**鉴权实现**：`HMAC_SHA256(key=ADMIN_PASSWORD, msg=expiryTimestamp)`，WebCrypto 实现约 30 行，无第三方依赖。可选加固：在 Cloudflare Zero Trust 里给 worker 域名套一层 Access（免费额度够单人用）。

---

## 6. Web 管理界面（public/，原生 SPA）

四个 hash 页：`#/login`、`#/`（仪表盘）、`#/tasks`、`#/logs`、`#/settings`。
- **任务表单字段**：名称、机器人 username、指令、类型（每天定时 / 每隔 N 分钟）、时间或间隔、时区（下拉：Asia/Shanghai、UTC、Tokyo 等常用项+手动输入）、随机抖动分钟、是否抓回复、启用开关。
- **任务行内操作**：编辑、启停、**立即运行**（按钮转圈→弹结果）、查看该任务日志。
- **设置页**：session 状态卡片（已配置：显示账号名/手机号；未配置：粘贴框）、API 凭据从哪拿的说明链接、修改密码提示（改 secret 需 wrangler）。
- 样式：一个 style.css 手写暗色卡片风，不引框架 CDN（避免外网依赖和 CSP 麻烦）。

---

## 7. 仓库结构

```
tg-checkin-worker/
├── wrangler.toml            # nodejs_compat / D1 绑定 / crons=["* * * * *"] / assets
├── package.json             # 锁版本: hono ^4, telegram ^2.26.x, wrangler ^4, typescript, vitest
├── tsconfig.json
├── .dev.vars.example        # TG_API_ID / TG_API_HASH / ADMIN_PASSWORD
├── migrations/0001_init.sql
├── scripts/login.mjs        # 本地交互式登录 → 输出 StringSession
├── src/
│   ├── index.ts             # Hono app + export default { fetch, scheduled }
│   ├── auth.ts              # 登录/HMAC Cookie 中间件
│   ├── db.ts                # D1 查询封装
│   ├── cron/runner.ts       # due 扫描与执行编排
│   ├── cron/schedule.ts     # next_run_at 计算（含时区换算，附录 A）
│   ├── tg/client.ts         # GramJS 封装：connect/send/抓回复/断开，FloodWait 处理
│   └── api/                 # tasks.ts / logs.ts / session.ts / overview.ts
├── public/                  # index.html / app.js / style.css
└── tests/schedule.test.ts   # 时区换算单测（可选但强烈建议）
```

---

## 8. 里程碑总览（执行细节见 AGENT_TASK.md）

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **M0** 脚手架 | 建仓库、wrangler.toml、D1 创建+migrate、hello world、`wrangler dev` 跑通 | 本地访问返回 OK；`wrangler d1 execute` 能查到表 | 0.5h |
| **M1** ⚠️Spike（GO/NO-GO） | 本地登录脚本拿到 session；在 `wrangler dev` 里 GramJS connect+给自己的"收藏夹"发一条消息 | 真机收到消息；无 CPU 超限；worker 体积 <3MB | 1-2h |
| **M2** 存储与 session API | migrations、settings CRUD、session 校验接口 | curl 全流程通 | 1h |
| **M3** 调度引擎 | schedule.ts（附录 A 算法）+ runner + 日志；本地 `/__scheduled` 触发验证 | 建一个"每分钟"测试任务，日志连续成功 | 2h |
| **M4** 任务/日志 API + 鉴权 | CRUD、立即运行、login/logout | curl 全流程通；未登录 401 | 1.5h |
| **M5** Web 界面 | 静态 SPA 四个页面 | 浏览器全流程操作通 | 2h |
| **M6** 部署上线 | wrangler secret、deploy、真实 cron 观察、Cloudflare Access（可选） | 线上连续 24h 日志正常 | 0.5h+观察 |
| **M7**（可选迭代） | 抓回复点按钮、多账号、失败通知（推送到收藏夹） | — | 另议 |

> **M1 是整个项目的闸门**：如果 GramJS 在你的 Worker 环境就是跑不通（两条路径都失败），后面都白搭，所以把它提到最前，先验心脏再造身体。

---

## 9. 附录

### 附录 A：时区内"下一个 HH:mm 的 UTC 时间"算法（供 schedule.ts 实现）

```
输入: times=["08:00","20:00"], tz="Asia/Shanghai", from=当前UTC
输出: 下一个执行时刻的 Date(UTC)

1. for dayOffset in 0..400:
2.   localDate = 用 Intl.DateTimeFormat('en-CA',{timeZone:tz}) 格式化 from+dayOffset天 → "YYYY-MM-DD"
3.   for hm of times 升序:
4.      utc = localWallToUtc(localDate, hm, tz)
5.      if utc > from: return utc

localWallToUtc(dateStr, hm, tz):
  guess = Date.parse(dateStr + 'T' + hm + ':00Z')        // 先假设无时差
  parts  = Intl.DateTimeFormat('en-US',{timeZone:tz, hour12:false, 全字段}).formatToParts(guess)
  asIfUtc = Date.parse(由 parts 拼出的 ISO + 'Z')
  offset  = asIfUtc - guess                               // 该时区在 guess 时刻的偏移
  utc     = guess - offset
  再用 utc 重算一次 offset 细化（跨 DST 边界时必要），返回 guess2 - offset2
```

### 附录 B：GramJS on Workers 两条路径

- **主路径（已验证有先例）**：普通 `telegram` 包 + `compatibility_flags=["nodejs_compat"]`。Buffer、node:net（→cloudflare:sockets）由运行时提供。参考先例：github.com/mtourne/cf-worker-telegram-mcp（gramjs + DO 的完整项目，可查它的 client 封装写法）。
- **备用路径**：`npm i telegram@browser`（官方为 Workers 准备的浏览器构建，走 WebSocket/`useWSS`）。注意浏览器构建会用 `localStorage` 缓存层，Workers 没有 → 需在入口顶部打 `globalThis.localStorage` 内存桩。
- **通用要点**：用已保存的 StringSession **只调 `client.connect()`，永远不要调 `client.start()`**（那会走交互登录）；设 `autoReconnect:false, connectionRetries:3`；用完 `disconnect()`；捕获 `FLOOD_WAIT` 类错误记日志而非死等。

### 附录 C：本地测试 cron

`wrangler dev` 起服务后：`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`（空格要写成 `+`）。线上则在 Cloudflare 面板 → Worker → 触发器 里等真实整分钟触发。

### 附录 D：参考资料

- GramJS 文档（含 Workers 章节）：gram.js.org ；github.com/gram-js/gramjs
- Workers 限额：developers.cloudflare.com/workers/platform/limits
- Cron Triggers：developers.cloudflare.com/workers/configuration/cron-triggers
- D1 定价/限额：developers.cloudflare.com/d1/platform/pricing
- 先例项目：github.com/mtourne/cf-worker-telegram-mcp
- 申请 api_id/api_hash：my.telegram.org/apps
