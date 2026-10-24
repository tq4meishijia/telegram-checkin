# 执行任务书：Telegram 自动签到 Worker（明天用）

> 使用方法：把 **第 1 节"全局上下文"整段粘贴**作为开场，然后**按里程碑粘贴第 3 节的任务指令**，每完成一个里程碑，人工核对"验收清单"后再进入下一个。
> 编写假设：执行模型为 **Hy4preview（腾讯混元 Hy4 preview）**——770B/49B 激活 MoE、1M 上下文、强 agentic coding 能力。**里程碑可以合并下发（见第 4 节）**，唯独 M1 必须单独先做（技术闸门，与模型能力无关）。
> 若换成上下文有限的小模型，则退回"一次一个里程碑、每步重贴全局上下文"的保守打法，本文件其余内容不变。

---

## 0. 人工前置准备（开工前你自己完成，约 20 分钟）

- [ ] 本地装好：Node.js ≥ 22、npm、Git
- [ ] Cloudflare 账号（免费），`npx wrangler login` 能登录
- [ ] Telegram：准备一个**小号**（强烈建议不要大号），开启二次验证（设置 → 隐私与安全 → 两步验证），记好密码
- [ ] 访问 https://my.telegram.org/apps 用小号登录，创建应用，拿到 **api_id**（数字）和 **api_hash**（32位字符串）
- [ ] 想好一个管理密码（ ≥ 16 位随机串）
- [ ] 把 `PLAN.md` 放在项目根目录旁边，执行模型可以随时读

---

## 1. 全局上下文（每次新开会话/新任务都先贴这段）

```text
你在帮我实现一个全栈 Serverless 项目：Telegram 自动签到工具。
完整设计文档在项目根目录的 PLAN.md，动手前必须先读它，并严格遵守其中的架构与数据模型。

技术栈（不可更改）：
- Cloudflare Workers 免费版 + TypeScript + Hono（Web 框架）
- GramJS（npm 包名 telegram，锁定 ^2.26.x）做 Telegram MTProto 用户态客户端
- Cloudflare D1 作为唯一数据库（migrations 管理表结构）
- Workers Static Assets 托管原生 HTML/JS 单页管理界面（不引入任何前端构建工具）
- 定时：wrangler.toml 里单个 cron trigger "* * * * *"，代码内扫 tasks 表的 next_run_at 字段决定执行

硬性约束（违反即为错误）：
1. wrangler.toml 必须包含 compatibility_flags = ["nodejs_compat"]（GramJS 依赖 Buffer/node:net）
2. Worker 里用已保存的 StringSession 时，只能 client.connect()，禁止 client.start()（交互登录只在本地脚本 scripts/login.mjs 里做）
3. 所有密钥（TG_API_ID/TG_API_HASH/ADMIN_PASSWORD）走环境变量/.dev.vars/wrangler secret，禁止硬编码、禁止写进日志；StringSession 存 D1 的 settings 表，任何接口不得把 session 字符串返回给前端
4. 依赖全部锁版本，不引入设计文档之外的库（尤其不许引 cron 解析库——调度和时区换算按 PLAN.md 附录 A 自己实现）
5. 每完成一个文件就自己跑类型检查（npx tsc --noEmit），每完成一个里程碑给出我可以直接复制执行的验证命令
6. 不确定 GramJS 某个 API 的签名时，去读 node_modules/telegram 里的 .d.ts 声明文件确认，禁止凭记忆编造
7. 写代码以"能跑、简单"为最高优先级，不要过度设计，不要加设计文档没有的功能

工作方式：我会一个里程碑一个里程碑地给你指令。每步完成后，停下来等我确认验收结果，不要自己进入下一步。
```

---

## 2. 项目初始化（你可以先手动做，也可以让模型做 M0）

```bash
mkdir tg-checkin-worker && cd tg-checkin-worker
git init
# 把 PLAN.md 复制进项目根目录
```

`.dev.vars`（本地开发用，记得加进 .gitignore）：
```
TG_API_ID=你的api_id
TG_API_HASH=你的api_hash
ADMIN_PASSWORD=你的管理密码
```

---

## 3. 分里程碑任务指令（逐段粘贴）

### M0 · 脚手架（先跑通骨架）

<details open>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 PLAN.md 的 M0 里程碑：初始化项目骨架。要求：

