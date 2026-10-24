-- 0002 加固迁移：登录限流表 + 任务连续失败计数
-- 依赖 0001_init.sql；上线顺序：先 apply 本迁移，再 wrangler deploy。

-- 登录限流：记录每个 IP 的登录失败次数（60 秒窗口，5 次失败后锁定至窗口结束）
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- 任务连续失败计数：供失败告警使用（每连续失败 3 次向"已保存消息"发一条告警）
ALTER TABLE tasks ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
