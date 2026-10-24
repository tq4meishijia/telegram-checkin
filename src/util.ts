/**
 * 通用小工具：十六进制转换、恒定时间比较、JSON 安全解析、超时包装。
 */

/** 读取 JSON 请求体；解析失败（无 body / 畸形 JSON）返回 null，由调用方决定 400。 */
export async function safeJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * 给 Promise 加超时。超时后 reject；同时清除定时器并接住底层 promise 的
 * 迟到 rejection，避免 unhandled rejection。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 生成与 SQLite `datetime('now')` **完全同格式**的时间串：UTC、空格分隔、无 Z。
 *
 * 为什么不用 toISOString()：`next_run_at` 等列是 ISO（T/Z），而 `created_at` /
 * `expires_at` 是 SQLite 空格格式。混用会导致字符串比较永远不成立
 * （见交接文档 §8「时间格式双轨」）。凡是与 datetime('now') 同列比较的值，
 * 一律用本函数生成。
 */
export function sqliteNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** 恒定时间比较两个十六进制串（长度不同直接 false） */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