1. npm init，安装并锁定：hono ^4、telegram ^2.26.x；devDependencies：wrangler ^4、typescript、@cloudflare/workers-types、vitest
2. wrangler.toml 按 PLAN.md 第 7 节结构写：name="tg-checkin"、main="src/index.ts"、compatibility_date 用今天的、compatibility_flags=["nodejs_compat"]、D1 绑定 DB（database_name="tg-checkin-db"，database_id 先留 "TODO" 占位并注释提醒）、[triggers] crons=["* * * * *"]、[assets] directory="./public" binding="ASSETS"
3. tsconfig.json：面向 workers 的标准配置（types 引 @cloudflare/workers-types，moduleResolution "bundler"，strict）
4. src/index.ts：Hono app，GET /api/health 返回 {ok:true}；export default 同时带 fetch 和 scheduled 两个入口（scheduled 先只 console.log）
5. migrations/0001_init.sql：原样使用 PLAN.md 第 4 节的三张表 DDL
6. public/index.html 先放一个占位页
7. package.json scripts：dev / deploy / db:create / db:migrate:local / db:migrate:remote / typecheck
8. 跑 npx tsc --noEmit 通过；跑 npm run dev 后 curl http://localhost:8787/api/health 验证
完成后告诉我接下来要我手动执行哪条命令创建 D1 并把 id 填回 wrangler.toml。
```
</details>

**验收清单（你来核对）**
- [ ] `npm run dev` 启动后 `curl http://localhost:8787/api/health` 返回 `{"ok":true}`
- [ ] `npx wrangler d1 create tg-checkin-db` 成功，database_id 已填回 wrangler.toml
- [ ] `npx wrangler d1 migrations apply tg-checkin-db --local` 成功
- [ ] `npx wrangler d1 execute tg-checkin-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"` 能看到 settings/tasks/run_logs

---

### M1 · ⚠️ 关键 Spike：验证 GramJS 在 Workers 里能发消息（GO/NO-GO 闸门）

> 这一步是整个项目的生死验证。先做本地登录脚本拿 session，再在 `wrangler dev` 里真实发一条消息。

<details open>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 PLAN.md 的 M1 里程碑（技术验证 spike），分两个文件：

【文件 1：scripts/login.mjs】（运行在本地 Node，不在 Worker 里）
- 引入 telegram 和 telegram/sessions 的 StringSession、node readline 做交互
- 从 process.env 读 TG_API_ID/TG_API_HASH（用 node --env-file=.dev.vars 或手动 dotenv 读取，二选一并在 README 注明用法）
- 空 StringSession 创建 client 并 client.start({ phoneNumber, phoneCode, password, onError }) 交互式登录
- 成功后 console.log("SESSION=" + client.session.save())，并调 client.getMe() 打印账号名验证
- 结尾 client.disconnect()

【文件 2：src/tg/client.ts + 一个临时测试路由】
- 导出 async function withClient(env, fn)：从 D1 settings 表读 key='tg_session' 的值 → new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries:3, autoReconnect:false }) → await client.connect() → try{ return await fn(client) } finally{ await client.disconnect() }
- 注意：这里只 connect，绝不 start；apiId/apiHash 从 env 读
- src/index.ts 加临时路由 POST /api/spike-send（暂不加鉴权，M4 再加）：body {to, text}，用 withClient 调 client.sendMessage(to, {message:text})，返回 {ok:true}；出错时返回 500 + 错误名和 message（特别注意把 FLOOD_WAIT 类错误的秒数透出）
- 注意 worker 打包体积，跑 npx wrangler deploy --dry-run 看压缩后大小并报告给我
- npx tsc --noEmit 通过后给我验证步骤

如果 connect 阶段报与 net/Socket/Buffer 相关的错，先确认 nodejs_compat 已生效；再不行按 PLAN.md 附录 B 备用路径改造：npm i telegram@browser，客户端选项加 useWSS:true，并在 src/index.ts 顶部给 globalThis.localStorage 打内存桩。两条路径都试过仍失败就停下来向我报告完整报错，不要继续往下做。
```
</details>

**验收清单（你来核对，需要真机 Telegram 配合）**
- [ ] `node scripts/login.mjs` 交互登录小号成功（收验证码、输二步验证密码），终端输出 `SESSION=1...` 开头的长字符串
- [ ] 把 session 写入本地 D1：`npx wrangler d1 execute tg-checkin-db --local --command "INSERT INTO settings(key,value) VALUES('tg_session','粘贴的SESSION串')"`
- [ ] `curl -X POST http://localhost:8787/api/spike-send -H 'content-type: application/json' -d '{"to":"me","text":"spike 测试"}'` 返回 ok，且**小号 Telegram 的"收藏夹/Saved Messages"里真的出现这条消息**
- [ ] `npx wrangler deploy --dry-run` 显示压缩后体积 < 3MB
- [ ] dev 日志里没有 CPU time exceeded 报错
- [ ] **NO-GO 判定**：两条路径都连不上/发不出 → 停下来把报错发给我（发到原对话里），不要硬闯

