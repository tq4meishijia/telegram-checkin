# AGENT_HANDOFF · 接手开发文档（面向 AI Agent）

> 项目：**Telegram 自动签到工具（telegram-checkin）**
> 用途：以**用户态账号（userbot）**定时向指定 Telegram 机器人发送指令（如 `/checkin`），自带 Web 管理界面。
> 本文档是给**下一位接手开发的 Agent** 的完整交接材料，读完即可独立改代码、调试、部署。
> 配套阅读：`PLAN.md`（原始设计方案，权威设计来源）、`AGENT_TASK.md`（里程碑任务书）、`README.md`（面向人类用户的简版说明）。

---

## 0. 一分钟现状（2026-10-24 多账户迭代后）

- **进度**：M0–M6 全部完成并上线；2026-10-24 先后完成「安全/稳定性加固」「全量代码通读」「多账户 + 密码修改 + 前端重构」三轮迭代（变更清单见 §17 / §19），M7 剩余项未开始。
- **线上地址**：https://telegram-checkin.tq4meishijia.workers.dev （2026-10-24 重命名后的新地址；旧地址 tg-checkin.… 随 Worker 名变更已失效）
- **⚠️ 部署状态**：✅ **已上线（2026-10-24 15:55）**——版本 `fa921228-2099-4589-b44b-d3c6e7530a0e`，先 apply 0003 迁移再 deploy（严守红线 #8）。详见 §19.8。
  - **0003 迁移对存量库的影响**：自动把 `settings.tg_session` 迁成 1 号「默认账户」（`is_default=1`、`status='ok'`），存量任务 `account_id` 回填为 1，并删除 settings 旧键。**实测本次线上库迁移前 settings/tasks 均为空**，故只建出 1 号空 session 占位账户（`status='unknown'`）。
  - **登录口令**：线上 `ADMIN_PASSWORD` secret 已设置（`wrangler secret list` 确认三个 secret 齐全），因此登录口令是**该 secret 的强随机值**，不是 `admin`；`admin` 仅在该 secret 未设置时生效。改过密码后以 `settings.admin_pw_hash` 为唯一准绳。
  - **线上待办**：Telegram session 未配置（1 号账户 `session` 为空、`status='unknown'`）——需跑 `scripts/login.mjs` 拿 StringSession，在「账户」页添加。
- **线上现有数据**：1 个任务「每日签到」（目标 `me`、指令 `/checkin`、daily 08:00 Asia/Shanghai）；有成功/失败日志若干。
- **代码健康度**：`npx tsc --noEmit` 无错误；vitest **139/139** 通过（8 个测试文件）；包体 gzip 约 333 KiB（远低于 3MB 上限）。
- **QA 验证（2026-10-24）**：加固轮全量测试 **IS_PASS: YES**（单测 72/72、冒烟 7/7、对抗探测 8/8），报告 `docs/qa-report-2026-10-24.md`；多账户轮验证见 §19.4。
- **代码仓库**：https://github.com/tq4meishijia/telegram-checkin （**公开**仓库，MIT LICENSE；2026-10-24 由 `cf-tg-checkin` 重命名而来，旧地址自动重定向）。
- **CI**：`.github/workflows/ci.yml`，push/PR 自动跑 `npm ci` + typecheck + test。
- **wrangler 登录态（2026-10-24）**：已 OAuth 登录（`tq4meishijia@gmail.com`，账号 `3312884334@qq.com's Account`），**写权限 scopes 已补齐**（workers/workers_scripts/d1 等 write，当日二次授权确认）——远程迁移与部署已无权限障碍，只差用户下令执行。

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
telegram-checkin/
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
├── docs/                    # 过程文档（命名 kebab-case-YYYY-MM-DD.md，随提交进仓库）
│   ├── architecture-analysis-2026-10-24.md   # 全量代码评审报告（加固依据）
│   ├── qa-report-2026-10-24.md               # 加固后全量测试报告（IS_PASS: YES）
│   └── project-overview-2026-10-24.md        # 接手通读报告（结构/流程/问题清单/维护手册）
├── _run.bat                 # Windows 下带代理环境执行任意命令的辅助脚本（路径相对自身目录）
├── migrations/
│   ├── 0001_init.sql        # 三张表 DDL（settings/tasks/run_logs）
│   ├── 0002_hardening.sql   # login_attempts 表 + tasks.fail_streak 列
│   └── 0003_accounts.sql    # accounts 表 + tasks.account_id；存量 tg_session 迁入 1 号账户
├── scripts/
│   └── login.mjs            # 本地登录脚本（非交互、SOCKS5 代理模式，见 §7）
├── src/
│   ├── index.ts             # Hono app 装配：login/logout/health、中间件、路由、静态回退（带 CSP）、scheduled 入口
│   ├── bindings.ts          # Env 类型（DB/ASSETS/3 个密钥字符串）
│   ├── auth.ts              # HMAC Cookie 鉴权中间件（恒定时间比较 + epoch 吊销 + Origin 校验 + 独立签名密钥）
│   ├── password.ts          # 管理密码：PBKDF2 哈希/校验/强度 + verifyAdminPassword 三级回退
│   ├── ratelimit.ts         # 登录失败限流（D1 login_attempts 表，60s/5 次）
│   ├── validation.ts        # 任务与账户输入校验（严格类型 + 排期组合）
│   ├── util.ts              # safeJson / withTimeout / toHex / fromHex / timingSafeEqualHex
│   ├── db.ts                # settings 表读写封装（含 setSettingIfAbsent）
│   ├── tg/
│   │   └── client.ts        # withSession()/withClient()/withAccountSession()：建 client→connect→fn→disconnect
│   ├── cron/
│   │   ├── schedule.ts      # computeNextRun() + localWallToUtc()（时区换算核心）
│   │   └── runner.ts        # runDueTasks() + executeWithClaim() + executeOneTask()（租约抢占 + finally 重排 + 失败告警 + 账户状态跃迁）
│   └── api/
│       ├── accounts.ts      # 账户 CRUD + verify + switch（多账户核心；响应绝不返回 session）
│       ├── password.ts      # POST /api/password 修改管理密码
│       ├── overview.ts      # GET /api/overview（仪表盘聚合，支持 from/to 本地日界）
│       ├── tasks.ts         # 任务 CRUD + /run（带抢占防并发；account_id 归属）
│       └── logs.ts          # 日志查询（limit 强制收敛 1..100）
├── public/                  # 原生 SPA（零构建，Bento Grid 风格，响应式三档断点 + 暗色模式）
│   ├── index.html           # 含 #app-root 容器，引 style.css 和 app.js
│   ├── app.js               # hash 路由 SPA 全部逻辑（事件委托，无内联处理器）
│   └── style.css            # Bento 设计系统（CSS 变量 + 三档断点 + reduced-motion）
└── tests/
    ├── schedule.test.ts     # schedule.ts 的 10 个单测
    ├── runner.test.ts       # runner 21 个单测（T1 回归/租约自愈/告警/回复过滤/超时/账户隔离/状态跃迁）
    ├── auth.test.ts         # 鉴权与限流 13 个单测
    ├── validation.test.ts   # 输入校验 18 个单测
    ├── password.test.ts     # 密码哈希/强度/三级回退 12 个单测
    ├── accounts.test.ts     # 账户 API 18 个单测（查重/级联/切换/接管默认位）
    ├── api.test.ts          # 端到端 26 个单测（fake D1）
    ├── frontend.test.ts     # 前端契约测试（CSP/Bento 规则/响应式/功能完整性）
    └── helpers/fake-db.ts   # 内存版 fake D1（按 SQL 特征路由，支持 accounts 与列投影）
