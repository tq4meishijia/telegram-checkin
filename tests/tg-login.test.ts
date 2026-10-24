/**
 * 网页交互式 Telegram 登录（手机号 → 验证码 → 两步密码）的路由层测试。
 *
 * 策略：只替换「驱动层」（真正连 Telegram 的那一层），
 * 路由的校验、流程生命周期、错误映射、落库与鉴权全部走真实实现。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const tg = vi.hoisted(() => ({
  sendCode: vi.fn(),
  signIn: vi.fn(),
  checkPassword: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("../src/tg/login-flow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tg/login-flow")>();
  return {
    ...actual, // LoginError / mapTelegramError 等保持真实实现
    createGramDriver: () => ({
      sendCode: tg.sendCode,
      signIn: tg.signIn,
      checkPassword: tg.checkPassword,
      getMe: tg.getMe,
    }),
  };
});

import worker from "../src/index";
import { createFakeDb } from "./helpers/fake-db";
import type { Env } from "../src/bindings";
import { LoginError, mapTelegramError } from "../src/tg/login-flow";
import { normalizeCode, normalizePhone } from "../src/api/login";

const ADMIN_PASSWORD = "secret-pw";
const IP = "9.9.9.9";
const FLOW_ID = "11111111-2222-3333-4444-555555555555";

/** 与 0003 迁移一致：一个从未配置 session 的占位默认账户 */
const PLACEHOLDER = [{ id: 1, name: "默认账户", session: "", status: "unknown", is_default: 1, enabled: 1 }];

