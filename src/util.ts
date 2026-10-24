/**
 * 通用小工具。
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
