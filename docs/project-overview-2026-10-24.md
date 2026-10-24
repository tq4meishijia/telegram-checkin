# Telegram 自动签到项目 · 项目概览与代码解读报告

- **报告日期**：2026-10-24
- **分析对象**：`https://github.com/tq4meishijia/telegram-checkin.git`（HEAD `885c095`，main 分支）
- **分析方式**：克隆全量仓库 → 逐个通读全部受版本管理文件 → 安装依赖 → 实跑 `tsc` / `vitest` / `npm audit` → 写临时探针实测安全与边界行为（探针已删除，工作区保持干净）
- **分析范围**：`src/` 14 个文件 1230 行、`tests/` 6 个文件 1229 行、`public/` 527 行、`scripts/login.mjs` 82 行、2 个迁移、全部配置与文档
- **本次未做**：未改动任何项目源码；未部署、未触碰线上资源、未读取任何真实密钥

---

## 0. 结论速览（TL;DR）

这是一个**完成度很高、工程纪律执行到位**的个人向 Serverless 工具：Cloudflare Workers（免费计划）+ Hono + GramJS + D1 + 零构建原生 SPA，用「每分钟 cron 扫 `next_run_at`」替代 cron 表达式解析，用「租约式乐观锁」解决并发与自愈。代码量小（核心 1230 行）、职责边界清楚、注释解释了每个反直觉决策的**原因**（这是本项目最值得保留的资产）。

**实测健康度**：`tsc --noEmit` 0 错误；`vitest` 72/72 全绿（566ms）；D1 外键级联确认生效；迁移可干净应用。

**需要关注的三件事**（详见 §9）：

1. **[高·安全] `POST /api/logout` 未鉴权即可调用**——任何匿名访问者都能反复把 `auth_epoch` +1，**全局吊销管理员所有 Cookie**，构成"谁都登不进去"的拒绝服务。已实测复现（无 Cookie 请求返回 200，epoch 0→1）。
2. **[高·运维] 免费版 cron 单次只有 10ms CPU**——GramJS 的 MTProto 握手/加解密是纯 JS。一旦 `exceededCpu`，本次调用被终止；租约设计能保证 1 小时后自愈，但会**推迟签到**，且最坏情况可能**重复发送**（至少一次语义）。
3. **[中·数据] 前端时区下拉只有 5 个固定选项**——编辑一个时区不在列表内的任务（如 `Europe/Paris`）会**静默改写成 Asia/Shanghai**，属真实的数据损坏路径。

其余为低危瑕疵与技术债，见 §9 分级清单。

---

## 1. 项目定位与运行形态

| 维度 | 说明 |
|---|---|
| 解决什么问题 | Telegram 的 Bot API 无法"以用户身份"给别的机器人发消息；本项目用 **MTProto 用户态账号（userbot）** 定时向指定机器人发送指令（如 `/checkin`），实现自动签到 |
| 运行在哪 | 单个 Cloudflare Worker（免费计划），同一份代码同时承载 API、静态页面与定时任务 |
| 谁在用 | 单管理员、单 Telegram 账号、少量任务（线上现状：1 个任务「每日签到」） |
| 状态存储 | 全部落 D1（SQLite）：`settings` / `tasks` / `run_logs` / `login_attempts` |
| 交互方式 | 浏览器访问 Worker 域名的 Web 管理界面（暗色卡片风 SPA） |
| 账号风险 | userbot 游走 Telegram ToS 边缘，有被限制/封号可能；项目文档已明确要求用小号、低频、加抖动 |

---

## 2. 技术栈与依赖（实测版本）

| 层 | 选型 | 实测版本 | 备注 |
|---|---|---|---|
| 运行时 | Cloudflare Workers + `nodejs_compat` | `compatibility_date = 2025-04-01` | GramJS 需要 `Buffer` / `node:net` |
| 语言 | TypeScript（`strict: true`） | 7.0.2 | 仅 `src/**` 纳入类型检查，`tests` 被排除 |
| Web 框架 | Hono | 4.13.9 | 路由 + 中间件 + 静态回退 |
| Telegram | GramJS（npm 名 `telegram`） | 2.26.22 | **已被 npm 标记 archived**，后继为 `teleproto` |
| 数据库 | Cloudflare D1 | — | 库 `telegram-checkin-db` |
| 前端 | 原生 HTML/JS/CSS，hash 路由，零构建 | — | 无框架、无打包器 |
| 测试 | Vitest（`pool: vmForks`） | 5.0.2 | 5 个测试文件 72 例 |
| 部署 | Wrangler | 4.141.0 | `wrangler deploy` |
| 包管理 | npm（`package-lock.json`） | — | 早期文档写 pnpm，实际用 npm |

**依赖面很小的好处**：生产依赖只有 `hono` + `telegram` 两个，攻击面与供应链风险低。
**依赖面的代价**：`telegram@2.26.22` 已停止维护（安装时会打印 deprecation 警告），后续安全修复不会再有。

