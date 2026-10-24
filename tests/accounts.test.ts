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

function makeEnv(accounts: Array<Record<string, unknown>> = [], tasks: Array<Record<string, unknown>> = []) {
  const fake = createFakeDb({ accounts, tasks });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("") },
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
  const m = (res.headers.get("Set-Cookie") || "").match(/auth=([^;]+)/);
  return m ? `auth=${m[1]}` : "";
}

async function loginOk(env: Env, ip = "9.9.9.9"): Promise<string> {
  const res = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": ip }), env);
  expect(res.status).toBe(200);
  return cookieOf(res);
}

/** 让 Telegram 连接返回指定账号信息 */
function mockTelegramUser(user: { id: number; username?: string; firstName?: string }) {
  mocks.withAccountSession.mockImplementation(async (_env: unknown, _cred: any, fn: any) =>
    fn({ getMe: async () => user })
  );
}

beforeEach(() => {
  mocks.withAccountSession.mockReset();
});

describe("GET /api/accounts", () => {
  it("未登录 → 401", async () => {
    const { env } = makeEnv();
    const res = await req("/api/accounts", {}, env);
    expect(res.status).toBe(401);
  });

  it("列表不含 session 字符串", async () => {
    const { env } = makeEnv([{ id: 1, name: "A", session: "SUPER_SECRET_SESSION", is_default: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts", { headers: { Cookie: cookie } }, env);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain("SUPER_SECRET_SESSION");
    const j = JSON.parse(text);
    expect(j.accounts).toHaveLength(1);
    expect(j.accounts[0].name).toBe("A");
  });
});

describe("POST /api/accounts — 添加账户", () => {
  it("合法 session → 201，自动成为默认账户（首个）", async () => {
    const { env, fake } = makeEnv();
    mockTelegramUser({ id: 111, username: "aaa" });
    const cookie = await loginOk(env);

    const res = await req(
      "/api/accounts",
      jsonInit("POST", { name: "小号A", session: "valid-session" }, { Cookie: cookie }),
      env
    );

    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.account.name).toBe("小号A");
    expect(j.account.status).toBe("ok");
    expect(j.account.tg_username).toBe("aaa");
    expect(Number(j.account.is_default)).toBe(1);
    expect(fake.state.accounts[0].session).toBe("valid-session");
    expect(JSON.stringify(j)).not.toContain("valid-session");
  });

  it("占位默认账户（无 session）存在时，新账户自动接管默认位", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "默认账户", session: "", is_default: 1 }]);
    mockTelegramUser({ id: 222, username: "bbb" });
    const cookie = await loginOk(env);

    const res = await req(
      "/api/accounts",
      jsonInit("POST", { name: "真实账户", session: "real-session" }, { Cookie: cookie }),
      env
    );

    expect(res.status).toBe(201);
    const def = fake.state.accounts.filter((a) => Number(a.is_default) === 1);
    expect(def).toHaveLength(1);
    expect(def[0].name).toBe("真实账户");
  });

  it("第二个账户不抢占默认位", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "A", session: "s1", is_default: 1 }]);
    mockTelegramUser({ id: 222, username: "bbb" });
    const cookie = await loginOk(env);

    await req("/api/accounts", jsonInit("POST", { name: "B", session: "s2" }, { Cookie: cookie }), env);

    const def = fake.state.accounts.filter((a) => Number(a.is_default) === 1);
    expect(def).toHaveLength(1);
    expect(def[0].id).toBe(1);
  });

  it("session 无效（连接失败）→ 400 且不写入", async () => {
    const { env, fake } = makeEnv();
    mocks.withAccountSession.mockImplementation(async () => { throw new Error("AUTH_KEY_UNREGISTERED"); });
    const cookie = await loginOk(env);

    const res = await req(
      "/api/accounts",
      jsonInit("POST", { name: "坏账户", session: "bad-session" }, { Cookie: cookie }),
      env
    );

    expect(res.status).toBe(400);
    expect(fake.state.accounts).toHaveLength(0);
  });

  it("重复登录同一 Telegram 账号 → 409 duplicate_account", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "A", session: "s1", tg_user_id: 111, is_default: 1 }]);
    mockTelegramUser({ id: 111, username: "aaa" });
    const cookie = await loginOk(env);

    const res = await req(
      "/api/accounts",
      jsonInit("POST", { name: "同一个号", session: "s1-again" }, { Cookie: cookie }),
      env
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate_account");
    expect(fake.state.accounts).toHaveLength(1);
  });

  it("缺少 session / 名称 → 400", async () => {
    const { env } = makeEnv();
    mockTelegramUser({ id: 1 });
    const cookie = await loginOk(env);

    const noSession = await req("/api/accounts", jsonInit("POST", { name: "x" }, { Cookie: cookie }), env);
    expect(noSession.status).toBe(400);
    expect((await noSession.json()).error).toBe("invalid_session");

    const noName = await req("/api/accounts", jsonInit("POST", { session: "abc" }, { Cookie: cookie }), env);
    expect(noName.status).toBe(400);
    expect((await noName.json()).error).toBe("invalid_name");
  });
});

