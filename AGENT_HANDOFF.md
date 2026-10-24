# AGENT_HANDOFF · 接手开发文档（面向 AI Agent）

> 项目：**Telegram 自动签到工具（tg-checkin）**
> 用途：以**用户态账号（userbot）**定时向指定 Telegram 机器人发送指令（如 `/checkin`），自带 Web 管理界面。
> 本文档是给**下一位接手开发的 Agent** 的完整交接材料，读完即可独立改代码、调试、部署。
> 配套阅读：`PLAN.md`（原始设计方案，权威设计来源）、`AGENT_TASK.md`（里程碑任务书）、`README.md`（面向人类用户的简版说明）。

---

## 0. 一分钟现状（2026-10-24 加固迭代后）

- **进度**：M0–M6 全部完成并上线；2026-10-24 完成一轮安全/稳定性加固（变更清单见 §17），M7 剩余项未开始。
- **线上地址**：https://tg-checkin.tq4meishijia.workers.dev
- **线上状态**：Worker 已部署、远程 D1 已应用 **0001** 迁移、3 个 secrets 已配置、真实 Telegram Session 已保存并验证可发消息。
  > ⚠️ **部署加固版代码前必须先** `npm run db:migrate:remote`（0002 迁移新增 `login_attempts` 表和 `tasks.fail_streak` 列，新版代码依赖它们）。
- **线上现有数据**：1 个任务「每日签到」（目标 `me`、指令 `/checkin`、daily 08:00 Asia/Shanghai）；有成功/失败日志若干。
- **代码健康度**：`npx tsc --noEmit` 无错误；vitest **72/72** 通过（5 个测试文件）；包体 gzip 约 333 KiB（远低于 3MB 上限）。
- **代码仓库**：https://github.com/tq4meishijia/cf-tg-checkin （**公开**仓库，MIT LICENSE）。
- **CI**：`.github/workflows/ci.yml`，push/PR 自动跑 `npm ci` + typecheck + test。

> 敏感信息（管理密码、StringSession、api_hash）**不在任何已提交文件里**，位置见第 11 节。

---

## 1. 快速接手 Checklist

1. 读 `PLAN.md`（设计决策的"为什么"），再读本文件（"现在是什么样、怎么改"）。
2. 环境：Node.js ≥ 22、npm（仓库已有 `package-lock.json`，**沿用 npm，不用 pnpm**，尽管 PLAN 写的是 pnpm）。
3. `npm install`（`.npmrc` 默认**不走代理**；本机在 GFW 后需取消 `.npmrc` 里 proxy 两行注释，或用 `_run.bat npm install`，见第 9 节）。
4. 准备 `.dev.vars`（从 `.dev.vars.example` 复制；真实值向用户索取或从用户环境拿，**禁止编造**）。
5. `npm run db:migrate:local` 建本地 D1。
6. `npm run dev` 起服务，访问 http://127.0.0.1:8787。
7. 改代码后固定流程：`npm run typecheck` → `npm test` → `npm run deploy` → 浏览器复验（见第 12 节）。

---

## 2. 架构总览

```
                ┌──────────────────────────────────────────────┐
                │            Cloudflare Worker (免费)            │
 Cron Trigger   │   ┌─────────────┐      ┌──────────────────┐  │
 * * * * * ─────┼──▶│ cron/runner │─────▶│ tg/client (GramJS)│──┼──▶ Telegram DC
 (每分钟, 仅1个) │   │  扫 due 任务  │      │  connect→send→关  │  │   (MTProto TCP)
                │   └──────┬──────┘      └──────────────────┘  │
                │          │ 写 run_logs / 重算 next_run_at     │
   浏览器 ◀──────┼──▶│  Hono API   │◀────▶│  D1 (settings/   │  │
   管理 SPA      │   │  + 鉴权中间件 │      │   tasks/run_logs) │  │
                │   └─────────────┘      └──────────────────┘  │
                │   Static Assets: public/ (index.html/app.js) │
                └──────────────────────────────────────────────┘
```

**五个关键设计决策（不可违背）：**