`npm audit` 实测：**10 个漏洞（4 moderate / 6 high）**，其中 9 个在开发工具链（wrangler / miniflare / sharp / undici / vite / vitest），不进生产包；**唯一的生产依赖告警是 `hono` 4.12.4–4.13.10 的 `serveStatic` 二次解码问题**——本项目未使用 `serveStatic`（静态资源走 `ASSETS.fetch`），实际不可达，但建议随下次升级一并抬版本。

---

## 3. 目录结构与文件职责

```
telegram-checkin/
├── wrangler.toml              # Worker 配置：nodejs_compat / D1 绑定 / 每分钟 cron / 静态资源 / 日志
├── package.json               # 2 个生产依赖 + 4 个开发依赖；dev/deploy/db:*/typecheck/test/verify
├── tsconfig.json              # strict；include 仅 src/**，exclude 含 tests
├── vitest.config.ts           # pool 固定 vmForks（Windows 默认 forks 会崩）
├── .github/workflows/ci.yml   # push/PR：npm ci → typecheck → test
├── .dev.vars.example          # 本地密钥模板（含 tdesktop 公开 api_id/api_hash）
├── .npmrc                     # 代理默认注释；cache 指向项目内 .npm-cache
├── _run.bat                   # Windows 带代理执行任意命令（路径相对自身）
├── PLAN.md                    # 原始技术方案（设计权威来源）
├── AGENT_TASK.md              # 里程碑任务书 M0–M7
├── AGENT_HANDOFF.md           # 44KB 交接文档（现状/数据模型/踩坑/红线）
├── README.md                  # 面向人的简版说明
├── docs/                      # 过程文档（架构评审、QA 报告、本报告）
├── migrations/
│   ├── 0001_init.sql          # settings / tasks / run_logs + 2 个索引
│   └── 0002_hardening.sql     # login_attempts 表 + tasks.fail_streak 列
├── scripts/login.mjs          # 本地非交互登录 → 打印 StringSession（82 行）
├── public/                    # 零构建 SPA
│   ├── index.html             # 13 行，仅 #app-root + 引两个静态文件
│   ├── app.js                 # 460 行，全部前端逻辑
│   └── style.css              # 54 行，暗色主题
├── src/
│   ├── index.ts               # 86 行 · Hono 装配 + fetch/scheduled 双入口
│   ├── bindings.ts            #  7 行 · Env 类型
│   ├── auth.ts                # 114 行 · HMAC Cookie 中间件（恒定时间 + epoch 吊销 + Origin 校验）
│   ├── ratelimit.ts           # 47 行 · 登录失败限流（D1）
│   ├── validation.ts          # 173 行 · 任务输入严格校验
│   ├── db.ts                  # 19 行 · settings 键值读写
│   ├── util.ts                # 24 行 · safeJson / withTimeout
│   ├── tg/client.ts           # 45 行 · GramJS 封装（只 connect）
│   ├── cron/
│   │   ├── schedule.ts        # 101 行 · 时区换算 + 下次执行时间
│   │   └── runner.ts          # 255 行 · 租约抢占 + 执行 + 重排 + 告警
│   └── api/
│       ├── tasks.ts           # 159 行 · CRUD + 立即运行
│       ├── logs.ts            # 51 行 · 日志查询（limit 收敛）
│       ├── session.ts         # 79 行 · Session 状态/保存/清除
│       └── overview.ts        # 70 行 · 仪表盘聚合
└── tests/
    ├── schedule.test.ts       # 10 例 · 时区与排期
    ├── runner.test.ts         # 14 例 · 租约自愈/告警/回复过滤/超时
    ├── auth.test.ts           # 13 例 · 恒定时间/限流/吊销/CSRF
    ├── validation.test.ts     # 18 例 · 输入校验
    ├── api.test.ts            # 17 例 · 端到端（fake D1）
    └── helpers/fake-db.ts     # 238 行 · 内存版 D1（按 SQL 特征路由）
```

**代码规模**：核心逻辑 1230 行，测试 1229 行——**测试行数约等于源码行数**，对一个个人项目来说相当罕见，也是它敢做"租约自愈"这类改动的前提。

---

## 4. 架构与请求路径

```
                     ┌───────────────────────────────────────────────┐
   Cron * * * * *    │            Cloudflare Worker                  │
   （每分钟）  ──────▶│  scheduled() → ctx.waitUntil(runDueTasks)     │
                     │         │                                     │
                     │         ▼                                     │
                     │  ┌──────────────┐    ┌────────────────────┐   │
                     │  │ cron/runner  │───▶│ tg/client (GramJS) │───┼──▶ Telegram DC
                     │  │ 扫 due 任务   │    │ connect→send→断开   │   │   (MTProto)
                     │  └──────┬───────┘    └────────────────────┘   │
                     │         │ 写 run_logs / 重算 next_run_at      │
                     │         ▼                                     │
   浏览器 SPA  ◀─────│  Hono app ──▶ auth 中间件 ──▶ api/*          │
   (public/)         │      │                                        │
                     │      └──▶ catch-all → ASSETS.fetch + CSP      │
                     │                     │                         │
                     └─────────────────────┼─────────────────────────┘
                                           ▼
                                    D1 (settings/tasks/
                                        run_logs/login_attempts)
```