function makeEnv(accounts: Array<Record<string, unknown>> = PLACEHOLDER) {
  const fake = createFakeDb({ accounts });
  const env = {
    DB: fake.db,
    ASSETS: { fetch: async () => new Response("fallback", { status: 404 }) },
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

async function loginCookie(env: Env, ip = IP): Promise<string> {
  const res = await req("/api/login", jsonInit("POST", { password: ADMIN_PASSWORD }, { "CF-Connecting-IP": ip }), env);
  expect(res.status).toBe(200);
  const m = (res.headers.get("Set-Cookie") || "").match(/auth=([^;]+)/);
  return `auth=${m![1]}`;
}

/** 走到「验证码已发送」这一步，返回 flow_id */
async function startedFlow(env: Env, cookie: string, phone = "8613800138000"): Promise<string> {
  tg.sendCode.mockResolvedValue({ session: "UNAUTH_SESSION", phoneCodeHash: "HASH1", isCodeViaApp: true });
  const res = await req("/api/accounts/login/start", jsonInit("POST", { phone }, { Cookie: cookie }), env);
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.flow_id;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("网页登录：完整链路", () => {
  it("手机号 → 验证码 → 保存为账户（无两步验证）", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    // 手机号归一化后传给驱动；流程落库且带未授权 session
    expect(tg.sendCode).toHaveBeenCalledWith("+8613800138000", {});
    expect(fake.state.flows).toHaveLength(1);
    expect(fake.state.flows[0]).toMatchObject({
      id: flowId,
      phone: "+8613800138000",
      phone_code_hash: "HASH1",
      session: "UNAUTH_SESSION",
      stage: "code",
      attempts: 0,
    });

    // 状态查询
    const status = await req(`/api/accounts/login/${flowId}`, { headers: { Cookie: cookie } }, env);
    expect(status.status).toBe(200);
    expect((await status.json()).stage).toBe("code");

    tg.signIn.mockResolvedValue({
      session: "AUTH_SESSION",
      user: { id: "777", username: "zhangsan", firstName: "张三" },
      needPassword: false,
    });
    const codeRes = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }),
      env
    );
    expect(codeRes.status).toBe(200);
    const codeBody = await codeRes.json();
    expect(codeBody.stage).toBe("ready");
    expect(codeBody.user).toMatchObject({ id: "777", username: "zhangsan", first_name: "张三" });
    // 驱动拿到的是流程里保存的同一份 session + phoneCodeHash
    expect(tg.signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: "UNAUTH_SESSION",
        phone: "+8613800138000",
        phoneCodeHash: "HASH1",
        code: "12345",
      })
    );

    const fin = await req(
      "/api/accounts/login/finish",
      jsonInit("POST", { flow_id: flowId, name: "小号" }, { Cookie: cookie }),
      env
    );
    expect(fin.status).toBe(201);
    const account = (await fin.json()).account;
    expect(account.name).toBe("小号");
    expect(account.tg_username).toBe("zhangsan");
    expect(account.status).toBe("ok");
    // 对外投影绝不含 session
    expect(account.session).toBeUndefined();
    expect(JSON.stringify(account)).not.toContain("AUTH_SESSION");

    // 已登录的 session 落库；占位账户无 session → 新账户接管默认位
    const created = fake.state.accounts.find((a) => Number(a.tg_user_id) === 777);
    expect(created!.session).toBe("AUTH_SESSION");
    expect(created!.is_default).toBe(1);
    expect(fake.state.accounts.filter((a) => Number(a.is_default) === 1)).toHaveLength(1);
    // 流程用完即删
    expect(fake.state.flows).toHaveLength(0);
  });

  it("账户名留空时用 @username 兜底", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    tg.signIn.mockResolvedValue({ session: "S", user: { id: "888", username: "abc", firstName: null }, needPassword: false });
    await req("/api/accounts/login/code", jsonInit("POST", { flow_id: flowId, code: "11111" }, { Cookie: cookie }), env);

    const fin = await req(
      "/api/accounts/login/finish",
      jsonInit("POST", { flow_id: flowId }, { Cookie: cookie }),
      env
    );
    expect(fin.status).toBe(201);
    expect((await fin.json()).account.name).toBe("@abc");
    expect(fake.state.accounts.some((a) => a.name === "@abc")).toBe(true);
  });

  it("开启两步验证：验证码后进入密码步骤，密码通过才算登录", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    tg.signIn.mockResolvedValue({ session: "SESSION_2FA", user: null, needPassword: true });
    const codeRes = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }),
      env
    );
    expect(codeRes.status).toBe(200);
    expect((await codeRes.json()).need_password).toBe(true);
    expect(fake.state.flows[0].stage).toBe("password");
    // 密码步骤用 signIn 返回的新 session 继续
    expect(fake.state.flows[0].session).toBe("SESSION_2FA");

    // 此阶段再提交验证码 → 明确提示需要密码
    const again = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }),
      env
    );
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("password_required");

    tg.checkPassword.mockResolvedValue({
      session: "AUTH_2FA",
      user: { id: "999", username: null, firstName: "李四" },
    });
    const pw = await req(
      "/api/accounts/login/password",
      jsonInit("POST", { flow_id: flowId, password: "my-2fa-pass" }, { Cookie: cookie }),
      env
    );
    expect(pw.status).toBe(200);
    expect((await pw.json()).stage).toBe("ready");
    expect(tg.checkPassword).toHaveBeenCalledWith(expect.objectContaining({ session: "SESSION_2FA", password: "my-2fa-pass" }));
    expect(fake.state.flows[0].stage).toBe("ready");

    const fin = await req(
      "/api/accounts/login/finish",
      jsonInit("POST", { flow_id: flowId, name: "两步号" }, { Cookie: cookie }),
      env
    );
    expect(fin.status).toBe(201);
    expect(fake.state.accounts.find((a) => a.name === "两步号")!.session).toBe("AUTH_2FA");
  });
});

