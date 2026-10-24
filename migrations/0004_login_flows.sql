-- 0004：网页交互式登录（手机号 → 验证码 → 两步密码）的中间态。
--
-- 为什么需要一张表：Telegram 的 sendCode 会生成一个与**当前 authKey** 绑定的
-- phoneCodeHash，后续 SignIn 必须用同一个 authKey。Worker 无状态、请求之间不共享
-- 内存，因此必须把「未授权的 StringSession + phoneCodeHash」持久化到两次请求之间。
--
-- 生命周期：创建后 10 分钟过期；登录成功后立即删除；用户取消时删除。
-- 该表只存**未授权**的 session（authKey 已生成但尚未绑定用户），不存已登录凭据。

CREATE TABLE IF NOT EXISTS login_flows (
  id              TEXT PRIMARY KEY,           -- 随机 UUID，不可猜测
  phone           TEXT NOT NULL,              -- 手机号（含国际区号）
  phone_code_hash TEXT NOT NULL DEFAULT '',   -- sendCode 返回，SignIn 时回传
  session         TEXT NOT NULL,              -- 未授权 StringSession（含 authKey）
  api_id          TEXT NOT NULL DEFAULT '',   -- 空=回退到 Worker Secret
  api_hash        TEXT NOT NULL DEFAULT '',
  stage           TEXT NOT NULL DEFAULT 'code', -- code | password | ready
  attempts        INTEGER NOT NULL DEFAULT 0, -- 验证码尝试次数（防爆破）
  tg_user_id      TEXT,                       -- 登录成功后填充
  tg_username     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL               -- 同 datetime('now') 格式，可字符串比较
);

CREATE INDEX IF NOT EXISTS idx_login_flows_expires ON login_flows(expires_at);