**路由装配顺序（关键，Hono 按注册顺序匹配）**：

| 顺序 | 内容 | 是否鉴权 |
|---|---|---|
| 1 | `GET /api/health` | 否 |
| 2 | `POST /api/login` | 否（本来就要能匿名调） |
| 3 | `POST /api/logout` | **否 ← 这是缺陷，见 §9 P0-1** |
| 4 | `app.use("/api/*", authMiddleware)` | 只作用于**其后**注册的路由 |
| 5 | `/api/session`、`/api/tasks`、`/api/logs`、`/api/overview` | 是 |
| 6 | `app.get("*")` → `ASSETS.fetch` + 注入 CSP | 否（静态资源） |

`auth.ts` 里的 `SKIP_AUTH` 白名单在当前顺序下是**冗余防御**（那三个路由根本不会经过中间件），保留可防未来调整顺序时误保护——但正因为冗余，它掩盖了"logout 其实没被保护"这个事实。

**静态资源与 CSP 的耦合**：`wrangler.toml` 用 `run_worker_first = ["/", "/app.js", "/style.css"]` 强制这三类路径先进 Worker，再由 catch-all 统一附加 CSP。代价是**新增任何静态文件都必须手动加进这个数组**，否则拿不到 CSP 头——这是一个隐式约定，没有测试守护。

---

## 5. 数据模型

四张表，DDL 见 `migrations/`。

### settings（键值）
| key | 用途 |
|---|---|
| `tg_session` | Telegram StringSession（**明文**，见 §9 P2-5） |
| `auth_epoch` | 登录态纪元，退出登录/改密码 +1，用于全局吊销 Cookie |

### tasks（签到任务）
| 字段 | 说明 |
|---|---|
| `schedule_type` / `schedule_value` | `daily` + `"08:00"` 或 `"08:00,20:00"`；`interval` + 分钟数 `"1".."1440"` |
| `timezone` | IANA 名，默认 `Asia/Shanghai`，写入时用 `Intl` 校验 |
| `jitter_minutes` | 0..1439，执行时随机延后 |
| `capture_reply` / `reply_wait_sec` | 是否抓机器人回复 / 等几秒（1..120） |
| **`next_run_at`** | **ISO 带 Z**；正常态是未来时刻；执行期间是「租约值 = now+1h」 |
| `last_run_at` / `last_status` / `last_error` | `datetime('now')` 空格格式（UTC 无 Z） |
| `fail_streak` | 连续失败计数，成功清零，驱动告警 |

索引 `idx_tasks_due(enabled, next_run_at)` 正好覆盖 cron 的查询条件。

### run_logs（执行日志）
`task_id` 外键 `ON DELETE CASCADE`。**实测确认 D1 默认 `foreign_keys=1`，级联真实生效**（插任务→插日志→删任务→日志数归零）。索引 `idx_logs_task(task_id, id DESC)`。

### login_attempts（限流）
`ip` 主键 + `fail_count` + `window_start`（Unix 秒）。60 秒窗口、5 次锁定。

### 时间格式双轨制（本项目最大的坑）
- 代码写入的 `next_run_at` 是 **ISO（`T` + `Z`）**
- `datetime('now')` 系列是 **空格格式（无 `Z`）**
- 二者**不能直接做 SQL 字符串比较**（`'T'`(0x54) > `' '`(0x20)，ISO 行永远"大于"任何空格时间）
- 前端解析空格串会被当成本地时区 → 必须补 `Z`（`app.js:28-32` 的 `parseDate`）

代码在 `runner.ts:45-48`、`overview.ts:11-15,55`、`app.js:28-32` 三处都做了正确处理，但这是**靠人记住的约定，没有类型或测试强制**。新增任何时间查询都必须复查这一点。

---

## 6. 核心流程

### 6.1 签到执行链路（`src/cron/runner.ts`）

