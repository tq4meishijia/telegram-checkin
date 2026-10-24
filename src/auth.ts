import { createMiddleware } from "hono/factory";
import type { Env } from "./bindings";
import { getSetting, setSetting, setSettingIfAbsent } from "./db";
import { toHex, timingSafeEqualHex } from "./util";

// 恒定时间比较从 util 实现，此处重新导出以兼容既有 import 路径
export { timingSafeEqualHex };

/**
 * 不需要鉴权的路径（这些路由注册在中间件之前，本白名单是防御性冗余）。
 * 注意：`/api/logout` **故意不在名单里**——它注册在中间件之后，必须携带有效
 * Cookie 才能调用，否则匿名请求就能全局吊销会话。
 */
const SKIP_AUTH = ["/api/login", "/api/health"];

/** Cookie 有效期：7 天 */
export const AUTH_TTL_MS = 7 * 24 * 3600 * 1000;

/** 只有状态变更方法才做 Origin 校验（SameSite=Lax 之外的 CSRF 纵深防御） */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** 恒定时间比较两个任意字符串（先 SHA-256 抹平长度差，避免计时侧信道） */
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return timingSafeEqualHex(toHex(new Uint8Array(ha)), toHex(new Uint8Array(hb)));
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return toHex(new Uint8Array(sig));
}

/** 当前 auth epoch：退出登录/修改密码会 +1，用于服务端吊销已签发的 Cookie */
export async function getAuthEpoch(env: Env): Promise<number> {
  const v = await getSetting(env, "auth_epoch");
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export async function bumpAuthEpoch(env: Env): Promise<number> {
  const next = (await getAuthEpoch(env)) + 1;
  await setSetting(env, "auth_epoch", String(next));
  return next;
}

/**
 * Cookie 签名密钥：一次性随机生成后存入 settings，与管理员口令**解耦**。
 * 这样修改口令不会让签名算法失去输入源；改口令的吊销走 auth_epoch。
 */
export async function getAuthSigningKey(env: Env): Promise<string> {
  const existing = await getSetting(env, "auth_signing_key");
  if (existing && existing.length >= 32) return existing;

  const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await setSettingIfAbsent(env, "auth_signing_key", fresh);
  // 并发首请求下重新读取，确保拿到最终生效的那把钥匙
  return (await getSetting(env, "auth_signing_key")) ?? fresh;
}

/** 签发 Cookie 值：`<expiry>.<epoch>.<hmac(expiry.epoch)>` */
export async function signAuthCookie(env: Env): Promise<{ value: string; maxAgeSec: number }> {
  const expiry = Date.now() + AUTH_TTL_MS;
  const epoch = await getAuthEpoch(env);
  const payload = `${expiry}.${epoch}`;
  const sig = await hmacHex(await getAuthSigningKey(env), payload);
  return { value: `${payload}.${sig}`, maxAgeSec: Math.floor(AUTH_TTL_MS / 1000) };
}

/** 按请求协议决定是否附带 Secure（本地 http 开发不加，https 部署加上） */
export function buildSetCookie(rawValue: string, reqUrl: string, maxAgeSec: number): string {
  const secure = new URL(reqUrl).protocol === "https:" ? "; Secure" : "";
  return `auth=${rawValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const url = new URL(c.req.url);
  if (SKIP_AUTH.includes(url.pathname)) {
    return next();
  }

  // CSRF 纵深：跨站 Origin 发起的变更请求直接拒绝（同源请求浏览器必带匹配的 Origin）。
  // Origin 可能是 "null"（沙箱 iframe / file://）或畸形值，new URL 会抛 —— 一律按拒绝处理。
  const origin = c.req.header("Origin");
  if (origin && UNSAFE_METHODS.has(c.req.method)) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== url.host) {
      return c.json({ error: "origin_mismatch" }, 403);
    }
  }

  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)auth=([^;]+)/);
  if (!match) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const [expiryStr, epochStr, sig] = match[1].split(".");
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= 0 || Date.now() > expiry) {
    return c.json({ error: "expired" }, 401);
  }

  // 验证 HMAC 签名（恒定时间比较）
  const expected = await hmacHex(await getAuthSigningKey(c.env), `${expiryStr}.${epochStr}`);
  if (!sig || !timingSafeEqualHex(sig, expected)) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  // epoch 校验：退出登录/修改密码后旧 Cookie 全部失效
  if (Number(epochStr) !== (await getAuthEpoch(c.env))) {
    return c.json({ error: "revoked" }, 401);
  }

  return next();
});
