-- 0003 多账户：accounts 表 + tasks.account_id
-- 依赖 0001_init.sql / 0002_hardening.sql；上线顺序：先 apply 本迁移，再 wrangler deploy。

-- Telegram 账户：每个账户一条 StringSession，独立启停、独立状态。
-- api_id / api_hash 可空：为空时回退到 Worker Secrets 里的全局值
-- （Telegram 的 api_id/api_hash 是应用级凭据，账号级凭据就是 StringSession 本身）。
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  session          TEXT NOT NULL DEFAULT '',
  api_id           TEXT NOT NULL DEFAULT '',
  api_hash         TEXT NOT NULL DEFAULT '',
  tg_user_id       INTEGER,
  tg_username      TEXT,
  status           TEXT NOT NULL DEFAULT 'unknown',   -- ok | invalid | unknown
  last_error       TEXT,
  last_verified_at TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  is_default       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一 Telegram 账号只允许绑定一次（重复登录拦截）
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user ON accounts(tg_user_id) WHERE tg_user_id IS NOT NULL;
-- 默认账户唯一：索引只收录 is_default=1 的行，值恒为 1 → 最多一行
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_default ON accounts(is_default) WHERE is_default = 1;

-- 存量 settings.tg_session 迁移为 1 号账户（无存量 session 时建占位账户，
-- 保证 tasks 回填的 account_id=1 一定指向真实行）
INSERT OR IGNORE INTO accounts(id, name, session, status) VALUES (1, '默认账户', '', 'unknown');
UPDATE accounts
   SET session = (SELECT value FROM settings WHERE key = 'tg_session'),
       status  = 'ok'
 WHERE id = 1
   AND (SELECT value FROM settings WHERE key = 'tg_session') IS NOT NULL;
UPDATE accounts SET is_default = 1 WHERE id = 1;

-- tasks 归属账户。注意：SQLite 禁止 ADD COLUMN 带 REFERENCES（外键开启时要求默认 NULL），
-- 故不建外键，级联删除由应用层 batch 完成（DELETE tasks WHERE account_id=?）。
ALTER TABLE tasks ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id, enabled, next_run_at);

-- session 的唯一真源已改为 accounts 表，删除 settings 里的旧键
DELETE FROM settings WHERE key = 'tg_session';