```
每分钟 cron
  └─ runDueTasks()
       ├─ SELECT * FROM tasks
       │    WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       │    ORDER BY next_run_at LIMIT 10          ← ? 用 JS 生成的 ISO 绑定
       ├─ for 每个任务（串行，避免并发触发 TG 风控）
       │    └─ executeWithClaim(env, task)
       │         ├─ 迟到 > 30 分钟？→ 不补发，重排 + 记 skipped/missed,rescheduled
       │         ├─ 租约抢占：UPDATE ... SET next_run_at=now+1h
       │         │              WHERE id=? AND next_run_at=<读到的旧值>
       │         │    changes=0 → 已被别人抢走，返回 skipped/already_claimed
       │         ├─ executeOneTask()
       │         │    ├─ 25s 超时包装（Promise.race）
       │         │    ├─ withClient: 读 session → new TelegramClient → connect
       │         │    │    → sendMessage(target, {message: command})
       │         │    │    → [可选] 等 reply_wait_sec 秒 → getMessages(limit 10)
       │         │    │         → 取第一条 !out 且 id > 本次发送 id 的消息
       │         │    │    → disconnect
       │         │    ├─ batch 写 run_logs + 更新 tasks 状态/fail_streak
       │         │    └─ fail_streak ≥3 且 %3==0 → 给 "me" 发告警（失败不递归）
       │         └─ finally: 重排 next_run_at（算不出则 +1h 兜底；写失败重试一次）
       └─ 1% 概率清理：30 天前日志 + 1 小时前限流记录
```

### 6.2 租约抢占与自愈（本项目的设计核心）

**不变量**：抢占成功后，**任何路径**（成功/失败/抛异常/isolate 被 kill）都不会让 `next_run_at` 停在"永远选不中"的状态。

| 场景 | 旧实现（已修） | 现实现 |
|---|---|---|
| 抢占占位值 | `NULL` | `now + 1h`（租约） |
| 执行中崩溃 | 任务永久停跑，无告警 | 1 小时后租约到期，自动重试 |
| 重排写失败 | 同上 | 重试一次；仍失败则靠租约自愈 |
| 手动运行与 cron 撞车 | 可能双发 | 同一个 `UPDATE ... WHERE next_run_at=旧值` 互斥，撞车返回 409 |

**手动运行语义**（`POST /api/tasks/:id/run`）：
- 原排期**未到点** → 执行后**原样恢复** `next_run_at`（不扰动排期）
- 原排期**已到点** → 执行后**消耗该 slot**，从原时间点起算下一个
- `next_run_at` 原本为 `NULL`（历史脏数据）→ 执行后顺带修复

**语义定性：这是 at-least-once，不是 exactly-once。** 如果 `sendMessage` 成功、但进程在重排前被 kill，1 小时后会**再发一次**。对签到场景可接受（重复签到通常无害），但如果未来接入"扣费/领券"类一次性操作，必须引入幂等键。

### 6.3 排期算法（`src/cron/schedule.ts`）

`localWallToUtc(dateStr, hm, tz)`：先假设零偏移拼 ISO → 用 `Intl.DateTimeFormat.formatToParts` 反推该时刻的本地墙钟 → 算偏移 → 修正；**再迭代一轮处理 DST 边界**。不引入任何时区库。

`computeNextRun(input, from)`：
- `daily`：时间点排序，从 `from` 起逐天（最多 400 天）找第一个 `> from` 的时刻
- `interval`：`from + N 分钟`
- 最后叠加 `0..jitterMinutes` 随机抖动
- 任何非法输入**返回 `null` 不抛异常**（调用方负责兜底）

**实测边界行为**：
- `Asia/Shanghai 08:00` → `00:00Z` ✅
- `daily 00:00 UTC` ✅（`hour12:false` 在本机 V8 返回 `"00"` 而非经典的 `"24"`，未踩坑）
- DST 春季跳变 `America/New_York 2025-03-09 02:30`（该墙钟不存在）→ 返回 `06:30Z`（= 当地 01:30），比预期早 1 小时。**一年一次、且 Asia/Shanghai 无 DST，实际无影响**
- **`interval` 有累积漂移**：`from` 取"现在"而非"上次计划时间"，所以 `interval 60` 从 `10:00:30` 起算会得到 `11:00:30`，每轮把执行耗时累加进去

### 6.4 鉴权与会话

**管理端登录态**：无状态 HMAC Cookie。

```
cookie = "<expiryMs>.<epoch>.<hex(HMAC-SHA256(key=ADMIN_PASSWORD, msg="expiry.epoch"))>"
属性   = HttpOnly; SameSite=Lax; Path=/; Max-Age=604800 (+ Secure 仅当 https)
```

- 密码比对：双方先 SHA-256 再逐字符异或累积 → 恒定时间，无长度侧信道
- 吊销：`auth_epoch` 存在 D1，每次请求读一次比对；退出登录/改密码 +1 → 所有旧 Cookie 立即失效
- CSRF 纵深：`POST/PUT/PATCH/DELETE` 若带 `Origin` 且 host 不匹配 → 403
- 限流：同 IP 60 秒 5 次失败 → 429

**Telegram StringSession 生命周期**：