```

---

## 4. 数据模型

五张表，DDL 以 `migrations/` 为准（0001 初始化，0002 加固，0003 多账户）。

### settings（键值配置）
| 字段 | 说明 |
|---|---|
| key (PK) | `tg_session`（0003 起已废弃，数据迁到 accounts）、`auth_epoch`（登录态纪元）、`auth_signing_key`（Cookie 签名密钥，一次性随机生成，与口令解耦）、`admin_pw_hash`（PBKDF2 口令哈希） |
| value | 配置值 |
| updated_at | `datetime('now')`，**UTC、空格格式、无 Z**（见 §8 时间格式坑） |

### accounts（Telegram 账户，0003 新增）
| 字段 | 说明 |
|---|---|
| id | 自增主键 |
| name | 账户显示名（1..100） |
| session | StringSession（**唯一真源**；任何 API 不返回） |
| api_id / api_hash | 可选的应用级凭据，为空时回退 Worker Secrets 的全局值 |
| tg_user_id / tg_username | 验证时从 `getMe()` 取得；`tg_user_id` 上有唯一索引 → **重复登录同一账号会被 409 拦截** |
| status | `ok` \| `invalid` \| `unknown`；runner 检测到会话类错误会自动标 `invalid`，成功后回 `ok` |
| last_error / last_verified_at | 最近一次验证的错误与时间 |
| enabled | 0/1；停用后其名下任务一并失选（runner JOIN 条件） |
| is_default | 默认账户（新建任务的默认归属）；有唯一部分索引保证**全局唯一** |

索引：`idx_accounts_user(tg_user_id) WHERE tg_user_id IS NOT NULL`、`idx_accounts_default(is_default) WHERE is_default = 1`。

### tasks（签到任务）
| 字段 | 说明 |
|---|---|
| id | 自增主键 |
| name | 任务显示名 |
| bot_username | 目标机器人用户名（如 `@some_bot`，4-32 位字母数字下划线）；**`me` = 发给自己的"已保存消息"**（测试/告警用） |
| command | 要发送的指令，如 `/checkin` |
| **account_id** | **归属账户（0003 新增，默认 1）**。未建外键——SQLite 禁止 `ADD COLUMN` 带 `REFERENCES`（外键开启时要求默认 NULL），级联删除由应用层 batch 完成 |
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

索引：`idx_tasks_due(enabled, next_run_at)`、`idx_tasks_account(account_id, enabled, next_run_at)`。

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

除 `/api/health`、`/api/login` 外，**全部需要 HMAC Cookie 鉴权**（未带/过期/伪造/已吊销 → 401）。
**`/api/logout` 也需要鉴权**——它注册在鉴权中间件之后，匿名调用返回 401（修复前匿名请求可全局吊销会话，见 §19.2 P0-1）。

| 方法 | 路径 | 请求体 / 参数 | 成功响应 | 错误 |
|---|---|---|---|---|
| GET | `/api/health` | — | `{ok:true}` | — |
| POST | `/api/login` | `{password}` | `{ok:true}` + `Set-Cookie: auth=<expiry>.<epoch>.<hmac>`（7 天，HttpOnly, SameSite=Lax, https 时加 Secure） | 401 `{error:"invalid_password"}`；429 `{error:"too_many_attempts"}`（同 IP 60 秒错 5 次）；400 `invalid_json` |
| POST | `/api/logout` | — | `{ok:true}` + 清 cookie（同时 bump auth_epoch，**全局吊销**所有已签发 Cookie） | **401**（未带 Cookie） |
| GET | `/api/overview` | query: `from`/`to`（ISO 带 Z，可选） | `{today:{success,failed,skipped}, upcoming:[...], sessionConfigured, defaultAccount, accountCount, taskCount}`（upcoming = next_run_at 落在「现在 ~ 现在+24h」的已启用任务，最多 5 条；today 默认按 UTC 日界，传 from/to 则按传入区间，前端传本地日界） | 401；400 `invalid_from`/`invalid_to` |
| GET | `/api/accounts` | — | `{accounts:[...]}`（**不含 session 字符串**） | 401 |
| POST | `/api/accounts` | `{name, session, api_id?, api_hash?}` | 201 `{account}`（**先 connect+getMe 验证再入库**；同一 tg_user_id 重复添加 → 409 `duplicate_account`；首个账户或当前默认账户无 session 时自动接管默认位） | 400 无效 session / 409 重复 |
| GET | `/api/accounts/:id` | — | `{account}`（不含 session） | 404 |
| PATCH | `/api/accounts/:id` | `{name?, session?, api_id?, api_hash?, enabled?}` | `{account}`（改 session 会重新验证 + 查重；停用默认账户 → 400 `cannot_disable_default`） | 404 / 400 / 409 |
| DELETE | `/api/accounts/:id` | — | `{ok:true}`（级联删任务与日志；删默认账户后剩余最小 id 接管；只剩一个账户 → 400 `last_account`） | 404 / 400 |
| POST | `/api/accounts/:id/verify` | — | `{ok:true, account}`（刷新 status / tg_user_id / last_verified_at） | 400 无效 session / 404 |
| POST | `/api/accounts/:id/switch` | — | `{ok:true, account}`（设为默认账户；停用中的账户 → 400 `account_disabled`） | 404 / 400 |
| POST | `/api/password` | `{old_password, new_password, confirm_password}` | `{ok:true, relogin:true}`（存 PBKDF2 哈希 + bump epoch **全局吊销会话**） | 401 `invalid_old_password` / 400 `password_mismatch`\|`password_too_short`\|`password_too_weak`\|`password_unchanged` |
| GET | `/api/tasks` | — | `{tasks:[...]}`（含 `account_id`） | 401 |
| POST | `/api/tasks` | 见下"任务字段" | 201 `{task}` | 400 校验失败（含 `invalid_json`、`no_account_configured`、`account_not_found`、`account_disabled`） |
| GET | `/api/tasks/:id` | — | `{task}` | 404 |
| PATCH | `/api/tasks/:id` | 任意任务字段子集（含 `account_id`） | `{task}` | 404 / 400 |
| DELETE | `/api/tasks/:id` | — | `{ok:true}` | **404**（不存在时） |
| POST | `/api/tasks/:id/run` | — | `{ok:true, status, detail}`（**立即执行**；带租约抢占，cron 正在跑时返回 409 `already_running`；未到点不改变排期，已到点消耗该 slot） | 404 / 409 |
| GET | `/api/logs` | query: `task_id`、`limit`(收敛到 1..100，默认50)、`before_id` | `{logs:[...]}` | 401；400 `invalid_task_id`/`invalid_before_id` |

> **`/api/session` 已移除**（0003 起）。session 的唯一真源是 `accounts` 表，再由 `/api/accounts` 管理；
> 保留两套会话 API 会造成双写源，是本项目已经踩过坑的一类问题（参见 §8 时间双轨制）。

**安全机制（2026-10-24 加固）**：
- 密码比对：SHA-256 双摘要 + 恒定时间比较（无计时侧信道）。
- 登录限流：同 IP 60 秒 5 次失败 → 429（D1 `login_attempts` 表）。
- CSRF：所有跨站 Origin 的 POST/PUT/PATCH/DELETE → 403 `origin_mismatch`（SameSite=Lax 之外的纵深）。
- CSP：**HTML 文档与静态资源（/app.js、/style.css）响应**均带 `Content-Security-Policy`（script-src 'self'；前端已无内联脚本/事件处理器）。实现方式：`run_worker_first=["/", "/app.js", "/style.css"]` 让这三类路径先进 Worker，由 catch-all 回退 ASSETS 时统一附加（dev 实测生效；线上前缀匹配行为未验证）。

**任务字段（POST/PATCH body）**：`name, bot_username, command, schedule_type, schedule_value, timezone, jitter_minutes, capture_reply, reply_wait_sec, enabled, account_id`。
（`account_id` 可省略：POST 省略时落到默认账户；PATCH 省略时不动。）

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
2. **保存到线上**：登录 Web 界面 → **账户页**「+ 添加账户」→ 粘贴 session → `POST /api/accounts`（Worker 先用该 session `connect` + `getMe` 验证，20s 超时；失败不入库）。或用 curl 调同一接口。
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
npx wrangler d1 create telegram-checkin-db                 # database_id 填回 wrangler.toml
npx wrangler d1 migrations apply telegram-checkin-db --remote   # 必须先迁移（含 0002），再 deploy
npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

`wrangler.toml` 关键点：
- `compatibility_flags=["nodejs_compat"]`（GramJS 需要 Buffer / node:net）。
- `[assets]` 用 **`run_worker_first=["/", "/app.js", "/style.css"]`**：页面与静态资源都先打到 Worker，`/api/*` 由 Hono 处理，其余走 catch-all 回退 ASSETS 并统一附加 CSP 头（dev 实测三类路径均带头）。
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

> **2026-10-24 起为项目统一标准（用户明确）**：Telegram 凭据固定使用 tdesktop 公开值——`api_id=17349`、`api_hash=344583e45741c457fe1862106095a5eb`（来源：`github.com/telegramdesktop/tdesktop` 源码 `config.h`，v4.15.0 tag 实测在位；dev 分支已改为需自建，但该公开值长期有效且为项目既有用法）。`.dev.vars.example` 已预填这两个值，无需申请。admin 密码不走文档：线上值由 `wrangler secret put` 管理，当前为 2026-10-24 生成的强随机值（已在对话中交给用户，丢失则重新 put 一个）。

---

## 12. 标准改动工作流（每次改代码都照做）

1. 改代码（严格限定在用户要求范围，**不擅自加功能/依赖**）。
2. `npm run typecheck`（必须无错误）。
3. `npm test`（72 个用例全绿；改了 schedule/runner 逻辑要同步加/改用例）。
4. 本地 `npm run dev` 实测受影响路径（含 `curl /cdn-cgi/local/scheduled`）。
5. `npm run deploy`（先确认远程迁移已 apply）。
6. `bsk reload --hard` 浏览器复验，观察真实数据。
7. **按 §14 红线 #9 同步更新 `AGENT_HANDOFF.md` + `README.md`**（任务完成且验证通过后、汇报前）。
8. 汇报：做了什么、验证证据（真实输出）、与计划不一致之处。

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
10. **`run_worker_first=["/api/*"]` 时页面不经过 Worker**，响应头加不上 CSP → 已改为 `["/", "/app.js", "/style.css"]`：三类路径都经 Worker，catch-all 回退 ASSETS 时统一带头（dev 实测 `/`、`/app.js`、`/style.css` 均带头，QA N1 已闭环）。

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
9. **文档同步纪律（2026-10-24 立规）**：每完成一项任务（功能/修复/配置变更/测试/文档整理）后，**立即**同步更新 `AGENT_HANDOFF.md` 与 `README.md`，两份文档内容必须一致、与现实一致。
   - **更新时机**：任务完成且验证通过后、向用户汇报前；docs/ 下的过程文档（评审/QA 报告）随当次提交进仓库。
   - **内容要求**：HANDOFF 记当前任务状态、已完成事项、未解决问题、下一步计划、关键决策、相关文件位置（§0 现状 + 受影响章节 + §17/§18 变更记录）；README 反映最新项目结构、功能说明、使用方式、配置要求、已知限制、变更记录。禁止描述未经实测验证的行为。
   - **维护责任**：当次任务的执行者（Agent 或人）负责更新；主理人/交付负责人在验收时核对两份文档已同步——**文档未同步视为任务未完成**。

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

**当前最高优先（用户侧操作，做前确认）**：
8. **上线（✅ 已完成，仅剩 session）**：旧资源已删、新库已建已迁移、secrets 已配、Worker 已部署并线上验证通过（见 §0）。⏳ **唯一剩余：用户跑 `scripts/login.mjs` 拿新 StringSession 并在设置页粘贴**（本地 `.dev.vars` 已预填 tdesktop 公开凭据，直接可用）：
   ```powershell
   $env:TG_PHONE="+8613xxxxxxxxx"      # 你的手机号
   $env:TG_2FA="你的二步验证密码"
   node --env-file=.dev.vars scripts/login.mjs
   # 收到短信验证码后，把验证码写进 .tg_code.txt，脚本自动继续，终端打印 SESSION=...
   ```
   > 本机直连 Telegram DC 被墙，脚本默认走 SOCKS5 `127.0.0.1:7897`（Clash）；如在代理环境运行用 `TG_PROXY_HOST/TG_PROXY_PORT` 覆盖。也可以把手机号+二步密码交给主理方代跑（验证码仍需用户写入文件）。
9. ~~**N2 flaky 处置**~~：✅ 2026-10-24 已根因修复——capture_reply 用例改 fake timers（消除唯一真实计时依赖），未加 `--retry`（保持 CI 严格）；连续 8 轮全量测试 8/8 全绿（修复前复现率约 12%）。
10. ~~**N1 收尾**~~：✅ 2026-10-24 已闭环——`run_worker_first` 扩为 `["/", "/app.js", "/style.css"]`，dev 实测三类路径均带 CSP 头（`/` HTML、`/app.js` JS、`/style.css` CSS，content-type 均正常）；其余端点回归无破（health/scheduled/404/401 正常）。
11. ~~**`.gitignore` 的 `.ddev/` 疑似笔误**~~：✅ 2026-10-24 已删除。研究结论：`.ddev/` 是 DDEV（Docker 版 PHP 本地开发工具的配置目录），本仓库 Node/Cloudflare 技术栈零依赖，属误入行。
12. **`compatibility_date` 上调**：需 wrangler dev 完整回归（登录/cron/GramJS 连接）后单独处理，不做常规维护动作。

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

---

## 18. 2026-10-24 测试验证与文档同步迭代

### 18.1 QA 全量验证（结论 IS_PASS: YES）

- **范围**：单测全量 + 类型检查 + fake D1 集成 + 原 10 例回归 + wrangler dev 冒烟（7 项）+ 对抗性探测（8 项）。
- **结果**：单测 72/72（8 次完整运行 7 次全绿，1 次偶发 1 例 flaky，记为 N2）；tsc 0 错误；api 集成 17/17；schedule 回归 10/10 全绿；冒烟 7/7（health 200 / 错密 401 / 同 IP 第 6 次错密 429 / `/` 带 CSP / app.js+style.css 200 / scheduled 触发后 health 200 / 无 Cookie 401）；对抗 8/8（T1 故障注入复测、租约自愈、限流按 IP 隔离、epoch 吊销、limit 四边界收敛、手动运行修 NULL、畸形 JSON 400 非 500、grep 证实无 session/密钥泄露路径）。
- **行为变更确认**：「手动运行」语义从"不占位不重排"改为"占位防并发 + 未到点恢复原排期 + 已到点消耗 slot + 修 NULL"，为加固有意为之，已用 3 个单测固化，不算回归失败。
- **完整报告**：`docs/qa-report-2026-10-24.md`（含失败排查方向、风险与遗留）。
- **测试无法证明的部分**：真实登录成功链路与真实 GramJS 会话仅 mock 单测覆盖；远程 0002 迁移未应用；线上 cron 与 run_worker_first 真实行为未经线上验证。

### 18.2 文档同步（按 §14 红线 #9 执行）

- HANDOFF/README 已同步至当前状态；QA 报告提交进仓库 `docs/`。
- CSP 描述按 dev 实测修正：HANDOFF §5/§10/§13、`wrangler.toml` 注释、README 架构段（原文案"静态响应统一带 CSP"不准确，实际仅 HTML 文档响应带头）。
- 提交记录见 `git log`（docs: 同步 HANDOFF/README + QA 报告入库）。

### 18.3 QA 遗留项闭环 + wrangler 登录（2026-10-24 下午）

- **N1 闭环**：`run_worker_first` 扩为 `["/", "/app.js", "/style.css"]`；dev 实测 `/`、`/app.js`、`/style.css` 均返回 CSP 头且 content-type 正常；回归 health 200 / scheduled 200 / 404 / 无 Cookie 401 无破。
- **N2 根因修复**：`tests/runner.test.ts` capture_reply 用例改 fake timers（`vi.advanceTimersByTimeAsync(1000)`），消除唯一真实计时依赖；**连续 8 轮 `npm test` 全绿**（修复前约 12% 偶发失败）。未采用 `--retry`，保持 CI 严格。顺带副作用：套件耗时 1.5s → 0.65s。
- **`.ddev/` 删除**：研究确认其为 DDEV（PHP Docker 工具）配置目录名，与本仓库技术栈无关，属误入 `.gitignore` 的笔误行，已删。
- **wrangler 登录（不上线）**：`npx wrangler login` 成功（NO_PROXY=localhost,127.0.0.1），`whoami` 确认 `tq4meishijia@gmail.com`；首次授权仅 read scopes，用户当日二次授权补齐写权限（workers/workers_scripts/d1 等 write，已核实）——部署无权限障碍。未执行任何 migrations apply --remote / deploy。

### 18.4 首次上线尝试与受阻记录（2026-10-24）

- **执行**：用户下令上线 → 先跑 `npm run db:migrate:remote`（严守先迁移后部署）。
- **结果**：失败，未部署。证据链：
  1. `d1 migrations apply --remote` → 错误 7404：`tg-checkin-db`（5965162f…）在当前账号不存在；
  2. `wrangler d1 list` → 当前账号仅有 `cf-tg-checkin-db`（ba149de2…，2026-09-28 创建，**0 张表**）；
  3. `wrangler deployments list --name tg-checkin` → 错误 10007：Worker 不存在于当前账号；
  4. `curl https://tg-checkin.tq4meishijia.workers.dev/api/health` → 错误 1042（线上无 Worker 服务）。
- **判断**：原"已上线"状态（§0 旧记载）与实测不符；原 Worker/D1/secrets/session 要么在**其他 Cloudflare 账号**，要么已丢失。**未做任何破坏性操作**（未 deploy、未建库、未改 wrangler.toml）。
- **待用户决策**：见 §15-8 的 (a)/(b) 两条路径。

### 18.5 清场重建（2026-10-24 下午，用户确认后执行）

- **删除（分批验证）**：Worker `cf-tg-checkin`（API DELETE +force，删后列表为 0）→ D1 `cf-tg-checkin-db`（ba149de2，0 表空库，API DELETE 成功，删后 d1 list 为 0）。Pages 项目 `hexo`、`cross-gfw` 与本项目无关，未动。
- **新建**：`wrangler d1 create telegram-checkin-db` → id `7cee8c54-49ec-4cce-b2ae-30b214b79016`（APAC），已填回 wrangler.toml。
- **迁移**：`db:migrate:remote` 两个迁移均 ✅；远程核实表清单 `_cf_KV,d1_migrations,sqlite_sequence,settings,tasks,run_logs,login_attempts`，`tasks.fail_streak` 存在。
- **未完成**：secrets 未设置、Worker 未部署（缺 TG_API_ID/TG_API_HASH/ADMIN_PASSWORD）；新 session 未获取。见 §15-8。
- **凭据备注**：Cloudflare API 调用用 wrangler 配置里的 OAuth token（`%APPDATA%\xdg.config\.wrangler\config\default.toml` 的 `oauth_token`），**不要**用 git 的 GitHub token（会 10000 认证错误）。

### 18.6 上线完成（2026-10-24 下午）

- **secrets**：TG_API_ID=17349、TG_API_HASH=344583e45741c457fe1862106095a5eb（tdesktop 公开值，用户确认为项目统一标准，已从官方源码核实）；ADMIN_PASSWORD=生成的强随机值（对话中交付用户，未入库）。
- **部署**：`npm run deploy` 成功——`telegram-checkin`（版本 8bac35ac…），cron 已注册，包体 gzip 336.40 KiB。
- **线上验证（全过）**：health 200；CSP（`/` 与 `/app.js`）；正确密码登录→签发 Cookie；带 Cookie overview/tasks 200（远程 D1 读写）；错密 5 次后第 6 次 429 retry_after=54（login_attempts 生效）。
- **本地**：`.dev.vars` 已按 tdesktop 凭据 + 线上同密码预填（gitignored），`scripts/login.mjs` 可直接跑。
- **剩余**：仅 Telegram session（用户侧，见 §15-8 的命令）。

---

## 19. 2026-10-24 多账户 + 密码修改 + 前端重构迭代

> 背景：用户要求三项改造——多 Telegram 账户管理、WebUI 密码修改、前端按 Bento Grid 样式参考重构。
> **约束**：不换技术栈、不引新依赖（密码学全部用 WebCrypto）、不引入构建步骤、保持 CSP `script-src 'self'`。
> 结果：`tsc` 0 错误，`vitest` **139/139**（8 个文件，原 72），本地迁移与 `wrangler dev` 端到端冒烟全过。

### 19.1 多账户（`migrations/0003_accounts.sql` + `src/api/accounts.ts`）

- **数据模型**：新增 `accounts` 表（session/api_id/api_hash/tg_user_id/status/enabled/is_default），`tasks` 加 `account_id`（默认 1）。
  - 未给 `account_id` 建外键：SQLite 在 `foreign_keys=ON` 时**禁止 `ADD COLUMN` 带 `REFERENCES`**（要求默认 NULL），因此级联删除由应用层 batch 完成（`DELETE run_logs → DELETE tasks → DELETE accounts`）。
  - `tg_user_id` 唯一索引 → **重复登录同一 Telegram 账号返回 409 `duplicate_account`**。
  - `is_default` 唯一部分索引（`WHERE is_default = 1`）→ 默认账户全局唯一，切换/接管都在同一 batch 内先清后设。
- **存量迁移**：`settings.tg_session` 自动迁成 1 号「默认账户」（`status='ok'`、`is_default=1`），存量任务 `account_id` 回填 1，删除 settings 旧键。**已实测两条路径**（干净库 / 带存量 session 与任务的库）。
- **runner**：`SELECT t.*, a.session AS account_session ... FROM tasks t JOIN accounts a ON a.id = t.account_id`，一次查回凭据（无 N+1）；`a.enabled=1` 进入查询条件 → **账户停用后其任务一并失选**。执行、告警都用**本任务所属账户**的 session。
- **登录失效处理**：runner 捕获到匹配 `/AUTH_KEY|SESSION_|REVOKED|UNREGISTERED|not configured|credentials|.../i` 的错误时，把账户 `status` 置为 `invalid` 并记 `last_error`；成功后回 `ok`。仅在状态**跃迁**时写库，避免每轮执行的写放大。
- **重启恢复**：账户、任务、`next_run_at`、默认账户全部落 D1，无内存态，天然恢复。
- **账户切换**：`POST /api/accounts/:id/switch`；删除默认账户后剩余最小 id 自动接管。
- **并发/冲突**：任务级互斥仍由原有的租约式乐观锁承担（账户维度不引入额外锁）；多账户任务是**串行**执行的（单轮最多 10 条），这是为避免并发连接触发 Telegram 风控。

### 19.2 密码修改（`src/password.ts` + `src/api/password.ts`）

- **存储**：`pbkdf2$<iterations>$<saltHex>$<hashHex>`，PBKDF2-HMAC-SHA256、10 万次迭代、16 字节随机盐。**数据库不存明文**；迭代次数写在串里，将来调强度不会让旧哈希失效。
- **口令解析优先级**（`verifyAdminPassword`）：
  1. `settings.admin_pw_hash`（用户改过密码后以此为**唯一准绳**，不再回退）；
  2. `ADMIN_PASSWORD` Worker Secret（既有部署的既有口令，保证升级不掉线）；
  3. 内置默认 `admin`（全新部署、未配 secret 时的初始口令）。
- **签名密钥解耦**：新增 `settings.auth_signing_key`（一次性随机 32 字节，`setSettingIfAbsent` 防并发首请求双写）。Cookie 的 HMAC 密钥不再依赖口令——否则改密后无法验证存量 Cookie。
- **修改流程**：校验原密码（恒定时间）→ 两次新密码一致 → 强度（≥12 位且 ≥2 类字符）→ 不能与原密码相同 → 存哈希 → **bump `auth_epoch` 全局吊销所有会话**（有意为之：改密必须重新登录）。
- **强度反馈**：设置页实时 4 段强度条 + 明确错误码（`password_too_short` / `password_too_weak` / `password_mismatch` / `invalid_old_password` / `password_unchanged`）。
- **CPU 说明**：免费版 Workers 单次调用 CPU 预算约 10ms，PBKDF2 是原生 WebCrypto。若实测超限，只需下调 `ITERATIONS` 常量；已存储的哈希按自身记录的次数校验，不受影响。

### 19.3 前端重构（`public/` 三件套，Bento Grid 风格）

- **零构建不变**：样式参考里的 Tailwind class 全部转写为手写 CSS 令牌（zinc 中性色、16px 圆角、16/12/24px 三档间距、`shadow-sm → hover 扩散 + translateY(-2px)`、`active:scale-95`、图标 `scale(1.1)` 联动、200ms ease-out）。
- **布局**：`.bento` 桌面 4 列 → 平板（≤900px）2 列 → 手机（≤640px）1 列；卡片有 `col-2` / `row-2` 跨格，**不存在等大网格**。仪表盘用 2×2 大卡承载"今日执行"，设置页用 2×2 大卡承载密码表单。
- **暗色模式**：`prefers-color-scheme: dark` 全套令牌覆盖（不再是写死的暗色）。
- **无障碍**：`prefers-reduced-motion` 降级、`focus-visible` 焦点环、正文对比度满足 WCAG AA（次要文字用 zinc-500/600，不用 zinc-400）、正文行宽 ≤68ch。
- **CSP 兼容**：依旧零内联脚本/事件处理器（全局事件委托），`style-src 'unsafe-inline'` 仅用于少量 `style=""` 属性。
- **新增页面**：`#/accounts`（账户卡：状态徽章/默认徽章/验证/设为默认/删除 + 添加模态框）、`#/settings` 的密码修改大卡 + **退出登录按钮**（原来前端没有出口）。
- **全部原有功能保留**：任务卡（启停/运行/编辑/删除）、日志筛选 + 「加载更多」游标分页、仪表盘统计与即将执行、session 状态提示（改由默认账户状态驱动）。

### 19.4 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npx vitest run` | ✅ **139/139**（8 文件：schedule 10 / runner 21 / auth 13 / validation 18 / password 12 / accounts 18 / api 26 / frontend 21） |
| 迁移·干净库 | ✅ 0001+0002+0003 顺序应用成功，`accounts` 表与 `tasks.account_id`（默认 1）就位 |
| 迁移·存量库 | ✅ 存量 `tg_session` → 1 号默认账户（`status='ok'`），存量任务 `account_id=1`，settings 旧键已删 |
| `wrangler dev` 端到端 | ✅ 默认口令 `admin` 登录 200；错密 401；**未鉴权 `POST /api/logout` → 401**（P0-1 修复）；带 Cookie 访问不受匿名 logout 影响；无账户时不阻断建任务（落到占位账户）；弱/不一致/错原密码/相同密码四类校验全部命中；改密后旧密码 401、新密码 200、旧 Cookie 401；库中仅见 `pbkdf2$100000$...` 与随机签名密钥，无明文；`Origin: null` → 403；`/` 与 `/app.js` 均带 CSP + `nosniff` |
| `wrangler dev` cron | ✅ 手动触发后任务执行失败并记日志（`account_session_not_configured`），账户状态自动跃迁为 `invalid`，任务按 interval 重排到未来 |

### 19.5 本轮顺手修复的历史遗留（均配回归测试）

| 编号 | 问题 | 修复 |
|---|---|---|
| P0-1 | `/api/logout` 注册在鉴权中间件之前 → 匿名请求可 bump `auth_epoch` 全局吊销会话 | logout 移到中间件之后；`SKIP_AUTH` 移除该项 |
| P1-1 | 前端时区下拉只有 5 项，编辑列表外时区会**静默改写**为 Asia/Shanghai | `tzOptions()` 动态把任务当前时区补进列表 |
| P1-2 | `Origin: null`（沙箱 iframe）导致 `new URL()` 抛错 → 500 | try/catch，解析失败一律按 `origin_mismatch` 403 |
| P2-2 | `DELETE /api/tasks/:id` 删不存在的任务也返回 200 | 检查 `meta.changes`，为 0 返回 404 |
| P2-3 | `overview.upcoming` 只设上界，把已过期任务也算进"即将执行" | 增加 `next_run_at >= nowIso` 下界 |
| P2-4 | PATCH 合并存量后**无条件**校验排期组合，历史脏排期让"启停切换"也失败 | 仅在确实要动排期/需重算 `next_run_at` 时才做组合校验 |
| P2-8 | 静态响应缺 `X-Content-Type-Options` | catch-all 统一补 `nosniff` |
| P2-1 | 前端没有退出登录入口，`/api/logout` 是死代码 | 设置页新增退出登录按钮 |

### 19.6 仍未解决 / 下一步

1. **未部署**：本地代码领先线上，需先 `npm run db:migrate:remote` 再 `npm run deploy`（等用户下令）。
2. **未做浏览器自动化视觉回归**：响应式与 Bento 视觉目前只有静态契约测试（`tests/frontend.test.ts`）守护，改动 `public/` 后需人工在桌面/手机两种宽度过一遍。
3. **PBKDF2 迭代次数的线上 CPU 实测**：本地 dev 已验证功能正确，但免费版 10ms CPU 预算下的真实耗时需上线后观察；超限则下调 `ITERATIONS`。
4. `compatibility_date` 仍未上调（2025-04-01）；`telegram` 包 archived 的 `teleproto` 迁移评估仍未启动。
5. 多账户下的 **D1 写放大**：账户状态跃迁写已做条件化，但任务数 × 账户数增长后仍需关注。

### 19.7 浏览器实测（2026-10-24 下午，bsk + Edge）

上一轮交付时「未做浏览器视觉回归」是遗留项；本轮用 browser-skill（`bsk` + Edge 扩展）对 `wrangler dev` 做了真实浏览器验证，**当场抓出两个单测全绿但浏览器白屏/误跳转的真 bug**：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| B1 | 登录后仪表盘永远卡在"加载中..."，控制台 `ReferenceError: esc is not defined`（app.js:282），且 catch 块里也调 `esc` 导致二次抛错 | 重写 `public/app.js` 时 `esc()` 用在 30 处却漏写 `function esc` 定义。**单测全绿**——因为没有任何测试真正加载过 app.js | 补上 `esc` 定义；新增契约测试「所有被调用的自有工具函数都有定义」 |
| B2 | 设置页输错**原密码**，页面直接跳登录页，看不到错误提示 | `api()` 把**任何** 401 都当会话过期并跳登录页；而 `/api/password` 的 401 是业务错误（`invalid_old_password`） | 改为只对鉴权类 401（`unauthorized`/`expired`/`invalid_signature`/`revoked`）跳登录页；新增契约测试固化 |

**实测覆盖（全部通过）**：
- 登录页渲染（含初始密码 `admin` 提示）→ `admin` 登录成功 → 仪表盘 8 张卡片完整渲染
- 账户页：状态徽章/默认徽章/验证/删除/添加卡片齐全
- 设置页：密码三框 + 强度提示 + 关于 + 退出登录
- **密码四类校验全部在正确页面报错**：原密码错误 → `invalid_old_password`（留在设置页）；两次不一致 → `password_mismatch`；弱密码 → `password_too_short`；改密成功 → 跳登录页
- **改密后旧密码 `admin` 登录失败、新密码登录成功并回到仪表盘**
- 任务页：新建任务模态框（含新增的「执行账户」下拉）→ 保存 → 卡片正确展示排期/下次执行/账户归属 → 删除（confirm 对话框）正常
- 日志页：筛选下拉 + 空态 + 「加载更多」禁用态
- **响应式**：移动端 390×844 单列、桌面 1280 四列（`gridTemplateColumns` 实测 `250px×4`）、三个页面均无横向溢出（`scrollWidth === clientWidth`）
- 暗色模式（`prefers-color-scheme: dark`）生效；全站控制台无新增错误

**顺带修正的文案**：设置页原写「Session 字符串以哈希以外的方式安全保存在 D1」含混且不准（session 实为明文存 D1，属已知风险），改为「Session 字符串只保存在 D1，任何接口都不会返回它」。

**测试数**：139 → **141**（新增 B1/B2 两条防回归契约测试）。

### 19.8 上线记录（2026-10-24 15:55，用户下令「上线」）

**顺序**（严守红线 #8：先迁移再 deploy）：预检 → 提交 → 远程迁移 → 部署 → 线上验证。

**预检**：
- `npx wrangler whoami`：`d1 (write)` 等写权限齐全
- `npx wrangler d1 migrations list --remote`：仅 `0003_accounts.sql` 待应用（0001/0002 已在）
- `npx wrangler secret list`：`ADMIN_PASSWORD` / `TG_API_HASH` / `TG_API_ID` **三个齐全**
- 远程库实际数据：`settings` 与 `tasks` **均为空**（§18.6 所述的 1 个任务已不在），故本次迁移无数据回填风险
- `npm run verify`：tsc 0 错误 + vitest **141/141**

**提交**：`feat: 多账户管理 + WebUI 密码修改 + 前端 Bento Grid 重构`（19 改 + 8 新增 + 1 删除）

**迁移**：`npx wrangler d1 migrations apply telegram-checkin-db --remote` → `0003_accounts.sql` ✅（10 条命令）
**部署**：`npm run deploy` → 版本 `fa921228-2099-4589-b44b-d3c6e7530a0e`，3 个静态资源上传，gzip 339.46 KiB，Startup 78ms，cron `* * * * *` 已注册

**线上验证（全过）**：
| 项 | 结果 |
|---|---|
| `/api/health` | 200 `{"ok":true}` |
| 未带 Cookie 访问 tasks/accounts/logs/overview/session | 全 401 |
| **未鉴权 `POST /api/logout`** | **401**（P0-1 修复在线上生效） |
| 错误密码登录 | 401 `invalid_password` |
| 登录限流 | 同 IP 5 次失败后第 6 次 429（生产 D1 写入正常） |
| 安全响应头 | `/` 带 CSP + `X-Content-Type-Options: nosniff` |
| 前端代码版本 | 线上 `app.js` 含 `function esc` / `AUTH_401` / `renderAccounts` / `showAccountModal`；`style.css` 含 13 处 Bento 令牌 |
| **cron 真实触发** | `wrangler tail` 抓到 `event.cron = "* * * * *"`，`outcome: ok`，**cpuTime 1ms**（远低于免费版 10ms），`exceptions: []`，scriptVersion 正是本次部署的 `fa921228` |

**已知说明**：`Origin: null` 打 `/api/login` 返回 401 而非 403 是**预期**——login 注册在鉴权中间件之前，本就不做 Origin 校验；该校验对需鉴权的路由生效（本地已用 Cookie 实测 403）。

**遗留（用户侧）**：
1. Telegram session 未配置——需跑 `scripts/login.mjs` 拿 StringSession，在「账户」页添加（添加前任务执行会失败并把账户标记为 invalid）
2. 登录口令是 `ADMIN_PASSWORD` secret 的强随机值，不是 `admin`
3. 建议上线后连续观察 Cloudflare 面板的 `exceededCpu` 指标（本次 tail 实测 cron cpuTime 1ms，余量充足）

### 19.9 用户反馈修复：设置页鉴权 + 登录口令误导（2026-10-24 16:30）

用户反馈两个问题，均已修复并重新部署（版本 `37801ebd-89d3-4550-8f3f-72998295a82b`）。

**问题 1（真 bug，本轮重写引入）：未登录也能进设置页**

- 根因：`renderSettings` 是 6 个渲染函数里**唯一一个非 `async`、且不先调 API** 的。
  其余 4 个（dashboard/tasks/accounts/logs）都以 `api()` 开头，401 会被 `api()` 自动重定向到登录页；
  `renderSettings` 直接渲染表单，只在点「修改密码」时才发请求 → 匿名访问 `#/settings` 能看到完整密码表单。
- 修复：改为 `async`，渲染前先 `await api("/api/accounts")` 做鉴权探针；未登录直接返回（`api()` 已负责跳转）。
- 防回归：新增契约测试「除登录页外，每个渲染函数都先做鉴权探针再渲染」——
  静态解析每个渲染函数体，剥离"加载中"占位后，要求首个 `/api/` 调用早于首次实质 `el.innerHTML`。
- 浏览器实测：未登录访问 `#/settings` → `hash` 变 `#/login`、`hasPwForm=false`；登录后 → 正常渲染。**本地与线上均验证**。

**问题 2（文案误导，非逻辑 bug）：`admin` 登录不了**

- 根因：口令解析优先级是 `admin_pw_hash` → `ADMIN_PASSWORD` secret → 内置默认 `admin`。
  线上 `ADMIN_PASSWORD` secret **已设置**，所以 `admin` 不生效——这是设计如此。
  但登录页原写死"初始密码为 admin"，在设了 secret 的部署上就是**错误提示**。
- 文案修复：改为「未配置 `ADMIN_PASSWORD` 时初始口令为 `admin`；忘记密码可用 `wrangler secret put ADMIN_PASSWORD` 重置。」
- 运维处置：**已重置线上 `ADMIN_PASSWORD` secret 为新生成的强随机值**（20 位以内、无易混字符），
  并在对话中交付用户；用户登录后应在设置页改成自己的密码（改后以 `admin_pw_hash` 为唯一准绳，secret 不再参与校验）。
- 线上实测：新口令登录 200、带 Cookie 访问 `/api/accounts` 与 `/api/overview` 均 200、`admin` 仍 401。

**诊断证据**：修复前查生产 `settings` 表为空（无 `admin_pw_hash` / 无 `auth_signing_key`），
说明此前从未成功登录过，当前生效口令就是 secret。

**测试数**：141 → **143**（新增 2 条契约测试）。