---

### M2 · Session 管理 API

<details>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 M2：把 M1 的临时 spike 路由升级为正式的 session 管理接口（此时仍不加鉴权，M4 统一加）：

1. DELETE 掉 /api/spike-send
2. GET /api/session：返回 { configured: boolean, account?: { name, username, phone } }。已配置时用 withClient 调 getMe() 取账号信息；getMe 失败（session 失效）返回 { configured:true, account:null, error:"invalid_session" }。任何情况下不得返回 session 字符串本身
3. PUT /api/session：body { session }，先用它 connect+getMe 验证有效 → 写入 settings（INSERT OR REPLACE）→ 返回账号信息；无效返回 400 与原因
4. DELETE /api/session：从 settings 删除 tg_session
5. src/db.ts：把 settings 读写抽成 getSetting(env,key)/setSetting(env,key,value)
6. npx tsc --noEmit 通过，curl 给出三个接口的验证命令和预期输出
```
</details>

**验收清单**
- [ ] 删掉本地 settings 里的 session 后 GET /api/session → `{configured:false}`
- [ ] PUT 一个乱串 → 400；PUT 真 session → 返回小号的账号信息
- [ ] GET /api/session → 显示账号名；响应全文里搜不到 session 字符串

---

### M3 · 调度引擎（核心）

<details>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 M3：实现调度引擎。严格按 PLAN.md 第 4 节末尾"执行器逻辑"和附录 A 的算法，不要自己发明别的方案。

1. src/cron/schedule.ts：
   - computeNextRun({scheduleType, scheduleValue, timezone, jitterMinutes}, fromDate): Date|null
   - daily：scheduleValue="08:00" 或 "08:00,20:00"，用附录 A 算法算时区内下一个未来时刻；jitter>0 时加 0..jitter 分钟的随机整数
   - interval：scheduleValue=分钟数字符串，next = from + N 分钟 + 可选 jitter
   - 非法输入返回 null 而不是抛异常
   - 给这个文件写 vitest 单测：固定 from 时刻，断言 Asia/Shanghai 08:00 换算出的 UTC 是前一天的 16:00；跨午夜的 case；interval 的 case
2. src/cron/runner.ts：export async function runDueTasks(env)：
   - SELECT * FROM tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= datetime('now') ORDER BY next_run_at LIMIT 10
   - 逐个串行执行：先乐观锁占位（UPDATE tasks SET next_run_at=NULL WHERE id=? AND next_run_at=?，影响行数 0 则跳过）→ withClient 发送 command 到 bot_username（capture_reply=1 时发送后等 reply_wait_sec 秒，用 getMessages 取最新一条非自己发的消息文本存进 detail，最多存 500 字符）→ 写 run_logs（status/duration_ms/detail）→ 更新 tasks.last_run_at/last_status/last_error → 用 computeNextRun 重算 next_run_at 写回
   - 补跑策略：next_run_at 落后 now 超过 30 分钟的任务不执行，记 status='skipped' detail='missed,rescheduled'，直接重排到未来
   - 单个任务整体包 25 秒超时（Promise.race），异常一律捕获记日志，绝不能让一个任务炸掉整轮
   - 结尾：Math.random()<0.01 时 DELETE FROM run_logs WHERE created_at < datetime('now','-30 days')
3. src/index.ts 的 scheduled 入口：ctx.waitUntil(runDueTasks(env))，并 try/catch 兜底
4. 创建任务/更新任务时要算 next_run_at 的逻辑先抽成 src/api/tasks.ts 里的 helper（M4 用），本里程碑可以先写一个临时路由 POST /api/debug-create-task 便于测试（M4 时删除）
5. npx tsc --noEmit + npx vitest run 全绿后，给我本地触发 cron 的验证方法
```
</details>

**验收清单**
- [ ] `npx vitest run` 时区换算测试通过（重点看 Asia/Shanghai 08:00 → UTC 16:00 前一天）
- [ ] 本地用 debug 路由建一个 interval=1 分钟、目标为 `me`（收藏夹）、command 为测试文本的任务
- [ ] `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` 触发后：收藏夹收到消息；`run_logs` 表有 success 记录；`tasks.next_run_at` 被推进到下一分钟
- [ ] 把任务的 next_run_at 手动改成 2 小时前再触发 → 记 skipped 而非补发
- [ ] 把 session 删了再触发 → 记 failed 且 last_error 有信息，不影响下一轮

