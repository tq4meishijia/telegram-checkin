import type { Env } from "./bindings";

/**
 * 登录失败限流：同一 IP 在 WINDOW_SEC 秒内失败 MAX_FAILURES 次后，
 * 在窗口剩余时间内拒绝登录（429）。数据落 D1 的 login_attempts 表
 * （migrations/0002_hardening.sql）。
 */
const WINDOW_SEC = 60;
const MAX_FAILURES = 5;

export const LOGIN_RATE_LIMIT = { windowSec: WINDOW_SEC, maxFailures: MAX_FAILURES } as const;

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec?: number;
}

export async function checkLoginAllowed(env: Env, ip: string): Promise<RateLimitResult> {
  const row = await env.DB.prepare(
    "SELECT fail_count, window_start FROM login_attempts WHERE ip = ?"
  ).bind(ip).first<{ fail_count: number; window_start: number }>();

  if (!row) return { ok: true };

  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = nowSec - row.window_start;
  if (elapsed >= WINDOW_SEC) return { ok: true }; // 窗口已过期，重新计数
  if (row.fail_count >= MAX_FAILURES) {
    return { ok: false, retryAfterSec: Math.max(1, WINDOW_SEC - elapsed) };
  }
  return { ok: true };
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - WINDOW_SEC;
  await env.DB.prepare(
    `INSERT INTO login_attempts(ip, fail_count, window_start) VALUES(?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET
       fail_count = CASE WHEN login_attempts.window_start < ? THEN 1 ELSE login_attempts.fail_count + 1 END,
       window_start = CASE WHEN login_attempts.window_start < ? THEN ? ELSE login_attempts.window_start END`
  ).bind(ip, nowSec, cutoff, cutoff, nowSec).run();
}

export async function clearLoginFailures(env: Env, ip: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}
