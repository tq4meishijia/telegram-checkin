import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withClient: vi.fn(),
}));
vi.mock("../src/tg/client", () => ({ withClient: mocks.withClient, withSession: mocks.withClient }));

import worker from "../src/index";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";

const ADMIN_PASSWORD = "secret-pw";
const IP = "9.9.9.9";

function makeEnv(tasks: Array<Record<string, unknown>> = []) {
  const fake = createFakeDb({ tasks });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("<html>fallback</html>", { status: 404 }) },
    TG_API_ID: "12345",
    TG_API_HASH: "hash",
    ADMIN_PASSWORD,
  } as unknown as Env;
  return { env, fake };
}

function req(path: string, init: RequestInit = {}, env: Env): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, init), env, {} as any);
}

function jsonInit(method: string, body?: unknown, extra: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("Set-Cookie") || "";
  const m = setCookie.match(/auth=([^;]+)/);
  return m ? `auth=${m[1]}` : "";
}

async function loginOk(env: Env, password = ADMIN_PASSWORD, ip = IP): Promise<string> {
  const res = await req(
    "/api/login",
    jsonInit("POST", { password }, { "CF-Connecting-IP": ip }),
    env
  );
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const validTask = {
  name: "每日签到",
  bot_username: "me",
  command: "/checkin",
  schedule_type: "daily",
  schedule_value: "08:00",
  timezone: "Asia/Shanghai",
  jitter_minutes: 0,
  capture_reply: 0,
  reply_wait_sec: 10,
  enabled: 1,
};

beforeEach(() => {
  mocks.withClient.mockReset();
});

describe("POST /api/login", () => {
  it("正确密码 → 200 并种 HttpOnly Cookie", async () => {
    const { env } = makeEnv();
    const res = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": IP }), env);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain("auth=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure"); // 本地 http 开发环境
  });

  it("错误密码 → 401 invalid_password", async () => {
    const { env } = makeEnv();
    const res = await req("/api/login", jsonInit("POST", { password: "wrong" }, { "CF-Connecting-IP": "1.1.1.1" }), env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_password");
  });

  it("畸形 JSON → 400 invalid_json", async () => {
    const { env } = makeEnv();
    const res = await req(
      "/api/login",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json" },
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("同一 IP 连续 5 次失败后 → 429 too_many_attempts", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 5; i++) {
      const res = await req("/api/login", jsonInit("POST", { password: "wrong" }, { "CF-Connecting-IP": IP }), env);
      expect(res.status).toBe(401);
    }
    const blocked = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": IP }), env);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("too_many_attempts");

    // 换个 IP 不受影响
    const other = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": "8.8.8.8" }), env);
    expect(other.status).toBe(200);
  });

  it("登录成功后清除该 IP 的失败计数", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 3; i++) {
      await req("/api/login", jsonInit("POST", { password: "wrong" }, { "CF-Connecting-IP": IP }), env);
    }
    const ok = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": IP }), env);
    expect(ok.status).toBe(200);
    // 再失败 4 次不应被锁（计数已清）
    for (let i = 0; i < 4; i++) {
      const res = await req("/api/login", jsonInit("POST", { password: "wrong" }, { "CF-Connecting-IP": IP }), env);
      expect(res.status).toBe(401);
    }
  });
});

describe("鉴权与 CSRF", () => {
  it("无 Cookie 访问 /api/tasks → 401", async () => {
    const { env } = makeEnv();
    const res = await req("/api/tasks", {}, env);
    expect(res.status).toBe(401);
  });

  it("带 Cookie 访问 /api/tasks → 200", async () => {
    const { env } = makeEnv([{ id: 1, name: "t1", enabled: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/tasks", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).tasks).toHaveLength(1);
  });

  it("跨站 Origin 的 POST → 403 origin_mismatch", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req(
      "/api/tasks",
      jsonInit("POST", validTask, { Cookie: cookie, Origin: "http://evil.com" }),
      env
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("origin_mismatch");
  });

  it("退出登录后旧 Cookie 失效（401 revoked）", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);

    const out = await req("/api/logout", jsonInit("POST", undefined, { Cookie: cookie }), env);
    expect(out.status).toBe(200);

    const res = await req("/api/tasks", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("revoked");
  });
});

describe("任务创建校验", () => {
  it("合法 body → 201 且 next_run_at 非空", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginOk(env);

    const res = await req("/api/tasks", jsonInit("POST", validTask, { Cookie: cookie }), env);

    expect(res.status).toBe(201);
    expect(fake.state.tasks).toHaveLength(1);
    expect(fake.state.tasks[0].next_run_at).toBeTruthy();
  });

  it("jitter_minutes 传字符串 → 400 invalid_jitter_minutes", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req(
      "/api/tasks",
      jsonInit("POST", { ...validTask, jitter_minutes: "abc" }, { Cookie: cookie }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_jitter_minutes");
  });

  it("daily 配分钟数 → 400 invalid_time_format", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req(
      "/api/tasks",
      jsonInit("POST", { ...validTask, schedule_value: "720" }, { Cookie: cookie }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_time_format");
  });

  it("畸形 JSON → 400 invalid_json", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req(
      "/api/tasks",
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{" },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/logs 参数收敛", () => {
  it("limit=abc → 默认 50；limit=-1 → 收敛为 1；limit=9999 → 收敛为 100", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);

    for (const q of ["limit=abc", "limit=-1", "limit=9999", "limit="]) {
      const res = await req(`/api/logs?${q}`, { headers: { Cookie: cookie } }, env);
      expect(res.status).toBe(200);
    }

    const bad = await req("/api/logs?task_id=abc", { headers: { Cookie: cookie } }, env);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_task_id");
  });
});

describe("GET /api/overview 统计区间", () => {
  it("按 from/to（本地日界）统计，缺省按 UTC 日界", async () => {
    const { env, fake } = makeEnv();
    fake.state.logs.push({
      id: 1,
      task_id: 1,
      status: "success",
      detail: "",
      duration_ms: 10,
      created_at: "2026-10-24 01:00:00",
    });
    const cookie = await loginOk(env);

    const from = new Date("2026-10-23T16:00:00Z").toISOString(); // = UTC+8 的 10-24 00:00
    const to = new Date("2026-10-24T16:00:00Z").toISOString();
    const ranged = await req(
      `/api/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { Cookie: cookie } },
      env
    );
    expect(ranged.status).toBe(200);
    expect((await ranged.json()).today.success).toBe(1);

    // 区间外：from 晚于日志时间 → 计数 0
    const outside = await req(
      `/api/overview?from=${encodeURIComponent(new Date("2026-10-25T00:00:00Z").toISOString())}`,
      { headers: { Cookie: cookie } },
      env
    );
    expect((await outside.json()).today.success).toBe(0);
  });

  it("非法 from → 400", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req("/api/overview?from=not-a-date", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(400);
  });
});

describe("静态资源回退与 CSP", () => {
  it("非 API 路径走 ASSETS 且响应带 CSP 头", async () => {
    const { env } = makeEnv();
    const res = await req("/", {}, env);
    const csp = res.headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});
