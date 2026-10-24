import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  authMiddleware,
  timingSafeEqualHex,
  secureEqual,
  signAuthCookie,
  buildSetCookie,
  bumpAuthEpoch,
} from "../src/auth";
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures } from "../src/ratelimit";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";

function makeEnv(settings: Record<string, string> = {}) {
  const fake = createFakeDb({ settings });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("") },
    TG_API_ID: "12345",
    TG_API_HASH: "hash",
    ADMIN_PASSWORD: "secret-pw",
  } as unknown as Env;
  return { env, fake };
}

function testApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/*", authMiddleware);
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.post("/api/echo", (c) => c.json({ ok: true }));
  return app;
}

async function validCookie(env: Env): Promise<string> {
  const { value } = await signAuthCookie(env);
  return `auth=${value}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("恒定时间比较", () => {
  it("timingSafeEqualHex：相同为 true，不同/不同长度为 false", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abcde")).toBe(false);
  });

  it("secureEqual：相同为 true（含不同长度输入）", async () => {
    expect(await secureEqual("hunter2", "hunter2")).toBe(true);
    expect(await secureEqual("hunter2", "hunter3")).toBe(false);
    expect(await secureEqual("short", "much-longer-string")).toBe(false);
  });
});

describe("Cookie 构造", () => {
  it("https 请求带 Secure，http 不带", () => {
    expect(buildSetCookie("v", "https://x.workers.dev/api/login", 604800)).toContain("Secure");
    expect(buildSetCookie("v", "http://127.0.0.1:8787/api/login", 604800)).not.toContain("Secure");
  });

  it("签发值形如 <expiry>.<epoch>.<64 位 hex>", async () => {
    const { env } = makeEnv();
    const { value } = await signAuthCookie(env);
    expect(value).toMatch(/^\d+\.0\.[0-9a-f]{64}$/);
  });
});

describe("authMiddleware", () => {
  it("无 Cookie → 401 unauthorized", async () => {
    const { env } = makeEnv();
    const res = await testApp().fetch(new Request("http://t/api/ping"), env, {} as any);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("合法 Cookie → 200", async () => {
    const { env } = makeEnv();
    const res = await testApp().fetch(
      new Request("http://t/api/ping", { headers: { Cookie: await validCookie(env) } }),
      env,
      {} as any
    );
    expect(res.status).toBe(200);
  });

  it("伪造签名 → 401 invalid_signature", async () => {
    const { env } = makeEnv();
    const { value } = await signAuthCookie(env);
    const [expiry, epoch] = value.split(".");
    const res = await testApp().fetch(
      new Request("http://t/api/ping", { headers: { Cookie: `auth=${expiry}.${epoch}.${"0".repeat(64)}` } }),
      env,
      {} as any
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_signature");
  });

  it("过期 Cookie → 401 expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { env } = makeEnv();
    const cookie = await validCookie(env);
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z")); // 8 天后

    const res = await testApp().fetch(
      new Request("http://t/api/ping", { headers: { Cookie: cookie } }),
      env,
      {} as any
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("expired");
  });

  it("退出登录（epoch+1）后旧 Cookie → 401 revoked", async () => {
    const { env } = makeEnv();
    const cookie = await validCookie(env);
    await bumpAuthEpoch(env);

    const res = await testApp().fetch(
      new Request("http://t/api/ping", { headers: { Cookie: cookie } }),
      env,
      {} as any
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("revoked");
  });

  it("跨站 Origin 的变更请求 → 403 origin_mismatch；同源放行", async () => {
    const { env } = makeEnv();
    const cookie = await validCookie(env);
    const app = testApp();

    const evil = await app.fetch(
      new Request("http://t/api/echo", {
        method: "POST",
        headers: { Origin: "http://evil.com", Cookie: cookie },
      }),
      env,
      {} as any
    );
    expect(evil.status).toBe(403);
    expect((await evil.json()).error).toBe("origin_mismatch");

    const same = await app.fetch(
      new Request("http://t/api/echo", {
        method: "POST",
        headers: { Origin: "http://t", Cookie: cookie },
      }),
      env,
      {} as any
    );
    expect(same.status).toBe(200);
  });
});

describe("登录限流", () => {
  it("5 次失败后锁定，retry_after 在 1..60，清除后恢复", async () => {
    const { env } = makeEnv();
    const ip = "1.2.3.4";

    expect((await checkLoginAllowed(env, ip)).ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(env, ip);
    }
    const blocked = await checkLoginAllowed(env, ip);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);

    await clearLoginFailures(env, ip);
    expect((await checkLoginAllowed(env, ip)).ok).toBe(true);
  });

  it("窗口过期后重新计数（不会永久锁定）", async () => {
    const { env, fake } = makeEnv();
    const ip = "5.6.7.8";
    fake.state.attempts.set(ip, {
      fail_count: 99,
      window_start: Math.floor(Date.now() / 1000) - 600, // 10 分钟前
    });

    expect((await checkLoginAllowed(env, ip)).ok).toBe(true);
  });

  it("失败落在旧窗口内才累加，跨窗口重置为 1", async () => {
    const { env, fake } = makeEnv();
    const ip = "9.9.9.9";
    fake.state.attempts.set(ip, {
      fail_count: 4,
      window_start: Math.floor(Date.now() / 1000) - 10, // 10 秒前，窗口内
    });
    await recordLoginFailure(env, ip);
    expect(fake.state.attempts.get(ip)!.fail_count).toBe(5);
  });
});