1. **调度不靠 cron 表达式解析，靠 `tasks.next_run_at` 字段**：每分钟 cron 扫 `enabled=1 AND next_run_at <= now` 的任务，执行后重算下一次。天然支持"错过补跑一次"、用乐观锁防并发。
2. **每次执行独立短连接**：new TelegramClient(StringSession) → connect → sendMessage →（可选）等回复 → disconnect。无状态、无残留，符合 Workers 模型。
3. **交互式登录只在本地脚本做**：首次登录要收验证码 + 二步密码，不适合 Worker。`scripts/login.mjs` 跑一次拿 StringSession → 存 D1。
4. **Worker 内只 `connect()`，永远不 `start()`**：`start()` 会走交互登录流程。
5. **时区换算用 `Intl` API 自实现**，不引入任何时区/cron 依赖。

---

## 3. 目录结构与文件职责

```
tg-checkin-serverless/
├── wrangler.toml            # Worker 配置：nodejs_compat、D1 绑定、cron、静态 assets、observability
├── package.json             # 依赖与脚本（npm）
├── package-lock.json
├── tsconfig.json            # TS 配置（strict、bundler 解析、workers-types；排除 tests）
├── vitest.config.ts         # pool 固定 vmForks（默认 forks 在部分 Windows 环境加载即崩）
├── .github/workflows/ci.yml # CI：push/PR 跑 npm ci + typecheck + test
├── .npmrc                   # 代理默认注释掉，按需取消注释
├── .dev.vars.example        # 本地密钥模板（已提交）
├── .dev.vars                # 本地真实密钥（gitignored，不提交）
├── .gitignore
├── LICENSE                  # MIT
├── PLAN.md                  # 原始完整技术方案（设计权威）
├── AGENT_TASK.md            # 里程碑任务书
├── README.md                # 人类用户简版说明
├── AGENT_HANDOFF.md         # ← 本文档
├── _run.bat                 # Windows 下带代理环境执行任意命令的辅助脚本（路径相对自身目录）
├── migrations/
│   ├── 0001_init.sql        # 三张表 DDL（settings/tasks/run_logs）
│   └── 0002_hardening.sql   # login_attempts 表 + tasks.fail_streak 列
├── scripts/
│   └── login.mjs            # 本地登录脚本（非交互、SOCKS5 代理模式，见 §7）
├── src/
│   ├── index.ts             # Hono app 装配：login/logout/health、中间件、路由、静态回退（带 CSP）、scheduled 入口
│   ├── bindings.ts          # Env 类型（DB/ASSETS/3 个密钥字符串）
│   ├── auth.ts              # HMAC Cookie 鉴权中间件（恒定时间比较 + epoch 吊销 + Origin 校验）
│   ├── ratelimit.ts         # 登录失败限流（D1 login_attempts 表，60s/5 次）
│   ├── validation.ts        # 任务 body 输入校验（严格类型 + 排期组合）
│   ├── util.ts              # safeJson / withTimeout
│   ├── db.ts                # settings 表读写封装：getSetting/setSetting/deleteSetting
│   ├── tg/
│   │   └── client.ts        # withSession()/withClient()：建 client→connect→fn→disconnect
│   ├── cron/
│   │   ├── schedule.ts      # computeNextRun() + localWallToUtc()（时区换算核心）
│   │   └── runner.ts        # runDueTasks() + executeWithClaim() + executeOneTask()（租约抢占 + finally 重排 + 失败告警）
│   └── api/
│       ├── overview.ts      # GET /api/overview（仪表盘聚合，支持 from/to 本地日界）
│       ├── tasks.ts         # 任务 CRUD + /run（带抢占防并发）
│       ├── logs.ts          # 日志查询（limit 强制收敛 1..100）
│       └── session.ts       # session 状态/保存/清除（withSession + 20s 超时）
├── public/                  # 原生 SPA（零构建）
│   ├── index.html           # 含 #app-root 容器，引 style.css 和 app.js
│   ├── app.js               # hash 路由 SPA 全部逻辑（事件委托，无内联处理器）
│   └── style.css            # 暗色卡片主题（约 54 行）
└── tests/
    ├── schedule.test.ts     # schedule.ts 的 10 个单测
    ├── runner.test.ts       # runner 14 个单测（T1 回归/租约自愈/告警/回复过滤/超时）
    ├── auth.test.ts         # 鉴权与限流 13 个单测
    ├── validation.test.ts   # 输入校验 18 个单测
    ├── api.test.ts          # 端到端 17 个单测（fake D1）
    └── helpers/fake-db.ts   # 内存版 fake D1（按 SQL 特征路由）
```

---

## 4. 数据模型

三张表 + 一张限流表，DDL 以 `migrations/` 为准（0001 初始化，0002 加固）。