describe("网页登录：输入校验", () => {
  it("手机号非法一律 400 invalid_phone，且不会调用驱动", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    for (const bad of ["", "abc", "123", "+0123456789", "+", "++8613800138000"]) {
      const res = await req("/api/accounts/login/start", jsonInit("POST", { phone: bad }, { Cookie: cookie }), env);
      expect(res.status, `phone=${bad}`).toBe(400);
      expect((await res.json()).error).toBe("invalid_phone");
    }
    expect(tg.sendCode).not.toHaveBeenCalled();
  });

  it("手机号归一化：去分隔符、补 + 号", async () => {
    expect(normalizePhone("+86 138 0013 8000")).toBe("+8613800138000");
    expect(normalizePhone("(86)-138-0013-8000")).toBe("+8613800138000");
    expect(normalizePhone("8613800138000")).toBe("+8613800138000");
    expect(normalizePhone("+1 415 555 0100")).toBe("+14155550100");
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone(123)).toBeNull();
  });

  it("验证码格式非法 → 400 invalid_code_format", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    for (const bad of ["", "12", "abcdef", "12345678901"]) {
      const res = await req(
        "/api/accounts/login/code",
        jsonInit("POST", { flow_id: flowId, code: bad }, { Cookie: cookie }),
        env
      );
      expect(res.status, `code=${bad}`).toBe(400);
      expect((await res.json()).error).toBe("invalid_code_format");
    }
    expect(normalizeCode(" 123 45 ")).toBe("12345");
    expect(normalizeCode("12")).toBeNull();
  });

  it("流程不存在 / id 畸形 → 404", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    for (const id of ["00000000-0000-0000-0000-000000000000", "not-a-uuid", ""]) {
      const res = await req(
        "/api/accounts/login/code",
        jsonInit("POST", { flow_id: id, code: "12345" }, { Cookie: cookie }),
        env
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("flow_not_found");
    }
  });

  it("流程过期 → 400 flow_expired 并删除流程", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    fake.state.flows.push({
      id: FLOW_ID,
      phone: "+8613800138000",
      phone_code_hash: "H",
      session: "S",
      api_id: "",
      api_hash: "",
      stage: "code",
      attempts: 0,
      expires_at: "2020-01-01 00:00:00",
    });

    const res = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: FLOW_ID, code: "12345" }, { Cookie: cookie }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("flow_expired");
    expect(fake.state.flows).toHaveLength(0);
    expect(tg.signIn).not.toHaveBeenCalled();
  });

  it("阶段不符：code 阶段提交密码 → 400 invalid_stage", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    const res = await req(
      "/api/accounts/login/password",
      jsonInit("POST", { flow_id: flowId, password: "x" }, { Cookie: cookie }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_stage");
  });

  it("未到 ready 阶段不能 finish", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);

    const res = await req(
      "/api/accounts/login/finish",
      jsonInit("POST", { flow_id: flowId, name: "x" }, { Cookie: cookie }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_stage");
    expect(fake.state.accounts).toHaveLength(1); // 没有新增
  });
});

