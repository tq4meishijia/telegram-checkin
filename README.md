# TG Checkin Worker

基于 Cloudflare Workers 免费计划的 Telegram 自动签到工具：模拟用户态账号，定时向指定 Telegram 机器人发送指令（如 `/checkin`），自带 Web 管理界面。

完整设计见 `PLAN.md`；运维/交接细节见 `AGENT_HANDOFF.md`。

## 架构

```
Cron(* * * * *) → cron/runner 扫 tasks 表 due 任务 → GramJS connect → sendMessage → disconnect
                     ↓ 写 run_logs / 重算 next_run_at
浏览器 → Hono API(/api/*，HMAC Cookie 鉴权 + 登录限流 + Origin 校验) → D1(settings/tasks/run_logs/login_attempts)
       → Static Assets(public/ 原生 SPA，统一带 CSP)
```

- 调度不依赖 cron 表达式解析，靠 `next_run_at` 字段；补跑容忍 30 分钟，超时跳过。
- 执行采用**租约式乐观锁**：抢占期间 `next_run_at` 指向 1 小时后的租约值，执行完毕（含异常/isolate 被 kill）后重排——任务永远不会停在"永远失选"的状态。
- 登录拿 session 只在本地脚本做；Worker 里只用已保存的 StringSession `connect()`，绝不 `start()`。
- session 字符串只存 D1，任何 API 都不返回给前端。
- 任务连续失败 3 次，会用当前 session 给自己的"已保存消息"发一条告警。

## 本地开发

```bash
# 依赖（Node >= 22）
npm install
# 本机在代理后面时：编辑 .npmrc 取消 proxy 两行注释；或 _run.bat npm install

# 配置本地环境变量（参考 .dev.vars.example 填入真实值）
cp .dev.vars.example .dev.vars

# 建本地库结构（0001 初始化 + 0002 加固迁移）
npm run db:migrate:local

# 起开发服务
npm run dev          # http://127.0.0.1:8787
# 手动触发一次 cron：
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"

# 校验（typecheck + 单测）
npm run verify
```

## 拿 Telegram Session（M1 闸门，非交互模式）

1. 在 https://my.telegram.org/apps 用小号申请 `api_id` / `api_hash`，填进 `.dev.vars`。
2. 非交互登录（手机号/二步密码走环境变量，验证码写入文件由脚本轮询）：

   ```bash
   # PowerShell 示例
   $env:TG_PHONE="+8613xxxxxxxxx"
   $env:TG_2FA="your_2fa_password"
   node --env-file=.dev.vars scripts/login.mjs
   # 收到短信验证码后，把验证码写进 .tg_code.txt，脚本自动继续
   ```

3. 终端输出 `SESSION=1...` 长串。
4. 启动 `npm run dev` 后打开管理界面，登录（密码 = `.dev.vars` 里的 `ADMIN_PASSWORD`）→ 设置页粘贴 session 保存。

## 部署上线

```bash
npx wrangler login
# 首次：npx wrangler d1 create tg-checkin-db，把 database_id 填回 wrangler.toml
npx wrangler d1 migrations apply tg-checkin-db --remote   # 必须先迁移
npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

> **更新部署顺序：先 apply 迁移，再 deploy。** 0002 迁移新增 `login_attempts` 表和 `tasks.fail_streak` 列，新版代码依赖它们；顺序反了会让签到执行报错。

## 备份

```bash
npm run db:export   # 导出到 backups/tg-checkin-db.sql（gitignored，请自行归档）
```

免费版 D1 无自动备份，建议定期执行并归档到仓库外。

## 常见问题

- **session 失效**：设置页会显示"已配置但无法验证"，清除后重新跑 `scripts/login.mjs` 粘贴新 session。
- **cron 不触发**：本地用 `/cdn-cgi/local/scheduled` 手动触发验证；线上等真实整分钟 cron（约有几十秒抖动），线上不能手动触发。
- **CPU 超限**：面板 Metrics 看 `exceededCpu`；免费版 cron 每次调用 CPU 预算 10ms，单条消息一般够，偶发超限由 isolate 弹性吸收。即使 isolate 被 kill，抢占租约也会让任务在 1 小时后自动重试，不会永久停跑。
- **登录被锁（429）**：同一 IP 1 分钟内密码错误 5 次会临时锁定，等窗口过期（≤60 秒）即恢复。
- **封号风险**：userbot 游走 Telegram ToS 边缘，请用小号、低频、开二步验证、加随机抖动。

## 已知限制

- `telegram`(GramJS) 2.26.22 已被官方标记 archived（后继分支 `teleproto`）。当前版本功能稳定、暂不迁移，但需关注上游安全更新（见 AGENT_HANDOFF §14）。
- 管理端登录态为无状态 Cookie，不支持单独吊销某一个 Cookie；「退出登录」采用全局吊销（epoch +1）。
- StringSession 明文存 D1：拿到 D1 读取权限 = 拿到账号控制权，请妥善保管 Cloudflare 账号与 Worker 部署权限。