### settings（键值配置）
| 字段 | 说明 |
|---|---|
| key (PK) | `tg_session`（StringSession 字符串）、`auth_epoch`（登录态纪元，退出登录/改密码 +1 用于吊销 Cookie） |
| value | 配置值 |
| updated_at | `datetime('now')`，**UTC、空格格式、无 Z**（见 §8 时间格式坑） |

### tasks（签到任务）
| 字段 | 说明 |
|---|---|
| id | 自增主键 |
| name | 任务显示名 |
| bot_username | 目标机器人用户名（如 `@some_bot`，4-32 位字母数字下划线）；**`me` = 发给自己的"已保存消息"**（测试/告警用） |
| command | 要发送的指令，如 `/checkin` |
| schedule_type | `daily` \| `interval` |
| schedule_value | daily：`"08:00"` 或 `"08:00,20:00"`（HH:MM，24 小时制）；interval：`"1"`..`"1440"` 分钟数字符串 |
| timezone | IANA 时区，默认 `Asia/Shanghai`（写入时校验有效性） |
| jitter_minutes | 执行时随机延后 0..N 分钟（更像真人），0..1439 |
| capture_reply | 0/1，是否等待并记录机器人回复 |
| reply_wait_sec | 等回复秒数，1..120，默认 10 |
| enabled | 0/1 |
| **next_run_at** | **下次执行 UTC，ISO 字符串（`...T...Z`）。执行期间为「抢占租约值」（now+1h），正常态一定是未来时刻；不应长期为 NULL** |
| last_run_at | 上次执行时间（`datetime('now')` 空格格式） |
| last_status | `success` \| `failed` \| `skipped` |
| last_error | 失败原因 |
| fail_streak | 连续失败计数（0002 新增）；成功清零，用于每 3 次连续失败发一次告警 |
| created_at / updated_at | 时间戳 |

索引：`idx_tasks_due(enabled, next_run_at)`。

### run_logs（执行日志）
| 字段 | 说明 |
|---|---|
| id | 自增 |
| task_id | 外键 → tasks(id)，`ON DELETE CASCADE` |
| status | `success` \| `failed` \| `skipped` |
| detail | 机器人回复摘要 / 错误信息 / `"missed,rescheduled"` |
| duration_ms | 耗时毫秒 |
| created_at | UTC，空格格式 |

索引：`idx_logs_task(task_id, id DESC)`。

### login_attempts（登录限流，0002 新增）
| 字段 | 说明 |
|---|---|
| ip (PK) | 客户端 IP（CF-Connecting-IP，本地回退 `local`） |
| fail_count | 当前窗口内失败次数 |
| window_start | 窗口起点（Unix 秒）。60 秒窗口、5 次失败锁定；跨窗口自动重置 |

---

## 5. API 接口清单（Hono，前缀 `/api`）

除 `/api/health`、`/api/login`、`/api/logout` 外，**全部需要 HMAC Cookie 鉴权**（未带/过期/伪造/已吊销 → 401）。

