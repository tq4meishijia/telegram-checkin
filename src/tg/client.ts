import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { Env } from "../bindings";
import { getSetting } from "../db";

/**
 * 账户级 Telegram 凭据。api_id/api_hash 可为空串，为空时回退到
 * Worker Secrets 里的全局值（api_id/api_hash 是应用级凭据；
 * 账号级凭据就是 StringSession 本身）。
 */
export interface AccountCredentials {
  session: string;
  api_id?: string | null;
  api_hash?: string | null;
}

/**
 * 用指定凭据创建 TelegramClient，connect，执行 fn，然后 disconnect。
 * 注意：只调 connect()，绝不调 start()（start() 会走交互登录流程）。
 */
export async function withAccountSession<T>(
  env: Env,
  cred: AccountCredentials,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T> {
  if (!cred.session) {
    throw new Error("account_session_not_configured");
  }
  const apiId = Number(cred.api_id || env.TG_API_ID);
  const apiHash = cred.api_hash || env.TG_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error("tg_credentials_missing");
  }

  const client = new TelegramClient(new StringSession(cred.session), apiId, apiHash, {
    connectionRetries: 3,
    autoReconnect: false,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/**
 * 解析默认账户（is_default=1；无默认账户时退到 id 最小者）。
 * 未配置任何账户时抛错，由调用方转成 400/日志。
 */
export async function getDefaultAccount(env: Env): Promise<AccountCredentials & { id: number }> {
  const row = await env.DB.prepare(
    "SELECT id, session, api_id, api_hash FROM accounts WHERE is_default = 1"
  ).first<{ id: number; session: string; api_id: string; api_hash: string }>();

  if (row) return row;

  const fallback = await env.DB.prepare(
    "SELECT id, session, api_id, api_hash FROM accounts ORDER BY id ASC LIMIT 1"
  ).first<{ id: number; session: string; api_id: string; api_hash: string }>();

  if (!fallback) throw new Error("no_account_configured");
  return fallback;
}

/**
 * 用默认账户执行 Telegram 操作。
 * 保留此入口以兼容既有调用方；新代码请直接用 withAccountSession。
 */
export async function withClient<T>(
  env: Env,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T> {
  const account = await getDefaultAccount(env);
  return withAccountSession(env, account, fn);
}
