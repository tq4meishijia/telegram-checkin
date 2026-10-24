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