```
本地 scripts/login.mjs（非交互：TG_PHONE/TG_2FA 环境变量 + 轮询 .tg_code.txt）
   → 打印 SESSION=...
   → 管理界面设置页粘贴 → PUT /api/session
   → Worker 先用待保存的 session connect + getMe 验证（20s 超时）→ 通过才入库
   → 之后每次执行：读 D1 → new StringSession → connect()（绝不 start()）→ 用完 disconnect()
```

Session 字符串**任何 API 都不返回、不打日志、不进已提交文件**——本次通读逐处确认无泄露点。

### 6.5 前端 SPA（`public/app.js`，460 行）

| 机制 | 作用 |
|---|---|
| hash 路由 | `#/login` `#/` `#/tasks` `#/logs` `#/settings` |
| `api()` 封装 | 统一 fetch；401 且不在登录页才跳转（避免同 hash 不触发 hashchange） |
| `currentRenderSeq` | 渲染代次令牌；异步回调回来时若代次过期就丢弃，防旧页面覆盖新页面 |
| `parseDate()` | 给 D1 空格时间补 `Z`，否则浏览器按本地时区解析导致偏 8 小时 |
| 事件委托 | `data-action` + 全局 click/change 监听，替代内联 `onclick`，为 CSP `script-src 'self'` 铺路 |
| `esc()` | 转义 `& < > "`，覆盖所有用户数据注入点 |

**XSS 复核**：所有插值点都过了 `esc()`，未发现可利用突破口。唯一例外是 `scheduleDesc()` 直接拼接 `schedule_value` / `timezone`（`app.js:53-56`），但这两个值在服务端被强校验为 `HH:MM` 列表和合法 IANA 名，实际不可注入——属"防御深度不足"而非漏洞。

---

## 7. API 清单

除 `/api/health`、`/api/login`、`/api/logout` 外全部需要 Cookie。

| 方法 | 路径 | 说明 | 实测备注 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | — |
| POST | `/api/login` | `{password}` → 种 Cookie | 限流 429 生效 |
| POST | `/api/logout` | 清 Cookie + epoch+1 | **未鉴权，见 P0-1** |
| GET | `/api/overview` | 今日统计 / 未来 24h 任务 / session 状态 | `upcoming` 含**已过期**任务 |
| GET | `/api/tasks` | 列表 | — |
| POST | `/api/tasks` | 新建，服务端立即算 `next_run_at` | 校验失败 400 |
| GET | `/api/tasks/:id` | 详情 | 404 |
| PATCH | `/api/tasks/:id` | 部分更新，改排期则重算 | 见 P2-4 |
| DELETE | `/api/tasks/:id` | 删除 | **不存在也返回 200** |
| POST | `/api/tasks/:id/run` | 立即执行（同步返回结果） | 并发撞车 409 |
| GET | `/api/logs` | `task_id` / `limit`(1..100) / `before_id` | limit 收敛正确 |
| GET | `/api/session` | 状态 + 账号信息（不含字符串） | 每次都会真连 Telegram |
| PUT | `/api/session` | 保存前先验证 | 20s 超时 |
| DELETE | `/api/session` | 清除 | — |

**SQL 注入复核**：全部查询用 `prepare/bind`；PATCH 的动态列名来自固定白名单数组；logs 的 WHERE 条件为固定字符串拼接。**无注入面。**

---

