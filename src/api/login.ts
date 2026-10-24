import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../bindings";
import { safeJson, sqliteNow, withTimeout } from "../util";
import { ACCOUNT_COLS, shouldBecomeDefault } from "../account-shared";
import { LoginError, mapTelegramError, type LoginDriver } from "../tg/login-flow";

/**
 * 网页交互式登录：手机号 → 验证码 →（可选）两步验证密码 → 保存为账户。
 *
 * 三步之间的状态存在 login_flows 表（Worker 无状态，见 0004 迁移注释）。
 * 该路由必须挂在鉴权中间件之后——登录 Telegram 账号是管理员操作，
 * 匿名请求绝不能触达（否则任何人都能往你的账号列表里塞号 / 消耗你的验证码配额）。
 */

/** 流程有效期：10 分钟（够输入验证码，又不至于让未授权 session 长期躺在库里） */
const FLOW_TTL_MS = 10 * 60 * 1000;
/** 同一流程内验证码最多尝试 5 次，超过即作废（Telegram 侧还有 FLOOD_WAIT 兜底） */
const MAX_CODE_ATTEMPTS = 5;
/** 单次 Telegram 交互超时：sendCode 要做 DH 密钥交换，给足时间但不能无限挂 */
const TG_STEP_TIMEOUT_MS = 25000;

interface FlowRow {
  id: string;
  phone: string;
  phone_code_hash: string;
  session: string;
  api_id: string;
  api_hash: string;
  stage: string;
  attempts: number;
  tg_user_id: string | null;
  tg_username: string | null;
  expires_at: string;
}

/** 手机号归一化：去分隔符、补 `+`、校验长度。返回 null 表示非法。 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!/^\+?[1-9]\d{5,19}$/.test(cleaned)) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

/** 验证码归一化：纯数字 3-10 位（App 内验证码可能带空格） */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s/g, "");
  return /^\d{3,10}$/.test(cleaned) ? cleaned : null;
}

/** 账户级凭据：两者都给了才采用，否则回退 Worker Secret */
function readCred(body: Record<string, unknown>): { api_id?: string; api_hash?: string } {
  const id = typeof body.api_id === "string" ? body.api_id.trim() : "";
  const hash = typeof body.api_hash === "string" ? body.api_hash.trim() : "";
  if (!id && !hash) return {};
  if (!/^\d{3,10}$/.test(id) || !/^[a-fA-F0-9]{8,64}$/.test(hash)) {
    throw new LoginError("invalid_api_credentials", 400);
  }
  return { api_id: id, api_hash: hash };
}

function credOf(flow: FlowRow) {
  return flow.api_id && flow.api_hash ? { api_id: flow.api_id, api_hash: flow.api_hash } : {};
}

function isExpired(flow: FlowRow): boolean {
  // 两个值都是 SQLite datetime('now') 格式（UTC、空格、无 Z），可直接字符串比较
  return flow.expires_at <= sqliteNow();
}

function fail(c: Context<{ Bindings: Env }>, err: LoginError) {
  return c.json(
    { error: err.code, detail: err.detail, retry_after: err.retryAfterSec },
    err.status as 400 | 404 | 429 | 500 | 502
  );
}

