import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { Env } from "../bindings";
import { getSetting } from "../db";

/**
 * 用指定 session 字符串创建 TelegramClient，connect，执行 fn，然后 disconnect。
 * 注意：只调 connect()，绝不调 start()（start() 会走交互登录流程）。
 */
export async function withSession<T>(
  env: Env,
  sessionStr: string,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T> {
  const client = new TelegramClient(
    new StringSession(sessionStr),
    Number(env.TG_API_ID),
    env.TG_API_HASH,
    {
      connectionRetries: 3,
      autoReconnect: false,
    }
  );

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/**
 * 从 D1 读取 session，创建 TelegramClient，connect，执行 fn，然后 disconnect。
 */
export async function withClient<T>(
  env: Env,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T> {
  const sessionStr = await getSetting(env, "tg_session");
  if (!sessionStr) {
    throw new Error("tg_session not configured");
  }
  return withSession(env, sessionStr, fn);
}