## 8. 测试体系与实测结果

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npx vitest run` | ✅ 5 文件 / **72 例全绿** / 566ms |
| `npx wrangler d1 migrations apply --local` | ✅ 0001 + 0002 均成功 |
| `PRAGMA foreign_keys` | ✅ 1（级联真实生效） |
| `npm audit` | ⚠️ 10 漏洞（4 moderate / 6 high，9 个在 dev 工具链） |

**测试设计的亮点**：`tests/helpers/fake-db.ts` 手写了一个 238 行的内存版 D1，按 SQL 特征路由，并能 `failOn("INSERT INTO run_logs")` **注入故障**。这让"抢占后崩溃"、"重排也失败"这类最难复现的稳定性场景变成了可回归的单测——这是本项目工程质量的分水岭。

**测试的边界**（必须知道）：
- 真实 Telegram 连接全部是 mock，**真实 GramJS 会话链路无自动化覆盖**
- 没有 e2e / 浏览器测试；前端 460 行零测试
- `tests/` 被 `tsconfig.json` 排除，**测试代码本身不受类型检查**

---

## 9. 问题清单（分级，含证据）

> 严重度定义：**P0** 可被外部利用或造成数据损坏，应尽快修；**P1** 特定条件下出错或明显影响体验；**P2** 瑕疵与技术债。

### P0

#### P0-1 · `POST /api/logout` 未鉴权，可被匿名调用（安全 / DoS）

- **位置**：`src/index.ts:50-58`（注册在 `src/index.ts:61` 的 `app.use("/api/auth")` 之前）
- **机制**：Hono 的中间件只作用于**其后**注册的路由。logout 注册在前面 → 完全绕过鉴权 → 任何人都能触发 `bumpAuthEpoch()`
- **实测证据**：
  ```
  A status=200  epoch before=undefined  after=1
  ```
  （无任何 Cookie，直接 POST，返回 200 且 `auth_epoch` 被 +1）
- **影响**：攻击者循环调用即可让管理员**每次登录后立刻被踢下线**，永久无法使用管理界面。不影响已排期的签到任务（cron 不依赖 Cookie），但等于管理端被锁死
- **修复**：把 `/api/logout` 移到 `app.use("/api/*", authMiddleware)` **之后**；补一条"无 Cookie 调 logout → 401"的单测。约 3 行改动
- **附带**：前端根本没有"退出登录"按钮（`grep logout public/app.js` 无结果）——这个端点目前只被攻击面使用

### P1

#### P1-1 · 前端时区下拉只有 5 个选项，编辑会静默改写时区（数据损坏）

- **位置**：`public/app.js:250-254`
- **机制**：`<option>` 只有 `Asia/Shanghai / UTC / Asia/Tokyo / America/New_York / Europe/London`。若任务的 `timezone` 不在此列（比如通过 API 建的 `Europe/Paris`），没有任何 option 命中 `selected`，浏览器默认选中第一项 → 保存时把 `Asia/Shanghai` 写回
- **影响**：**静默篡改用户配置**，且改完不报错。签到时间会整体偏移数小时
- **修复**：若 `task.timezone` 不在列表内，动态补一个 `<option selected>`；或改成 `<input list="...">` 自由输入（服务端已有 `isValidTimezone` 兜底）

#### P1-2 · 畸形 `Origin` 头导致未捕获异常（健壮性）

- **位置**：`src/auth.ts:86` `new URL(origin).host`
- **实测证据**：`Origin: null`（沙箱 iframe / `file://` 场景浏览器会发这个值）→ **抛出 `Invalid URL`**，请求以 500 结束，而不是 403
- **影响**：任何客户端都能制造 500 + 错误日志噪声；不构成越权（异常发生在鉴权之前，请求被拒）
- **修复**：`try { ... } catch { return 403 }`，或先判断 `origin === "null"`

#### P1-3 · 免费版 cron 的 10ms CPU 是硬约束（运维）

- **位置**：`wrangler.toml:9` `crons = ["* * * * *"]` + GramJS 全链路
- **机制**：免费计划每次 Cron 触发只有 **10ms CPU**（网络等待不计，但 MTProto 的 JS 侧编解码/加解密计入）。超限 → Error 1102 `exceededCpu` → 本次调用被终止
- **影响**：租约设计保证了不会永久停跑，但会出现"签到推迟 1 小时"；若在 `sendMessage` 之后、重排之前被 kill，则 1 小时后**重复发送**
- **建议**：把 Cloudflare 面板的 `exceededCpu` 指标纳入日常观察；若频繁超限，升级到付费计划（$5/月，CPU 30s）是最省事的解法——这属于成本决策，不应靠改代码硬扛

#### P1-4 · `hono` 落在已知公告的版本区间（供应链）

- **实测**：`hono@4.13.9`，`npm audit` 报 `4.12.4–4.13.10` 的 `serveStatic` 二次解码绕过中间件问题
- **评估**：本项目**未使用** `serveStatic`（静态资源走 `ASSETS.fetch`），该路径不可达 → 实际风险低
- **建议**：下次升级随手抬到 `>4.13.10`；`package.json` 的 `^4.13.9` 会在 `npm update` 时自动满足