| 方法 | 路径 | 请求体 / 参数 | 成功响应 | 错误 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok:true}` | — |
| POST | `/api/login` | `{password}` | `{ok:true}` + `Set-Cookie: auth=<expiry>.<epoch>.<hmac>`（7 天，HttpOnly, SameSite=Lax, https 时加 Secure） | 401 `{error:"invalid_password"}`；429 `{error:"too_many_attempts"}`（同 IP 60 秒错 5 次）；400 `invalid_json` |
| POST | `/api/logout` | — | `{ok:true}` + 清 cookie（同时 bump auth_epoch，**全局吊销**所有已签发 Cookie） | — |
| GET | `/api/overview` | query: `from`/`to`（ISO 带 Z，可选） | `{today:{success,failed,skipped}, upcoming:[...], sessionConfigured}`（upcoming = next_run_at 在「现在+24h」以内的已启用任务，最多 5 条；today 默认按 UTC 日界，传 from/to 则按传入区间，前端传本地日界） | 401；400 `invalid_from`/`invalid_to` |
| GET | `/api/tasks` | — | `{tasks:[...]}` | 401 |
| POST | `/api/tasks` | 见下"任务字段" | 201 `{task}` | 400 校验失败（含 `invalid_json`） |
| GET | `/api/tasks/:id` | — | `{task}` | 404 |
| PATCH | `/api/tasks/:id` | 任意任务字段子集 | `{task}` | 404 / 400 |
| DELETE | `/api/tasks/:id` | — | `{ok:true}` | — |
| POST | `/api/tasks/:id/run` | — | `{ok:true, status, detail}`（**立即执行**；带租约抢占，cron 正在跑时返回 409 `already_running`；未到点不改变排期，已到点消耗该 slot） | 404 / 409 |
| GET | `/api/logs` | query: `task_id`、`limit`(收敛到 1..100，默认50)、`before_id` | `{logs:[...]}` | 401；400 `invalid_task_id`/`invalid_before_id` |
| GET | `/api/session` | — | 未配置：`{configured:false}`；已配置：`{configured:true, account:{name,username,phone}}`；失效：`{configured:true, account:null, error}` | 401 |
| PUT | `/api/session` | `{session}` | `{ok:true, account:{...}}`（**先 connect+getMe 验证再入库**） | 400 无效 session |
| DELETE | `/api/session` | — | `{ok:true}` | 401 |

**安全机制（2026-10-24 加固）**：
- 密码比对：SHA-256 双摘要 + 恒定时间比较（无计时侧信道）。
- 登录限流：同 IP 60 秒 5 次失败 → 429（D1 `login_attempts` 表）。
- CSRF：所有跨站 Origin 的 POST/PUT/PATCH/DELETE → 403 `origin_mismatch`（SameSite=Lax 之外的纵深）。
- CSP：静态响应统一带 `Content-Security-Policy`（script-src 'self'；前端已无内联脚本/事件处理器）。

**任务字段（POST/PATCH body）**：`name, bot_username, command, schedule_type, schedule_value, timezone, jitter_minutes, capture_reply, reply_wait_sec, enabled`。

**服务端校验规则**（`src/validation.ts`，POST/PATCH 共用，严格类型不做隐式转换）：
- 必填：name / bot_username / command / schedule_type / schedule_value（PATCH 只校验出现的字段）。
- bot_username：`me` 或 `@?` + 4-32 位字母数字下划线。
- schedule_type ∈ {daily, interval}；daily 每时间点匹配 `HH:MM`（00:00-23:59，可逗号多个）；interval 为 1..1440 的整数字符串。
- timezone 必须是合法 IANA 名；jitter_minutes 0..1439 整数；reply_wait_sec 1..120 整数；capture_reply/enabled 接受 0/1/true/false。
- **合并存量后校验排期组合**：daily 必须配 HH:MM、interval 必须配分钟数，非法组合直接 400（杜绝把任务写成 `next_run_at=NULL` 静默停跑）。
- 新建、PATCH 改排期字段、或重新启用一个 `next_run_at` 为空的任务时，服务端立即重算 `next_run_at`；算不出 → 400。

---

## 6. 核心机制：调度与执行（`src/cron/`）

### 6.1 cron 入口
- `wrangler.toml` 注册**单个** `crons=["* * * * *"]`；`[observability] enabled = true`（面板 Logs 可查）。
- `src/index.ts` 的 `scheduled(event, env, ctx)` 用 `ctx.waitUntil(runDueTasks(env))`，catch 里打 **stack**。

### 6.2 `runDueTasks(env)`（runner.ts）
1. 用 **JS 生成当前 ISO 时间**绑定，查 due：
   `SELECT * FROM tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 10`。
2. 串行 `executeWithClaim(env, task)`（**必须串行**，避免并发触发 Telegram 风控）；单个任务编排异常被 catch 记录，**不阻断整轮**。
3. 1% 概率清理 30 天前日志 + 1 小时前的 login_attempts 记录。

### 6.3 `executeWithClaim(env, task, opts)` —— 租约抢占 + finally 重排（2026-10-24 重写）

**核心不变量：抢占成功后，任何路径下 `next_run_at` 都会被写回合法未来值，任务永远不会"永远失选"。**

**cron 触发（opts.manual 缺省）**：
1. **迟到判定**：`now - next_run_at` 超过 **30 分钟** → 不执行，重排到未来 + 写一条 `skipped / "missed,rescheduled"` 日志（一次 batch）。
2. **租约式乐观锁抢占**：`UPDATE tasks SET next_run_at=<now+1h> WHERE id=? AND next_run_at=<原值>`；`changes=0` 说明已被抢走 → 返回 `skipped / already_claimed`。
   - 租约值（1 小时后的未来时刻）而非 NULL：即使执行中 isolate 被 kill / D1 瞬时故障导致重排失败，租约到期后任务会被重新选中，**自愈**，不会静默停跑。
3. 执行发送（见下）。
4. `finally` 里重排：`computeNextRun(from=现在)` 写回；算不出（排期非法，理论上已被写入校验拦截）兜底 +1h；写入失败重试一次，仍失败只打日志（靠租约自愈）。

**手动触发（opts.manual=true，来自 POST /api/tasks/:id/run）**：
- **同样抢占**（409 `already_running`），避免与同一分钟的 cron 重复发送；
- 原排期**未到点**：执行后**原样恢复** next_run_at（不影响排期）；
- 原排期**已到点**：执行后**消耗该 slot**（从原时间点起算下一个）；
- next_run_at 原本为 NULL（历史遗留）：执行后顺带修复为重排。

**`executeOneTask(env, task)`（执行核心，两种触发行为一致）**：
- 25 秒超时包装（Promise.race），`clearTimeout` 在 finally 中执行（不会漏 unhandled rejection）；任何异常都捕获记 failed，绝不让一个任务炸掉整轮。
- 写 run_logs + 更新 last_run_at/last_status/last_error/**fail_streak** 合并为**一次 batch**（减少 D1 往返与写放大）。
- **失败告警**：连续失败达 3 次后每 3 次向 `me`（已保存消息）发一条告警；告警自身失败只记日志，**不递归**。

**发送逻辑（withClient 回调内）**：
- target：`me` → `"me"`，否则用 bot_username。
- `client.sendMessage(target, {message: command})`，记下返回的消息 id。
- capture_reply=1：等待 reply_wait_sec 秒，`client.getMessages(target, {limit:10})`，取**第一条 `!m.out` 且 id > 本次发送 id** 的消息文本（避免把历史旧消息当成本次回复），截断 500 字符存 detail。

### 6.4 时区换算（schedule.ts，严格对应 PLAN 附录 A）
- `localWallToUtc(dateStr, hm, tz)`：
  1. `guess = Date.parse(dateStr + "T" + hm + ":00Z")`（先假设零偏移）。
  2. 用 `Intl.DateTimeFormat(...,{timeZone:tz}).formatToParts(guess)` 反推出该时刻"若按本地墙钟"的时间，算出 UTC 偏移 `offset1`，得 `utc1 = guess - offset1`。
  3. **第二轮**用 utc1 重算偏移（处理 DST 边界），得最终 UTC。
- `computeNextRun({scheduleType, scheduleValue, timezone, jitterMinutes}, fromDate)`：
  - daily：解析时间点并排序，从 from 起逐天（最多 400 天）找该时区下**第一个 > from** 的时刻。
  - interval：`from + N 分钟`。
  - 最后叠加 0..jitterMinutes 分钟随机抖动。
  - **任何非法输入返回 null，不抛异常**。

---

## 7. Session 生命周期

1. **本地登录**：`scripts/login.mjs`（Node，非 Worker）。
   - 当前为**非交互、Agent 可驱动模式**：
     - 手机号：环境变量 `TG_PHONE`；二步密码：`TG_2FA`。
     - 验证码：脚本轮询文件（默认 `.tg_code.txt`），把验证码写进去即继续。
     - 代理：默认 SOCKS5 `127.0.0.1:7897`，可用 `TG_PROXY_HOST/TG_PROXY_PORT` 覆盖。
   - 成功后打印 `SESSION=...`。
   - 运行方式：`$env:TG_PHONE="+1..."; $env:TG_2FA="..."; node --env-file=.dev.vars scripts/login.mjs`。
2. **保存到线上**：登录 Web 界面 → 设置页粘贴 → PUT /api/session（Worker 先用 `withSession` 验证再入库，20s 超时）；或用 curl 调同一接口。
3. **使用**：Worker 每次执行从 settings 读 session，`withClient()` → `withSession()` 建 client，**只 connect**。
4. **失效/清除**：设置页「清除 Session」→ DELETE /api/session；之后任务会 failed（`tg_session not configured`）。

> StringSession = 账号完全控制权。**任何 API 不返回字符串本身、不打日志、不进已提交文件。**

---

## 8. 前端 SPA（`public/`，零构建原生 JS）

- **hash 路由**：`#/login`、`#/`（仪表盘）、`#/tasks`、`#/logs`、`#/settings`。
- **统一 `api()` 封装**：401 且当前不在登录页时才跳 `#/login`（避免重复设同 hash 不触发 hashchange）。
- **渲染代次令牌 `currentRenderSeq`**：每次 navigate 递增；四个异步渲染函数 await 后校验代次，过期结果一律丢弃——防止旧页面的慢请求回调覆盖新页面（曾导致未登录时错误卡片卡死）。
- **`parseDate()`（重要）**：D1 `datetime('now')` 输出 `'YYYY-MM-DD HH:MM:SS'`（UTC、空格、无 Z），浏览器会把空格格式当**本地时区**解析，导致时间偏 8 小时。parseDate 统一把无 Z 的空格串转成 `T...Z` 再解析；`fmtTime/relTime` 都走它。
- 任务表单是模态框（showTaskModal），字段与 API 一致。

