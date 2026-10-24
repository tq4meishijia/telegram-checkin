import type { Env } from "./bindings";

/**
 * accounts 表的对外投影：**绝不包含 session 字符串**。
 * 所有返回账户信息的接口都必须用这个列清单。
 */
export const ACCOUNT_COLS =
  "id, name, api_id, api_hash, tg_user_id, tg_username, status, last_error, last_verified_at, enabled, is_default, created_at, updated_at";

/**
 * 新账户是否应接管默认位：
 * - 一个账户都没有；
 * - 或当前默认账户从未配置过 session（迁移产生的占位账户）。
 * 这样首次添加真实账户时它会自动成为默认，不需要用户手动切换。
 */
export async function shouldBecomeDefault(env: Env): Promise<boolean> {
  const current = await env.DB.prepare(
    "SELECT session FROM accounts WHERE is_default = 1"
  ).first<{ session: string }>();
  if (!current) return true;
  return !current.session;
}

/**
 * 把默认位交给指定账户（或 id 最小者）。
 * 必须先清后设：`idx_accounts_default` 是 `WHERE is_default = 1` 的唯一部分索引，
 * 直接置 1 会撞索引（单测抓到过这个 bug）。
 */
export async function grantDefault(env: Env, id?: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET is_default = 0, updated_at = datetime('now')"),
    id === undefined
      ? env.DB.prepare(
          "UPDATE accounts SET is_default = 1, updated_at = datetime('now') WHERE id = (SELECT MIN(id) FROM accounts)"
        )
      : env.DB.prepare("UPDATE accounts SET is_default = 1, updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);
}
