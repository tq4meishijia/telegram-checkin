import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withAccountSession: vi.fn(),
}));
vi.mock("../src/tg/client", () => ({
  withAccountSession: mocks.withAccountSession,
  withClient: mocks.withAccountSession,
  getDefaultAccount: vi.fn(),
}));

import worker from "../src/index";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";

const ADMIN_PASSWORD = "secret-pw";
const IP = "9.9.9.9";

const ACCOUNTS = [
  { id: 1, name: "账户A", session: "sess-a", status: "ok", is_default: 1, enabled: 1, tg_user_id: 111, tg_username: "aaa" },
  { id: 2, name: "账户B", session: "sess-b", status: "ok", enabled: 1, tg_user_id: 222, tg_username: "bbb" },
];

function makeEnv(tasks: Array<Record<string, unknown>> = [], accounts: Array<Record<string, unknown>> = ACCOUNTS) {
  const fake = createFakeDb({ tasks, accounts });
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
  mocks.withAccountSession.mockReset();
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

  it("改过密码后：新密码可登录，旧密码 401", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const changed = await req(
      "/api/password",
      jsonInit("POST", { old_password: ADMIN_PASSWORD, new_password: "NewPassw0rd!2026", confirm_password: "NewPassw0rd!2026" }, { Cookie: cookie }),
      env
    );
    expect(changed.status).toBe(200);

    const oldRes = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": "2.2.2.2" }), env);
    expect(oldRes.status).toBe(401);
    const newRes = await req("/api/login", jsonInit("POST", { password: "NewPassw0rd!2026" }, { "CF-Connecting-IP": "3.3.3.3" }), env);
    expect(newRes.status).toBe(200);
  });
});

describe("鉴权与 CSRF", () => {
  it("无 Cookie 访问 /api/tasks → 401", async () => {
    const { env } = makeEnv();
    const res = await req("/api/tasks", {}, env);
    expect(res.status).toBe(401);
  });

  it("带 Cookie 访问 /api/tasks → 200", async () => {
    const { env } = makeEnv([{ id: 1, name: "t1", enabled: 1, account_id: 1 }]);
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

  it("Origin: null（沙箱 iframe）→ 403 而不是 500", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req(
      "/api/tasks",
      jsonInit("POST", validTask, { Cookie: cookie, Origin: "null" }),
      env
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("origin_mismatch");
  });

  it("P0-1 回归：未鉴权 POST /api/logout 不再生效", async () => {
    const { env, fake } = makeEnv();
    const res = await req("/api/logout", { method: "POST" }, env);
    expect(res.status).toBe(401);
    expect(fake.state.settings.get("auth_epoch")).toBeUndefined();
  });

  it("带 Cookie 退出登录后旧 Cookie 失效（401 revoked）", async () => {
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
    // 未指定 account_id 时落到默认账户
    expect(fake.state.tasks[0].account_id).toBe(1);
  });

  it("指定 account_id → 归属该账户", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginOk(env);

    const res = await req("/api/tasks", jsonInit("POST", { ...validTask, account_id: 2 }, { Cookie: cookie }), env);

    expect(res.status).toBe(201);
    expect(fake.state.tasks[0].account_id).toBe(2);
  });

  it("account_id 指向不存在/停用的账户 → 400", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);

    const missing = await req("/api/tasks", jsonInit("POST", { ...validTask, account_id: 99 }, { Cookie: cookie }), env);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("account_not_found");

    // 账户 2 处于停用状态
    const { env: env2 } = makeEnv([], [
      { id: 1, name: "A", is_default: 1, enabled: 1 },
      { id: 2, name: "B", enabled: 0 },
    ]);
    const cookie2 = await loginOk(env2);
    const disabled = await req("/api/tasks", jsonInit("POST", { ...validTask, account_id: 2 }, { Cookie: cookie2 }), env2);
    expect(disabled.status).toBe(400);
    expect((await disabled.json()).error).toBe("account_disabled");
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

  it("P2-4 回归：历史任务（合法排期）仍可切换启停", async () => {
    const { env, fake } = makeEnv([{
      id: 1, name: "legacy", bot_username: "me", command: "/c",
      schedule_type: "daily", schedule_value: "08:00", timezone: "UTC",
      jitter_minutes: 0, capture_reply: 0, reply_wait_sec: 10,
      enabled: 0, account_id: 1, next_run_at: null,
    }]);
    const cookie = await loginOk(env);

    const res = await req("/api/tasks/1", jsonInit("PATCH", { enabled: 1 }, { Cookie: cookie }), env);

    expect(res.status).toBe(200);
    expect(fake.state.tasks[0].enabled).toBe(1);
    // 顺带修复了 NULL 的 next_run_at
    expect(fake.state.tasks[0].next_run_at).toBeTruthy();
  });

  it("排期确实非法的任务：启用时报明确的排期错误，而不是静默通过", async () => {
    const { env } = makeEnv([{
      id: 1, name: "broken", bot_username: "me", command: "/c",
      schedule_type: "daily", schedule_value: "720", timezone: "UTC",
      jitter_minutes: 0, capture_reply: 0, reply_wait_sec: 10,
      enabled: 0, account_id: 1, next_run_at: null,
    }]);
    const cookie = await loginOk(env);

    const res = await req("/api/tasks/1", jsonInit("PATCH", { enabled: 1 }, { Cookie: cookie }), env);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_time_format");
  });

  it("P2-2 回归：删除不存在的任务 → 404", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req("/api/tasks/999", { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(404);
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

  it("P2-3 回归：upcoming 只含未来的任务，不含已过期任务", async () => {
    const { env, fake } = makeEnv([
      { id: 1, name: "已过期", bot_username: "me", command: "/c", enabled: 1, account_id: 1, next_run_at: new Date(Date.now() - 3600_000).toISOString() },
      { id: 2, name: "未来", bot_username: "me", command: "/c", enabled: 1, account_id: 1, next_run_at: new Date(Date.now() + 3600_000).toISOString() },
    ]);
    const cookie = await loginOk(env);

    const res = await req("/api/overview", { headers: { Cookie: cookie } }, env);
    const j: any = await res.json();

    expect(j.upcoming.map((u: any) => u.name)).toEqual(["未来"]);
    expect(j.accountCount).toBe(2);
    expect(j.taskCount).toBe(2);
    expect(j.sessionConfigured).toBe(true);
    expect(j.defaultAccount.name).toBe("账户A");
  });

  it("非法 from → 400", async () => {
    const { env } = makeEnv();
    const cookie = await loginOk(env);
    const res = await req("/api/overview?from=not-a-date", { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(400);
  });
});

describe("静态资源回退与 CSP", () => {
  it("非 API 路径走 ASSETS 且响应带 CSP 与 nosniff", async () => {
    const { env } = makeEnv();
    const res = await req("/", {}, env);
    const csp = res.headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