describe("POST /api/accounts/:id/verify — 状态刷新", () => {
  it("验证成功 → status=ok", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "A", session: "s1", status: "invalid", is_default: 1 }]);
    mockTelegramUser({ id: 111, username: "aaa" });
    const cookie = await loginOk(env);

    const res = await req("/api/accounts/1/verify", { method: "POST", headers: { Cookie: cookie } }, env);

    expect(res.status).toBe(200);
    expect(fake.state.accounts[0].status).toBe("ok");
    expect(fake.state.accounts[0].last_error).toBeNull();
  });

  it("验证失败 → status=invalid 且带错误信息", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "A", session: "s1", status: "ok", is_default: 1 }]);
    mocks.withAccountSession.mockImplementation(async () => { throw new Error("SESSION_REVOKED"); });
    const cookie = await loginOk(env);

    const res = await req("/api/accounts/1/verify", { method: "POST", headers: { Cookie: cookie } }, env);

    expect(res.status).toBe(400);
    expect(fake.state.accounts[0].status).toBe("invalid");
    expect(fake.state.accounts[0].last_error).toBe("SESSION_REVOKED");
  });

  it("不存在的账户 → 404", async () => {
    const { env } = makeEnv([{ id: 1, name: "A", session: "s1", is_default: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/99/verify", { method: "POST", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/accounts/:id/switch — 切换默认账户", () => {
  it("切换后默认唯一", async () => {
    const { env, fake } = makeEnv([
      { id: 1, name: "A", session: "s1", is_default: 1 },
      { id: 2, name: "B", session: "s2" },
    ]);
    const cookie = await loginOk(env);

    const res = await req("/api/accounts/2/switch", { method: "POST", headers: { Cookie: cookie } }, env);

    expect(res.status).toBe(200);
    const def = fake.state.accounts.filter((a) => Number(a.is_default) === 1);
    expect(def).toHaveLength(1);
    expect(def[0].id).toBe(2);
  });

  it("停用的账户不能设为默认", async () => {
    const { env } = makeEnv([
      { id: 1, name: "A", session: "s1", is_default: 1 },
      { id: 2, name: "B", session: "s2", enabled: 0 },
    ]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/2/switch", { method: "POST", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("account_disabled");
  });
});

describe("PATCH /api/accounts/:id", () => {
  it("停用默认账户 → 400 cannot_disable_default", async () => {
    const { env } = makeEnv([
      { id: 1, name: "A", session: "s1", is_default: 1 },
      { id: 2, name: "B", session: "s2" },
    ]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/1", jsonInit("PATCH", { enabled: 0 }, { Cookie: cookie }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_disable_default");
  });

  it("改名成功", async () => {
    const { env, fake } = makeEnv([{ id: 1, name: "A", session: "s1", is_default: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/1", jsonInit("PATCH", { name: "新名字" }, { Cookie: cookie }), env);
    expect(res.status).toBe(200);
    expect(fake.state.accounts[0].name).toBe("新名字");
  });

  it("改 session 会重新验证并查重", async () => {
    const { env, fake } = makeEnv([
      { id: 1, name: "A", session: "s1", is_default: 1 },
      { id: 2, name: "B", session: "s2", tg_user_id: 222 },
    ]);
    mockTelegramUser({ id: 222, username: "bbb" }); // 改成的 session 属于已被 B 占用的账号
    const cookie = await loginOk(env);

    const res = await req("/api/accounts/1", jsonInit("PATCH", { session: "s2" }, { Cookie: cookie }), env);

    expect(res.status).toBe(409);
    expect(fake.state.accounts[0].session).toBe("s1"); // 未被改写
  });
});

describe("DELETE /api/accounts/:id — 级联与边界", () => {
  it("删除账户连带删除其任务与日志", async () => {
    const { env, fake } = makeEnv(
      [
        { id: 1, name: "A", session: "s1", is_default: 1 },
        { id: 2, name: "B", session: "s2" },
      ],
      [
        { id: 1, name: "任务1", account_id: 1, enabled: 1, next_run_at: new Date(Date.now() + 60000).toISOString() },
        { id: 2, name: "任务2", account_id: 2, enabled: 1, next_run_at: new Date(Date.now() + 60000).toISOString() },
      ]
    );
    fake.state.logs.push({ id: 1, task_id: 1, status: "success", detail: "", duration_ms: 1, created_at: "2026-01-01 00:00:00" });
    const cookie = await loginOk(env);

    const res = await req("/api/accounts/1", { method: "DELETE", headers: { Cookie: cookie } }, env);

    expect(res.status).toBe(200);
    expect(fake.state.accounts.map((a) => a.id)).toEqual([2]);
    expect(fake.state.tasks.map((t) => t.id)).toEqual([2]);
    expect(fake.state.logs).toHaveLength(0);
    // 删掉的默认账户 → 剩余最小 id 接管
    expect(fake.state.accounts.find((a) => a.id === 2)!.is_default).toBe(1);
  });

  it("只剩一个账户时拒绝删除 → 400 last_account", async () => {
    const { env } = makeEnv([{ id: 1, name: "A", session: "s1", is_default: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/1", { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("last_account");
  });

  it("删除不存在的账户 → 404", async () => {
    const { env } = makeEnv([{ id: 1, name: "A", session: "s1", is_default: 1 }]);
    const cookie = await loginOk(env);
    const res = await req("/api/accounts/99", { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(404);
  });
});