export function createLoginRoutes(makeDriver: (env: Env) => LoginDriver): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  /** 读取并校验流程：不存在 / 已过期 / 阶段不符都在这里挡掉 */
  async function loadFlow(
    env: Env,
    rawId: unknown
  ): Promise<{ flow: FlowRow } | { error: "flow_not_found" | "flow_expired"; status: number }> {
    if (typeof rawId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(rawId)) {
      return { error: "flow_not_found", status: 404 };
    }
    const flow = await env.DB.prepare("SELECT * FROM login_flows WHERE id = ?").bind(rawId).first<FlowRow>();
    if (!flow) return { error: "flow_not_found", status: 404 };
    if (isExpired(flow)) {
      await env.DB.prepare("DELETE FROM login_flows WHERE id = ?").bind(flow.id).run();
      return { error: "flow_expired", status: 400 };
    }
    return { flow };
  }

  async function dropFlow(env: Env, id: string) {
    await env.DB.prepare("DELETE FROM login_flows WHERE id = ?").bind(id).run();
  }

  /** 登录成功后把 session 落成账户（查重 + 默认位接管） */
  async function persistAccount(
    env: Env,
    flow: FlowRow,
    name: string | undefined
  ): Promise<{ ok: true; account: unknown } | { ok: false; error: string; status: number; existing?: unknown }> {
    const userId = Number(flow.tg_user_id);
    if (!flow.tg_user_id || !Number.isFinite(userId)) {
      return { ok: false, error: "login_incomplete", status: 400 };
    }

    // 重复登录拦截：同一 Telegram 账号只允许绑定一次
    const dup = await env.DB.prepare("SELECT id, name FROM accounts WHERE tg_user_id = ?")
      .bind(userId)
      .first<{ id: number; name: string }>();
    if (dup) return { ok: false, error: "duplicate_account", status: 409, existing: dup };

    const finalName =
      (name && name.trim()) ||
      (flow.tg_username ? `@${flow.tg_username}` : flow.phone);

    const isDefault = (await shouldBecomeDefault(env)) ? 1 : 0;
    if (isDefault) {
      await env.DB.prepare("UPDATE accounts SET is_default = 0, updated_at = datetime('now')").run();
    }

    const result = await env.DB.prepare(
      `INSERT INTO accounts(name, session, api_id, api_hash, tg_user_id, tg_username, status, last_error, last_verified_at, is_default)
       VALUES(?, ?, ?, ?, ?, ?, 'ok', NULL, datetime('now'), ?)`
    )
      .bind(finalName, flow.session, flow.api_id, flow.api_hash, userId, flow.tg_username ?? null, isDefault)
      .run();

    const account = await env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`)
      .bind(result.meta.last_row_id)
      .first();
    await dropFlow(env, flow.id);
    return { ok: true, account };
  }

  // POST /api/accounts/login/start — 发送验证码
  r.post("/start", async (c) => {
    const body = await safeJson<Record<string, unknown>>(c.req.raw);
    if (body === null) return c.json({ error: "invalid_json" }, 400);

    const phone = normalizePhone(body.phone);
    if (!phone) return c.json({ error: "invalid_phone" }, 400);

    let cred: { api_id?: string; api_hash?: string };
    try {
      cred = readCred(body);
    } catch (err) {
      return fail(c, mapTelegramError(err));
    }

    // 顺手清掉过期流程，避免未授权 session 长期留在库里
    await c.env.DB.prepare("DELETE FROM login_flows WHERE expires_at < ?").bind(sqliteNow()).run();

    let sent;
    try {
      sent = await withTimeout(makeDriver(c.env).sendCode(phone, cred), TG_STEP_TIMEOUT_MS, "timeout");
    } catch (err) {
      return fail(c, mapTelegramError(err));
    }

    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO login_flows(id, phone, phone_code_hash, session, api_id, api_hash, stage, attempts, expires_at)
       VALUES(?, ?, ?, ?, ?, ?, 'code', 0, ?)`
    )
      .bind(id, phone, sent.phoneCodeHash, sent.session, cred.api_id ?? "", cred.api_hash ?? "", sqliteNow(FLOW_TTL_MS))
      .run();

    return c.json(
      {
        flow_id: id,
        phone,
        stage: "code",
        is_code_via_app: sent.isCodeViaApp,
        expires_in_sec: Math.floor(FLOW_TTL_MS / 1000),
      },
      201
    );
  });

  // POST /api/accounts/login/code — 提交验证码
  r.post("/code", async (c) => {
    const body = await safeJson<Record<string, unknown>>(c.req.raw);
    if (body === null) return c.json({ error: "invalid_json" }, 400);

    const code = normalizeCode(body.code);
    if (!code) return c.json({ error: "invalid_code_format" }, 400);

    const loaded = await loadFlow(c.env, body.flow_id);
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
    const flow = loaded.flow;

    if (flow.stage === "password") return c.json({ error: "password_required", stage: "password" }, 400);
    if (flow.stage !== "code") return c.json({ error: "invalid_stage", stage: flow.stage }, 400);
    if (Number(flow.attempts) >= MAX_CODE_ATTEMPTS) {
      await dropFlow(c.env, flow.id);
      return c.json({ error: "too_many_attempts" }, 429);
    }

    let res;
    try {
      res = await withTimeout(
        makeDriver(c.env).signIn({
          session: flow.session,
          phone: flow.phone,
          phoneCodeHash: flow.phone_code_hash,
          code,
          cred: credOf(flow),
        }),
        TG_STEP_TIMEOUT_MS,
        "timeout"
      );
    } catch (err) {
      const mapped = mapTelegramError(err);
      if (mapped.code === "invalid_code") {
        await c.env.DB.prepare("UPDATE login_flows SET attempts = ? WHERE id = ?")
          .bind(Number(flow.attempts) + 1, flow.id)
          .run();
      }
      if (mapped.code === "code_expired") await dropFlow(c.env, flow.id);
      return fail(c, mapped);
    }

    if (res.needPassword) {
      await c.env.DB.prepare("UPDATE login_flows SET session = ?, stage = 'password' WHERE id = ?")
        .bind(res.session, flow.id)
        .run();
      return c.json({ stage: "password", need_password: true });
    }

    await c.env.DB.prepare(
      "UPDATE login_flows SET session = ?, stage = 'ready', tg_user_id = ?, tg_username = ? WHERE id = ?"
    )
      .bind(res.session, res.user?.id ?? null, res.user?.username ?? null, flow.id)
      .run();

    return c.json({
      stage: "ready",
      user: {
        id: res.user?.id ?? null,
        username: res.user?.username ?? null,
        first_name: res.user?.firstName ?? null,
      },
    });
  });

  // POST /api/accounts/login/password — 提交两步验证密码
  r.post("/password", async (c) => {
    const body = await safeJson<Record<string, unknown>>(c.req.raw);
    if (body === null) return c.json({ error: "invalid_json" }, 400);

    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return c.json({ error: "invalid_2fa_password_format" }, 400);

    const loaded = await loadFlow(c.env, body.flow_id);
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
    const flow = loaded.flow;

    if (flow.stage !== "password") return c.json({ error: "invalid_stage", stage: flow.stage }, 400);
    if (Number(flow.attempts) >= MAX_CODE_ATTEMPTS) {
      await dropFlow(c.env, flow.id);
      return c.json({ error: "too_many_attempts" }, 429);
    }

    let res;
    try {
      res = await withTimeout(
        makeDriver(c.env).checkPassword({ session: flow.session, password, cred: credOf(flow) }),
        TG_STEP_TIMEOUT_MS,
        "timeout"
      );
    } catch (err) {
      const mapped = mapTelegramError(err);
      if (mapped.code === "invalid_2fa_password") {
        await c.env.DB.prepare("UPDATE login_flows SET attempts = ? WHERE id = ?")
          .bind(Number(flow.attempts) + 1, flow.id)
          .run();
      }
      return fail(c, mapped);
    }

    await c.env.DB.prepare(
      "UPDATE login_flows SET session = ?, stage = 'ready', tg_user_id = ?, tg_username = ? WHERE id = ?"
    )
      .bind(res.session, res.user.id, res.user.username, flow.id)
      .run();

    return c.json({
      stage: "ready",
      user: { id: res.user.id, username: res.user.username, first_name: res.user.firstName },
    });
  });

  // POST /api/accounts/login/finish — 落库为账户
  r.post("/finish", async (c) => {
    const body = await safeJson<Record<string, unknown>>(c.req.raw);
    if (body === null) return c.json({ error: "invalid_json" }, 400);

    const loaded = await loadFlow(c.env, body.flow_id);
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
    const flow = loaded.flow;

    if (flow.stage !== "ready") return c.json({ error: "invalid_stage", stage: flow.stage }, 400);

    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (rawName.length > 40) return c.json({ error: "name_too_long" }, 400);

    const saved = await persistAccount(c.env, flow, rawName);
    if (!saved.ok) {
      return c.json({ error: saved.error, existing: saved.existing }, saved.status as 400 | 409);
    }
    return c.json({ account: saved.account }, 201);
  });

  // GET /api/accounts/login/:flowId — 查询当前阶段（前端刷新后恢复向导用）
  r.get("/:flowId", async (c) => {
    const loaded = await loadFlow(c.env, c.req.param("flowId"));
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status as 400 | 404);
    const flow = loaded.flow;
    return c.json({
      flow_id: flow.id,
      phone: flow.phone,
      stage: flow.stage,
      user: flow.tg_user_id
        ? { id: flow.tg_user_id, username: flow.tg_username }
        : null,
      expires_at: flow.expires_at,
    });
  });

  // DELETE /api/accounts/login/:flowId — 取消流程（清掉未授权 session）
  r.delete("/:flowId", async (c) => {
    const id = c.req.param("flowId");
    if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
      return c.json({ error: "flow_not_found" }, 404);
    }
    await dropFlow(c.env, id);
    return c.json({ ok: true });
  });

  return r;
}