### P2

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| P2-1 | `public/app.js` 全局 | 无退出登录入口，`/api/logout` 成死代码 | 管理员无法主动下线；只能等 7 天过期或清 Cookie |
| P2-2 | `src/api/tasks.ts:126-131` | `DELETE` 不检查 `changes`，删不存在的任务也返回 `{ok:true}` | 前端误以为成功；实测确认 |
| P2-3 | `src/api/overview.ts:56-60` | `upcoming` 只设上界不设下界，**含已过期任务** | "即将执行"列表里出现 1 小时前就该跑的任务，前端显示"已过期"；实测确认 |
| P2-4 | `src/api/tasks.ts:76-78` | PATCH 合并存量后无条件校验排期组合 | 历史脏数据（`daily` + `"720"`）会导致**连"启用/停用"都返回 400**，无法通过界面修复；实测确认 |
| P2-5 | `migrations/0001_init.sql:2-6` | StringSession **明文**存 D1 | 拿到 D1 读权限 = 拿到 Telegram 账号控制权。可用 `AES-GCM` + 派生密钥（WebCrypto，零依赖）加密，成本约 30 行 |
| P2-6 | `src/cron/schedule.ts:97-101` | jitter 直接叠加在算出的时刻上，**可能越过下一个 daily slot** | 实测：`08:00,09:00` + jitter 90，200 次抽样中 **76 次**越过 09:00。建议 jitter 取 `min(jitter, 到下一个 slot 的间隔)` |
| P2-7 | `src/cron/schedule.ts:84-89` | `interval` 从"现在"起算而非"上次计划时刻" | 每轮累加执行耗时，长期漂移；实测 `60min` 从 `10:00:30` → `11:00:30` |
| P2-8 | `src/index.ts:70-75` | 静态响应只加 CSP，缺 `X-Content-Type-Options: nosniff`、`Referrer-Policy` | 纵深防御缺口；实测 `nosniff=null` |
| P2-9 | `wrangler.toml:16` | `run_worker_first` 硬编码三个路径 | 新增静态文件若忘记加进来就拿不到 CSP；无测试守护 |
| P2-10 | `tsconfig.json:17-18` | `tests` 被排除出 typecheck | 测试代码的类型错误不会被 `npm run typecheck` 发现 |
| P2-11 | 仓库根 | 无 ESLint / Prettier / `.editorconfig` | 风格靠人工；CI 只跑 typecheck+test |
| P2-12 | `wrangler.toml:5` | `compatibility_date = 2025-04-01`（已 18 个月）+ 旧式 `nodejs_compat`（非 `_v2`） | 拿不到运行时改进与更小的 polyfill；升级需完整回归，属计划性工作 |
| P2-13 | `package.json:27-29` | `optionalDependencies: @esbuild/win32-x64` | 平台特定依赖进了公共清单，换机时无意义 |
| P2-14 | `AGENT_HANDOFF.md`（529 行 / 44KB） | 单一巨型交接文档，与 README 大量重叠 | 长期维护下容易与代码脱节；建议按主题拆分（架构/运维/踩坑）或至少加目录 |
| P2-15 | `PLAN.md:230` | 附录 C 仍写 `/__scheduled?cron=...`（旧版 wrangler 写法） | 与 README/HANDOFF 的 `/cdn-cgi/local/scheduled` 冲突；新人会踩 |
| P2-16 | `src/api/session.ts:15-43` | 每次打开设置页都**真连一次 Telegram** 做 `getMe` | session 失效时页面要等满 20s；频繁刷新可能触发 TG 侧限流 |

---

## 10. 上一轮评审项的闭环情况

`docs/architecture-analysis-2026-10-24.md` 是基于更早提交（`bd9cdc1`）的评审。逐条复核当前 HEAD：

| 原编号 | 问题 | 状态 |
|---|---|---|
| S1 | 登录无限流 + 非恒定时间比较 | ✅ 已修（D1 限流 + SHA-256 双摘要） |
| S3 | Cookie 缺 Secure | ✅ 已修（按协议条件添加） |
| S4 | 无法单独吊销 Cookie | ✅ 已修（`auth_epoch` 全局吊销） |
| S5 | 无 CSRF 防护 | ⚠️ 部分（Origin 校验已加，但畸形 Origin 会 500 → P1-2） |
| S6 | 内联事件处理器 | ✅ 已修（事件委托） |
| S7 | 畸形 JSON → 500 | ✅ 已修（`safeJson`） |
| T1 | 占位 NULL → 永久停跑 | ✅ 已修（租约值 + finally 重排，含回归测试） |
| T2 | 超时定时器未清除 | ✅ 已修（`clearTimeout` in finally） |
| T3 | `limit=-1` 拉全表 | ✅ 已修（收敛 1..100） |
| T4 | 输入无类型/组合校验 | ✅ 已修（`validation.ts` 173 行） |
| T5 | 抓回复误取历史消息 | ✅ 已修（`!out && id > sentId`） |
| T6 | 手动运行与 cron 双发 | ✅ 已修（同一抢占语句互斥） |
| T7 | session 验证无超时 | ✅ 已修（20s） |
| T9 | 无失败告警 | ✅ 已做（连续 3 次起每 3 次发 `me`） |
| E1 | `.npmrc` 硬编码代理 | ✅ 已改注释 |
| E2 | `_run.bat` 路径失效 | ✅ 已改相对路径 |
| E3 | 无 CI | ✅ 已加 GitHub Actions |
| E4 | 无备份脚本 | ✅ 已加 `db:export` |
| E5 | 无 observability | ⚠️ 部分（已开 `[observability]`，`compatibility_date` 未动） |
| E7 | 无 LICENSE | ✅ 已加 MIT |
| N1 | vitest 默认 pool 崩 | ✅ 已固定 `vmForks` |
| N2 | `telegram` 包 archived | ❌ 未处理（有意沿用，需长期关注） |

**结论**：上一轮 P0/P1 基本全部闭环，且每条都配了回归测试。本轮新发现集中在**鉴权顺序（P0-1）**、**前端边界（P1-1）**、**时区/抖动算法边界（P2-6/7）**——都是上一轮没扫到的角落。

---

