import type { Env } from "./bindings";

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  ).bind(key, value).run();
}

/**
 * 仅当 key 不存在时写入（用于首次生成随机签名密钥等"只初始化一次"的场景）。
 * 并发首次请求下只有一个写入会生效，避免两个请求各生成一把钥匙、互相把对方的 Cookie 打失效。
 */
export async function setSettingIfAbsent(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO NOTHING"
  ).bind(key, value).run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}