---

## 9. 本地开发与调试（GFW 环境）

本机网络特点：**直连 Telegram DC 被墙**，访问 workers.dev / GitHub 也需要代理。代理为 **Clash Verge（verge-mihomo）**：
- 混合端口（HTTP+SOCKS5）：**127.0.0.1:7897**。
- 外部控制器在 Windows 上是**命名管道**（`\\.\pipe\verge-mihomo-...`），没有 TCP 9097，clash-verge 脚本连不上属正常。

```bash
# 默认不走代理；本机在 Clash 后面时取消 .npmrc 里 proxy 两行注释，或：
_run.bat npm install
npm run db:migrate:local         # 建本地 D1（0001 + 0002）
npm run dev                      # http://127.0.0.1:8787
# 本地手动触发 cron（wrangler 4.141 实测路径）：
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
npm run typecheck
npm test
```

> 旧文档里的 `/__scheduled?cron=...` 是旧版 wrangler 写法，已失效，不要用。

**浏览器自动化调试（browser-skill / bsk）**：
- 守护进程在会话间可能退出：`bsk daemon start --foreground`（后台任务保活），再 `bsk session start`。
- **已知坑**：bsk 的 `fill` / 元素 `click` 在本站点经常不生效，兜底用 `bsk evaluate` 直接赋 `value` + `dispatchEvent('input')`、用 JS `.click()`。
- 静态资源更新后浏览器可能缓存，用 `bsk reload --hard` 绕过缓存。