## 11. 维护手册（接手后怎么改代码）

### 标准改动流程
1. 改代码（严格限定范围，不加未要求的功能/依赖）
2. `npm run typecheck`（必须 0 错误）
3. `npm test`（必须 72/72；改了 schedule/runner 必须同步加用例）
4. `npm run dev` + `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"` 实测受影响路径
5. **先** `npm run db:migrate:remote`，**再** `npm run deploy`
6. 浏览器复验（静态资源更新后需硬刷新）
7. 同步更新 `AGENT_HANDOFF.md` + `README.md`（项目红线 #9）

### 改这几个文件时最容易踩的坑
| 要改的地方 | 必须先想清楚 |
|---|---|
| 任何时间比较 | ISO(`T`/`Z`) 与 `datetime('now')`(空格) 不可混比；前端必须 `parseDate()` 补 `Z` |
| `runner.ts` 抢占/重排 | 必须保持"抢占值一定是未来时刻"；`finally` 不能漏；不能改成 NULL |
| `tg/client.ts` | 只能 `connect()`，**永远不能 `start()`** |
| 新增静态文件 | 要同步加进 `wrangler.toml` 的 `run_worker_first`，否则无 CSP |
| 新增 API 路由 | 必须注册在 `app.use("/api/*", authMiddleware)` **之后**（P0-1 就是这么来的） |
| 新增 DB 列 | 写新迁移文件（`0003_*.sql`），不要改已应用的迁移 |

### 环境相关
- Node ≥ 22；`npm install` 走 `.npmrc`（代理默认关闭，本机在 Clash 后需取消注释或用 `_run.bat`）
- 本地触发 cron 的正确路径是 `/cdn-cgi/local/scheduled`（不是 `/__scheduled`）
- `vitest` 必须用 `pool: vmForks`（配置已固定，别删）

---

## 12. 建议的迭代路线

> 遵循项目既有的"最小变更、YAGNI"原则：不换框架、不引时区/cron 库、不动数据模型语义。

### 第一批（小改动，高收益，建议本周内）
1. **P0-1 鉴权顺序**：logout 移到中间件之后 + 补 1 条单测（3 行）
2. **P1-2 畸形 Origin**：`try/catch` → 403（3 行）
3. **P1-1 时区下拉**：不在列表内的时区动态补 option（5 行）
4. **P2-2/P2-3**：DELETE 返回 404；`upcoming` 加下界（各 1-2 行）
5. **补 P2-9 的守护**：加一条断言"public/ 下每个文件都在 run_worker_first 里"，把隐式约定变成测试

### 第二批（半天）
6. **P2-5 Session 加密**：`AES-GCM` + 从 `ADMIN_PASSWORD` 派生密钥（WebCrypto，零新依赖），读写各加一层
7. **P2-6/7 排期边界**：jitter 上限收敛到下一个 slot；interval 改从"上次计划时刻"起算
8. **P2-8 安全响应头**：补 `nosniff` + `Referrer-Policy`
9. **P2-10**：把 `tests` 纳入 typecheck（`tsconfig` 加一个 `tsconfig.test.json` 或直接 include）

### 第三批（按需 / 需要决策）
10. **P1-3 CPU 观察**：连续观察 7 天 `exceededCpu`；若出现，讨论升级付费计划（成本决策，不是代码问题）
11. **`teleproto` 迁移评估**：`telegram@2.26.22` 已 archived，官方称 `teleproto` largely compatible。建议**先锁定版本 + 关注 CVE**，等出现安全公告再迁，不要顺手换
12. **M7 功能项**（多账号、inline keyboard、Cloudflare Access）：做之前先与用户确认优先级；多账号会放大对上游维护态的依赖，建议排在 `teleproto` 决策之后

---

## 13. 本次分析的证据边界

| 已验证 | 未验证 |
|---|---|
| 全量源码通读（14 个 src 文件、6 个测试文件、前端 3 文件、2 个迁移、全部配置与文档） | 线上 Worker 的真实运行状态（`exceededCpu`、真实 cron 触发、CSP 在生产的实际响应头） |
| `tsc --noEmit` 0 错误 | 真实 Telegram 登录与发送链路（全部 mock） |
| `vitest` 72/72 通过 | 真实 D1 远程库的数据与限额 |
| `npm audit` 漏洞清单 | Cloudflare 账号权限与 secrets 现状 |
| D1 本地迁移 + 外键级联行为 | 浏览器端的真实渲染与交互（未起 dev server 做 e2e） |
| 未鉴权 logout / 畸形 Origin / DELETE 200 / upcoming 含过期 / PATCH 阻塞 / jitter 越 slot / DST 边界（均用临时探针实跑） | 各版本 Node/V8 下 `Intl` 行为的差异（仅在本机 Node 22 验证） |

探针文件已在跑完后删除，`git status` 确认工作区干净，**未修改任何项目源码**。
