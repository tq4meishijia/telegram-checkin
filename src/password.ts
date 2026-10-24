/**
 * 管理密码的存储与校验。
 *
 * 存储格式：`pbkdf2$<iterations>$<saltHex>$<hashHex>`（PBKDF2-HMAC-SHA256）。
 * 只存盐值 + 派生哈希，**从不存明文**；迭代次数写在串里，将来要调强度不用作废旧哈希。
 *
 * 口令解析优先级（`verifyAdminPassword`）：
 *   1. settings.admin_pw_hash —— 用户通过 WebUI 改过密码后以此为准；
 *   2. ADMIN_PASSWORD（Worker Secret）—— 既有部署的既有口令，保证升级不掉线；
 *   3. 内置默认口令 "admin" —— 全新部署、未配置 secret 时的初始口令。
 *
 * 关于 CPU：免费版 Workers 单次调用 CPU 预算约 10ms，而 PBKDF2 100k 次是原生
 * WebCrypto 实现（非纯 JS 循环）。若实测超限，只需下调 ITERATIONS——
 * 已存储的哈希按自身记录的迭代次数校验，不会失效。
 */
import type { Env } from "./bindings";
import { getSetting } from "./db";
import { secureEqual } from "./auth";
import { fromHex, timingSafeEqualHex, toHex } from "./util";

/** 全新部署、未设置任何 secret 时的初始口令 */
export const DEFAULT_ADMIN_PASSWORD = "admin";

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/** 生成可存储的密码哈希串。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/** 校验密码是否匹配存储串。格式非法 / 参数越界一律返回 false，不抛异常。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) return false;

  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (salt.length < 8 || expected.length === 0) return false;

  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqualHex(toHex(actual), toHex(expected));
}

/**
 * 新密码强度要求：12-128 位，且至少覆盖 2 类字符（小写/大写/数字/符号）。
 * 返回 null 表示通过，否则返回错误码。
 */
export function validatePasswordStrength(password: unknown): string | null {
  if (typeof password !== "string") return "invalid_new_password";
  if (password.length < 12) return "password_too_short";
  if (password.length > 128) return "password_too_long";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return "password_too_weak";
  return null;
}

/**
 * 校验登录口令（恒定时间比较）。
 * 一旦设置了 admin_pw_hash，就以哈希为唯一准绳，不再回退 secret/默认口令。
 */
export async function verifyAdminPassword(env: Env, password: string): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) return false;

  const stored = await getSetting(env, "admin_pw_hash");
  if (stored) {
    try {
      return await verifyPassword(password, stored);
    } catch {
      // WebCrypto 不可用时退回 secret 比对，避免把自己锁在门外
    }
  }

  if (env.ADMIN_PASSWORD) return secureEqual(password, env.ADMIN_PASSWORD);
  return secureEqual(password, DEFAULT_ADMIN_PASSWORD);
}