describe("网页登录：错误处理与防爆破", () => {
  it("验证码错误累加尝试次数，5 次后作废流程", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    tg.signIn.mockRejectedValue(new LoginError("invalid_code", 400));

    for (let i = 1; i <= 5; i++) {
      const res = await req(
        "/api/accounts/login/code",
        jsonInit("POST", { flow_id: flowId, code: "00000" }, { Cookie: cookie }),
        env
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_code");
      expect(fake.state.flows[0].attempts).toBe(i);
    }

    // 第 6 次：流程直接作废
    const blocked = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: flowId, code: "00000" }, { Cookie: cookie }),
      env
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("too_many_attempts");
    expect(fake.state.flows).toHaveLength(0);
  });

  it("验证码过期会直接清掉流程", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    tg.signIn.mockRejectedValue(new LoginError("code_expired", 400));

    const res = await req(
      "/api/accounts/login/code",
      jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }),
      env
    );
    expect((await res.json()).error).toBe("code_expired");
    expect(fake.state.flows).toHaveLength(0);
  });

  it("重复账号 → 409 duplicate_account", async () => {
    const { env, fake } = makeEnv([
      ...PLACEHOLDER,
      { id: 2, name: "已有", session: "s", status: "ok", enabled: 1, tg_user_id: 777 },
    ]);
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    tg.signIn.mockResolvedValue({ session: "S", user: { id: "777", username: "dup", firstName: null }, needPassword: false });
    await req("/api/accounts/login/code", jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }), env);

    const fin = await req(
      "/api/accounts/login/finish",
      jsonInit("POST", { flow_id: flowId, name: "重复" }, { Cookie: cookie }),
      env
    );
    expect(fin.status).toBe(409);
    const body = await fin.json();
    expect(body.error).toBe("duplicate_account");
    expect(body.existing.name).toBe("已有");
    expect(fake.state.accounts).toHaveLength(2); // 没新增
  });

  it("取消流程会清掉未授权 session", async () => {
    const { env, fake } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    expect(fake.state.flows).toHaveLength(1);

    const res = await req(`/api/accounts/login/${flowId}`, { method: "DELETE", headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect(fake.state.flows).toHaveLength(0);
  });

  it("Telegram 错误被映射成稳定错误码（不透传原始 RPC 错误名）", () => {
    expect(mapTelegramError({ errorMessage: "PHONE_CODE_INVALID" })).toMatchObject({ code: "invalid_code", status: 400 });
    expect(mapTelegramError({ errorMessage: "PHONE_NUMBER_BANNED" })).toMatchObject({ code: "phone_banned", status: 400 });
    expect(mapTelegramError({ errorMessage: "FLOOD_WAIT_42" })).toMatchObject({ code: "flood_wait", status: 429, retryAfterSec: 42 });
    expect(mapTelegramError({ errorMessage: "PASSWORD_HASH_INVALID" })).toMatchObject({ code: "invalid_2fa_password", status: 400 });
    expect(mapTelegramError(new Error("boom"))).toMatchObject({ code: "tg_error", status: 502 });
    // 网络类错误单独归类，便于前端提示查网络
    expect(mapTelegramError(new Error("timeout_25000ms"))).toMatchObject({ code: "network_error", status: 502 });
    // LoginError 原样返回（不重复包装）
    const own = new LoginError("custom", 418);
    expect(mapTelegramError(own)).toBe(own);
  });
});

describe("网页登录：鉴权与信息暴露", () => {
  it("所有登录端点都要求鉴权（匿名 401）", async () => {
    const { env } = makeEnv();
    const cases: Array<[string, string]> = [
      ["POST", "/api/accounts/login/start"],
      ["POST", "/api/accounts/login/code"],
      ["POST", "/api/accounts/login/password"],
      ["POST", "/api/accounts/login/finish"],
      ["GET", `/api/accounts/login/${FLOW_ID}`],
      ["DELETE", `/api/accounts/login/${FLOW_ID}`],
    ];
    for (const [method, path] of cases) {
      // GET/DELETE 不能带 body，否则 Request 构造阶段就抛错
      const init: RequestInit = method === "GET" || method === "DELETE" ? { method } : jsonInit(method, {});
      const res = await req(path, init, env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(tg.sendCode).not.toHaveBeenCalled();
  });

  it("账户列表接口不会带出 session（含网页登录写入的那份）", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    tg.signIn.mockResolvedValue({ session: "SECRET_SESSION_VALUE", user: { id: "321", username: "u", firstName: null }, needPassword: false });
    await req("/api/accounts/login/code", jsonInit("POST", { flow_id: flowId, code: "12345" }, { Cookie: cookie }), env);
    await req("/api/accounts/login/finish", jsonInit("POST", { flow_id: flowId, name: "n" }, { Cookie: cookie }), env);

    const list = await req("/api/accounts", { headers: { Cookie: cookie } }, env);
    const text = await list.text();
    expect(list.status).toBe(200);
    expect(text).not.toContain("SECRET_SESSION_VALUE");
  });

  it("流程状态接口不会回传 session", async () => {
    const { env } = makeEnv();
    const cookie = await loginCookie(env);
    const flowId = await startedFlow(env, cookie);
    const res = await req(`/api/accounts/login/${flowId}`, { headers: { Cookie: cookie } }, env);
    const text = await res.text();
    expect(text).not.toContain("UNAUTH_SESSION");
  });
});