---

### M4 · 任务 CRUD + 日志 API + 鉴权

<details>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 M4：

1. src/auth.ts：
   - POST /api/login：body {password}，与 env.ADMIN_PASSWORD 比对（crypto.subtle.timingSafeEqual 或等长缓冲比较），成功则 Set-Cookie: auth=<expiryUnixMs>.<hex(HMAC-SHA256(ADMIN_PASSWORD, String(expiry)))>；HttpOnly; SameSite=Lax; Path=/; Max-Age=604800
   - Hono 中间件 authMiddleware：校验 cookie 签名与过期时间，挂载到所有 /api/* 路由（/api/login 和 /api/health 除外）
   - POST /api/logout 清 cookie
2. src/api/tasks.ts：GET /api/tasks（列表，前端要显示 next_run_at 换算成本地时间——由前端换算，后端只存 UTC）；POST /api/tasks（校验字段：bot_username 必须以 @ 开头或是合法 t.me 用户名，schedule_type∈{daily,interval}，daily 的 HH:mm 格式校验、interval≥1 整数；创建后立刻 computeNextRun 落库）；PATCH /api/tasks/:id（改了排期相关字段必须重算 next_run_at；enabled 切换不影响）；DELETE /api/tasks/:id；POST /api/tasks/:id/run（立即执行一次，复用 runner 里单任务执行函数，不影响 next_run_at，同步返回执行结果给前端）
3. 删掉 M3 的 /api/debug-create-task
4. src/api/logs.ts：GET /api/logs?task_id=&limit=&before_id=，倒序，limit 上限 100
5. GET /api/overview：今日(UTC) run_logs 成功/失败/skipped 计数、enabled 任务按 next_run_at 升序前 5 条、session configured 状态
6. npx tsc --noEmit 通过，给我一套 curl 验证命令（含未带 cookie 访问应 401 的用例）
```
</details>

**验收清单**
- [ ] 无 cookie 调任何 /api/tasks → 401；错误密码登录 → 401；正确密码登录后能 CRUD
- [ ] 建一个 daily 08:00 的任务，返回的 next_run_at 换算后确实是明天（或今天）08:00 本地时间
- [ ] POST /api/tasks/:id/run 立刻真发出一条消息并返回 success
- [ ] PATCH 把 daily 改成 interval=60 → next_run_at 变成约 1 小时后

---

### M5 · Web 管理界面

<details>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 M5：在 public/ 写原生 SPA（index.html + app.js + style.css，禁止任何框架/CDN/构建步骤），hash 路由四个页面：

1. #/login：密码框 + 登录按钮，成功跳 #/
2. #/ 仪表盘：今日成功/失败计数卡片；即将执行列表（任务名 + 相对时间，如"23 分钟后"）；session 状态卡（未配置显示红色警告并链接到设置页）
3. #/tasks：表格列出全部任务（名称/目标 bot/指令/排期人类可读描述/下次执行本地时间/启用开关/最近状态）；每行按钮：编辑、立即运行（点击后按钮 loading，alert 出结果）、删除（confirm）；顶部"新建任务"按钮弹出表单模态框（字段与 API 一致：名称、bot username、指令、类型下拉[每天定时/每隔 N 分钟]、时间 input[type=time] 支持填多个、间隔分钟数、时区下拉默认 Asia/Shanghai、抖动分钟、抓取回复 checkbox）
4. #/logs：按任务筛选下拉 + 倒序表格（时间/任务/状态徽章[success绿 failed红 skipped灰]/detail 截断展开）
5. #/settings：session 状态卡（已配置显示账号名+username；未配置显示 textarea 粘贴框+保存按钮）；危险区：清除 session 按钮（confirm）
6. 所有 fetch 统一封装：401 时自动跳 #/login；错误以 toast/alert 提示
7. style.css：暗色主题卡片式布局，移动端基本可用即可，总 CSS 控制在 300 行内
8. 确认 wrangler assets 行为：/api/* 打到 worker，其余路径由 assets 服务（如需在 src/index.ts 加静态回退路由就加 app.get('*', c => c.env.ASSETS.fetch(c.req.raw))，注意放在所有 /api 路由之后）
完成后给我浏览器手测路径清单。
```
</details>

**验收清单（浏览器全流程）**
- [ ] 打开 `/` 未登录 → 自动跳登录页；登录后看到仪表盘
- [ ] 在界面上新建一个"每隔 2 分钟给自己收藏夹发测试"的任务 → 2 分钟后收藏夹收到、日志页有 success 记录、仪表盘计数变化
- [ ] 立即运行按钮可用；启停开关生效（停用后不再收到）
- [ ] 设置页粘贴 session、显示账号名；清除后仪表盘出现警告

---

### M6 · 部署上线

<details>
<summary><b>📋 粘贴给模型的指令</b></summary>

```text
执行 M6：指导我完成上线（以给我命令清单为主，需要你自己执行的只有代码改动）：
1. README.md 写完整：架构图（抄 PLAN.md）、本地开发步骤、登录拿 session 步骤、部署步骤、常见问题（session 失效怎么办/cron 不触发怎么排查/CPU 超限指标在哪看）
2. 代码清理：spike/debug 残留确认无遗漏；console.log 里确认没有打印 session 的地方
3. 给我依次执行的命令清单：wrangler secret put TG_API_ID / TG_API_HASH / ADMIN_PASSWORD；d1 migrations apply --remote；通过线上 PUT /api/session 存 session（或用 curl 直接 d1 execute --remote 写 settings，给出两种）；wrangler deploy
4. 部署后验证清单：线上健康检查、登录、建一个 5 分钟后执行的 daily 任务、等真实 cron 触发（提醒：线上不能用 /__scheduled，要等真实整分钟，且 cron 触发可能有几十秒抖动）
5. 可选加固：把 Cloudflare Access（Zero Trust → Access → 自建应用）套在 worker 域名前面的操作步骤写进 README
```
</details>

**验收清单**
- [ ] 线上界面全流程可用
- [ ] 真实 cron 触发成功：到点收到签到消息、run_logs 有记录
- [ ] Cloudflare 面板 Metrics 里观察 24h：无 exceededCpu、请求量 ≈ 1440/天+少量
- [ ] 把手机 Telegram 里该小号的"活跃会话"截图留档，确认只有 Workers 这一个登录

---

### M7 · 可选迭代（以后想做再贴）

```text
按优先级：1) 签到失败时用当前 session 给自己收藏夹发一条告警消息（runner 里失败分支加即可，注意防止告警本身失败造成循环）
2) capture_reply 增强：发送后若机器人回复里带 inline keyboard，支持配置"点击第 N 个按钮"（先读 node_modules 里 .d.ts 确认 GramJS 的按钮点击 API 签名再实现）
3) 多账号支持（settings 表改 accounts 表，tasks 加 account_id 外键）
4) Cloudflare Access 替换密码登录
```

---

## 4. 给 Hy4preview 的使用建议

**模型底细（2026-08-28 发布并开源）**：770B 总参 / 49B 激活 MoE，**1M 上下文**，主打 agentic coding、长程规划、工具调用。它是强模型，本任务书按"弱模型"切的粒度对它偏保守——按下面放宽效率更高。

1. **里程碑分三批下发**，不必一次一步：
   - **第 1 批：只做 M0 + M1**。M1 必须单独先跑完并通过验收——它是技术闸门，卡住的原因是 GramJS 环境本身，不是模型能力。
   - **第 2 批：M2 + M3 + M4**（存储 + 调度引擎 + API/鉴权）
   - **第 3 批：M5 + M6**（界面 + 部署）
   每批结束后你核对一次验收清单即可，中间不用 `/clear`，1M 上下文装得下整个仓库加 PLAN.md。
2. **让它自己跑命令验证**：Hy4 有完整工具调用，不要你替它执行 curl/wrangler。在指令里明确要求："每改完一个文件就自己执行验证命令，并把**真实终端输出**贴回对话，不许只说'已验证'。"

3. **硬性约束一条都不能删**：强模型更容易自作主张。全局上下文里的第 2 条（Worker 里只 `connect()` 不 `start()`）、第 3 条（session 不外泄不打日志）、第 4 条（不引入额外依赖、时区换算自己实现）必须保留。
4. **M1 卡住时的标准动作**：两条 GramJS 路径都失败就让它停下，输出完整报错 + 相关文件 + 已尝试方案，你拿这份材料来找我（或换模型单独攻这一点），不要让它"再试试"空转。
5. **别让它碰你的真实大号**：所有测试消息只发 `me`（收藏夹），稳定后再指向真正的签到机器人。
6. **关于"免费"**：WorkBuddy/CodeBuddy 的 Hy4preview 免费是**限时**的（发布时说两周，按 8/28 算大约 9 月中到期），开工前先确认你的入口还能不能免费用。若已过期，API 价格是输入 6 元/百万 token、输出 18 元/百万 token——本项目全量做完（含多轮调试）大致是**几十元人民币**量级，别为了省这点钱牺牲质量。