---

## 10. 部署流程（Cloudflare Workers）

```bash
npx wrangler login                                   # 浏览器 OAuth
npx wrangler d1 create tg-checkin-db                 # database_id 填回 wrangler.toml
npx wrangler d1 migrations apply tg-checkin-db --remote   # 必须先迁移（含 0002），再 deploy
npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

`wrangler.toml` 关键点：
- `compatibility_flags=["nodejs_compat"]`（GramJS 需要 Buffer / node:net）。
- `[assets]` 用 **`run_worker_first=["/"]`**：所有请求先进 Worker，`/api/*` 由 Hono 处理，其余走 catch-all 回退 ASSETS（这样静态响应才能统一附加 CSP 头）。
- `src/index.ts` 末尾 catch-all `app.get("*", c => c.env.ASSETS.fetch(c.req.raw))` 必须放在所有 /api 路由之后。

线上 cron **不能**手动触发，要等真实整分钟（可能有几十秒抖动）。

---

## 11. 密钥与敏感信息位置（不在代码仓库中）

| 敏感项 | 位置 |
|---|---|
| TG_API_ID / TG_API_HASH / 本地 ADMIN_PASSWORD | 本地 `.dev.vars`（gitignored） |
| 线上同名三项 | Cloudflare Worker Secrets（`wrangler secret list` 可看名称） |
| StringSession | 远程/本地 D1 的 `settings` 表 key=`tg_session` |

> 本项目使用的 Telegram 凭据为 **Telegram Desktop 官方开源客户端内置的公开 api_id/api_hash**（用户无法在 my.telegram.org 申请到 app 时的替代路线，登录设备显示为 Telegram Desktop）。需要真实值时从用户 `.dev.vars` 读取，**不要写进文档或提交**。

---

## 12. 标准改动工作流（每次改代码都照做）

1. 改代码（严格限定在用户要求范围，**不擅自加功能/依赖**）。
2. `npm run typecheck`（必须无错误）。
3. `npm test`（72 个用例全绿；改了 schedule/runner 逻辑要同步加/改用例）。
4. 本地 `npm run dev` 实测受影响路径（含 `curl /cdn-cgi/local/scheduled`）。
5. `npm run deploy`（先确认远程迁移已 apply）。
6. `bsk reload --hard` 浏览器复验，观察真实数据。
7. 汇报：做了什么、验证证据（真实输出）、与计划不一致之处。

---

## 13. 已知坑 / 血泪教训（避免重复踩）

1. **D1 时间格式混用是万坑之源**：
   - 代码写入的 `next_run_at` 是 **ISO（T、带 Z）**；`datetime('now')` 系列是 **空格、无 Z**。
   - 二者**不能直接做 SQL 字符串比较**（`'T'(0x54) > ' '(0x20)`，导致 ISO 行永不匹配）——凡比较时间，统一用 **JS 生成 ISO 再绑定**；overview 的 from/to 参数要在服务端 `isoToSqlite()` 转成空格格式再比。
   - 前端解析空格串会按本地时区 → 必须 `parseDate()` 补 Z。
2. **直连 Telegram DC 会 ETIMEDOUT** → 登录脚本走 SOCKS5；Worker 侧由 Cloudflare 网络出网，无需代理。
3. **`wrangler login` 在设置 HTTPS_PROXY 时回调 localhost 被代理拦截** → 加 `NO_PROXY=localhost,127.0.0.1`。
4. **bsk 守护进程会话间会退出**，需后台重启；fill/click 失效用 evaluate 兜底。
5. **裸 Node ESM 不支持 `import "telegram/sessions"` 目录导入** → 写完整路径 `telegram/sessions/index.js`（Worker 打包器不受影响）。
6. **抢占必须用租约值（now+1h）而不是 NULL**（2026-10-24 教训）：NULL 占位一旦在执行/重排之间遇异常就永久停跑且无告警；租约值最坏也能一小时后自愈。
7. **抓回复要同时过滤 `m.out` 和 `id <= 本次发送 id`**，否则机器人本次没回复时会抓到历史旧消息。
8. **vitest 默认 forks 进程池在部分 Windows 环境加载即崩**（Node 22/24 均复现，与项目代码无关）→ `vitest.config.ts` 已固定 `pool: "vmForks"`；换机器/CI 若遇 `npm test` 假失败，先试这个。
9. **沙箱/代理环境里 curl 打本地 dev 端口可能被环境代理拦截**（换端口如 8788 会被代理层吞掉）→ 用项目默认 8787，并加 `--noproxy '*'`。
10. **`run_worker_first=["/api/*"]` 时静态资源不经过 Worker**，响应头加不上 CSP → 已改为 `["/"]`，所有请求先进 Worker 再由 catch-all 回退 ASSETS。

---

## 14. 红线约束（违反即为错误）

1. 技术栈不可更改：Workers + Hono + GramJS(`telegram` ^2.26.x) + D1 + 原生 SPA + 单 cron。
   > 注：`telegram` 2.26.22 已被 npm 标记 archived（后继分支 `teleproto`）。当前版本功能稳定，**继续沿用**；若未来必须迁移，按独立项目评估，不顺手换。
2. Worker 内只 `connect()`，禁止 `start()`。
3. 密钥不硬编码、不打日志、不进提交；StringSession 不返回前端。
4. 不引入设计文档之外的库（**尤其不引 cron 解析/时区库**）。
5. 不擅自增删功能；以"能跑、简单"为先，不过度设计。
6. GramJS API 签名不确定时读 `node_modules/telegram` 的 `.d.ts`，禁止凭记忆编造。
7. 全程中文回复；测试消息默认只发 `me`，不要碰用户真实大号。
8. **抢占必须用租约值（now+1h）不用 NULL**；**先 apply 远程迁移再 deploy**。

---

## 15. 待办与可选迭代（M7，做前先与用户确认）

按 PLAN/AGENT_TASK 中优先级：
1. ~~**失败告警**~~：✅ 2026-10-24 已完成（连续失败 3 次起，每 3 次向 `me` 发一条；告警失败不递归）。
2. **inline keyboard 支持**：capture_reply 场景下可配置"点击机器人回复中的第 N 个按钮"（先读 GramJS `.d.ts` 确认按钮点击 API）。
3. **多账号支持**：settings 改 accounts 表，tasks 加 account_id 外键。
4. **Cloudflare Access**：用 Zero Trust Access 替换/叠加密码登录（PLAN.md:144 已列为可选加固）。
5. 运维观察：真实 cron 24h 运行留档、Cloudflare 面板确认无 `exceededCpu`。
6. **D1 定期备份**：`npm run db:export` 已就绪，建议接一个定时提醒/自动化。
7. **迁移到 teleproto**：仅当 `telegram` 出现安全问题或必须缺失特性时启动（见 §14 注）。

---

## 16. 参考资料

- GramJS 文档（含 Workers 章节）：https://gram.js.org ；https://github.com/gram-js/gramjs
- Workers 限额：https://developers.cloudflare.com/workers/platform/limits
- Cron Triggers：https://developers.cloudflare.com/workers/configuration/cron-triggers
- D1 限额：https://developers.cloudflare.com/d1/platform/pricing
- Hono：https://hono.dev
- Telegram Desktop 内置凭据来源：https://github.com/telegramdesktop/tdesktop （`config.h`）

---

## 17. 2026-10-24 加固迭代变更记录

> 背景：全量代码评审（报告 `docs/architecture-analysis-2026-10-24.md`）后按 P0/P1/P2 落地。**最小变更、YAGNI**，未改技术栈、未换框架、未动数据模型语义。

**P0 稳定性/安全**
1. `runner.ts` 重写执行编排：乐观锁占位从"置 NULL"改为"租约值（now+1h）"+ `finally` 重排 → 任务任何异常下都不会静默永久停跑（原缺陷：占位后任意环节出错即永远失选）。
2. 登录加固：密码比对改 SHA-256 双摘要 + 恒定时间比较；新增 `login_attempts` 限流表（同 IP 60 秒 5 次失败 → 429）。
3. Cookie 增加条件 `Secure`（https 才加）；格式升级为 `expiry.epoch.sig`，退出登录 bump `auth_epoch` 实现全局吊销。
4. 25 秒超时定时器 `clearTimeout`（消除正常路径的 unhandled rejection）。

**P1 工程化/校验**
5. `migrations/0002_hardening.sql`：`login_attempts` 表 + `tasks.fail_streak` 列。
6. `src/validation.ts`：任务 body 严格类型校验（杜绝 `"abc"`→NaN、daily+分钟数等非法组合）；POST/PATCH 共用。
7. `logs.ts`：limit 强制收敛 1..100（挡掉 `limit=-1` 拉全表）；task_id/before_id 校验。
8. `session.ts`：合并重复的 `withClientForSession` 到 `client.ts` 的 `withSession()`；验证加 20s 超时。
9. `.npmrc` 代理改注释（换机/CI 可装依赖）；`_run.bat` 路径改相对自身目录；`vitest.config.ts` 固定 `pool: "vmForks"`（默认 forks 在本机加载即崩）；新增 `.github/workflows/ci.yml`；`package.json` 移除残留 pnpm、加 `db:export`/`verify`；新增 MIT `LICENSE`。
10. 文档同步：README 登录章节改非交互用法、cron 触发路径统一为 `/cdn-cgi/local/scheduled`；PLAN/AGENT_TASK 的 pnpm 表述改 npm。

**P2 增强**
11. 失败告警（M7-1）：连续失败 3 次起每 3 次向 `me` 发一条，告警失败只记日志不递归。
12. capture_reply 增加"id > 本次发送 id"过滤，不再误抓历史旧消息。
13. 单测从 10 个扩到 **72 个**（runner 14 / auth 13 / validation 18 / api 17 + schedule 10），含 T1 回归、租约自愈、限流、CSRF、CSP、超时等用例；新增内存 fake D1。
14. `wrangler.toml` 开 `[observability]`；`run_worker_first` 改 `["/"]` 使静态响应可带 CSP；前端内联事件处理器改事件委托（为 CSP 铺路）；overview 支持 from/to 本地日界统计。
15. D1 写合并：run_logs + 任务状态改一次 `batch`；runner 内顺手清理过期 login_attempts。

**验证证据**：`tsc --noEmit` 0 错误；`vitest run` 72/72；`wrangler d1 migrations apply --local` 两个迁移均成功（表/列已核实）；`wrangler dev` 冒烟：health 200、登录 401/限流路径正常、静态资源 200 且带 CSP、`/cdn-cgi/local/scheduled` 200。

**遗留/待用户侧**：远程库需先 apply 0002 再部署新版；`compatibility_date` 未上调（需完整回归后单独处理）；Cloudflare Access 叠加方案未实施（基础设施决策）。
