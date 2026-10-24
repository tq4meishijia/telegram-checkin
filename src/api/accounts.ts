import { Hono } from "hono";
import type { TelegramClient } from "telegram";
import type { Env } from "../bindings";
import { safeJson, withTimeout } from "../util";
import { withAccountSession } from "../tg/client";
import { validateAccountBody } from "../validation";

/** 账户字段投影：**绝不包含 session 字符串**，任何响应都走这个投影 */
const ACCOUNT_COLS =
  "id, name, api_id, api_hash, tg_user_id, tg_username, status, last_error, last_verified_at, enabled, is_default, created_at, updated_at";

/** session 验证连接 Telegram 的超时（防止连接挂起拖住请求 / 频繁刷新触发限流） */
const VERIFY_TIMEOUT_MS = 20000;

export const accountRoutes = new Hono<{ Bindings: Env }>();

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 用已保存的 session 做一次 getMe，返回账号信息；失败抛错 */
async function probeAccount(env: Env, row: { session: string; api_id?: string | null; api_hash?: string | null }) {
  return withTimeout(
    withAccountSession(env, { session: row.session, api_id: row.api_id, api_hash: row.api_hash }, (client: TelegramClient) => client.getMe()),
    VERIFY_TIMEOUT_MS,
    "account_verify"
  );
}

/**
 * 新账户是否应接管默认位：
 * - 一个账户都没有；
 * - 或当前默认账户从未配置过 session（迁移产生的占位账户）。
 * 这样首次添加真实账户时它会自动成为默认，不需要用户手动切换。
 */
async function shouldBecomeDefault(env: Env): Promise<boolean> {
  const current = await env.DB.prepare(
    "SELECT session FROM accounts WHERE is_default = 1"
  ).first<{ session: string }>();
  if (!current) return true;
  return !current.session;
}

// GET /api/accounts — 列表（不含 session 字符串）
accountRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY id ASC`).all();
  return c.json({ accounts: rows.results });
});

// GET /api/accounts/:id — 详情（不含 session 字符串）
accountRoutes.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);
  const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first();
  if (!account) return c.json({ error: "not_found" }, 404);
  return c.json({ account });
});

// POST /api/accounts — 添加账户：先验证 session，再查重，最后入库
accountRoutes.post("/", async (c) => {
  const body = await safeJson(c.req.raw);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const validated = validateAccountBody(body, { partial: false });
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const v = validated.value;

  // 1) session 必须能真正连上 Telegram（不写库，避免脏数据）
  let me: any;
  try {
    me = await probeAccount(c.env, { session: v.session!, api_id: v.api_id, api_hash: v.api_hash });
  } catch (err: any) {
    return c.json({ error: err?.message || "invalid_session" }, 400);
  }

  // 2) 重复登录拦截：同一 Telegram 账号只允许绑定一次
  const userId = Number(me?.id) || null;
  if (userId) {
    const dup = await c.env.DB.prepare("SELECT id, name FROM accounts WHERE tg_user_id = ?").bind(userId).first();
    if (dup) {
      return c.json({ error: "duplicate_account", existing: dup }, 409);
    }
  }

  // 3) 首个账户、或当前默认账户从未配置过 session 时，自动成为默认账户
  const isDefault = (await shouldBecomeDefault(c.env)) ? 1 : 0;
  // 接管默认位前必须先清掉原默认，否则会撞上 idx_accounts_default 唯一索引
  if (isDefault) {
    await c.env.DB.prepare("UPDATE accounts SET is_default = 0, updated_at = datetime('now')").run();
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO accounts(name, session, api_id, api_hash, tg_user_id, tg_username, status, last_error, last_verified_at, is_default)
     VALUES(?, ?, ?, ?, ?, ?, 'ok', NULL, datetime('now'), ?)`
  ).bind(
    v.name,
    v.session!,
    v.api_id ?? "",
    v.api_hash ?? "",
    userId,
    me?.username ?? null,
    isDefault
  ).run();

  const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`)
    .bind(result.meta.last_row_id)
    .first();
  return c.json({ account }, 201);
});

// PATCH /api/accounts/:id — 更新（改 session 会重新验证并重新解析账号身份）
accountRoutes.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);

  const existing = await c.env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await safeJson(c.req.raw);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const validated = validateAccountBody(body, { partial: true });
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const patch = validated.value;

  const updates: string[] = [];
  const values: unknown[] = [];

  // session 变更：重新验证 + 查重 + 刷新身份字段
  if (patch.session !== undefined) {
    let me: any;
    try {
      me = await probeAccount(c.env, { session: patch.session, api_id: (patch.api_id ?? existing.api_id) as string, api_hash: (patch.api_hash ?? existing.api_hash) as string });
    } catch (err: any) {
      return c.json({ error: err?.message || "invalid_session" }, 400);
    }
    const userId = Number(me?.id) || null;
    if (userId) {
      const dup = await c.env.DB.prepare("SELECT id, name FROM accounts WHERE tg_user_id = ? AND id != ?").bind(userId, id).first();
      if (dup) return c.json({ error: "duplicate_account", existing: dup }, 409);
    }
    updates.push("session = ?", "tg_user_id = ?", "tg_username = ?", "status = 'ok'", "last_error = NULL", "last_verified_at = datetime('now')");
    values.push(patch.session, userId, me?.username ?? null);
  }

  if (patch.name !== undefined) {
    updates.push("name = ?");
    values.push(patch.name);
  }
  if (patch.api_id !== undefined) {
    updates.push("api_id = ?");
    values.push(patch.api_id);
  }
  if (patch.api_hash !== undefined) {
    updates.push("api_hash = ?");
    values.push(patch.api_hash);
  }
  if (patch.enabled !== undefined) {
    // 默认账户不允许停用，否则没有任何账户能接管"默认账户"语义
    if (patch.enabled === 0 && Number(existing.is_default) === 1) {
      return c.json({ error: "cannot_disable_default" }, 400);
    }
    updates.push("enabled = ?");
    values.push(patch.enabled);
  }

  if (updates.length === 0) return c.json({ error: "no_fields_to_update" }, 400);

  updates.push("updated_at = datetime('now')");
  values.push(id);
  await c.env.DB.prepare(`UPDATE accounts SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first();
  return c.json({ account });
});

// DELETE /api/accounts/:id — 删除账户及其全部任务与日志
accountRoutes.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);

  const existing = await c.env.DB.prepare("SELECT id, is_default FROM accounts WHERE id = ?").bind(id).first<{ id: number; is_default: number }>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
  if ((countRow?.n ?? 0) <= 1) return c.json({ error: "last_account" }, 400);

  const wasDefault = Number(existing.is_default) === 1;

  // 应用层级联（tasks.account_id 未建外键，见 0003 迁移注释）；
  // run_logs 也显式删一次，防止某些环境未开外键时留下孤儿日志
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM run_logs WHERE task_id IN (SELECT id FROM tasks WHERE account_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM tasks WHERE account_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
  ]);

  // 删掉的是默认账户 → 把默认权交给剩余 id 最小的账户
  if (wasDefault) {
    await c.env.DB.prepare(
      "UPDATE accounts SET is_default = 1, updated_at = datetime('now') WHERE id = (SELECT MIN(id) FROM accounts)"
    ).run();
  }

  return c.json({ ok: true });
});

// POST /api/accounts/:id/verify — 重新验证 session，刷新账户状态
accountRoutes.post("/:id/verify", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);

  const row = await c.env.DB.prepare("SELECT id, session, api_id, api_hash FROM accounts WHERE id = ?").bind(id).first<{
    id: number; session: string; api_id: string; api_hash: string;
  }>();
  if (!row) return c.json({ error: "not_found" }, 404);

  try {
    const me: any = await probeAccount(c.env, row);
    await c.env.DB.prepare(
      "UPDATE accounts SET status='ok', last_error=NULL, last_verified_at=datetime('now'), tg_user_id=?, tg_username=?, updated_at=datetime('now') WHERE id=?"
    ).bind(Number(me?.id) || null, me?.username ?? null, id).run();
  } catch (err: any) {
    const message = (err?.message || "invalid_session").slice(0, 500);
    await c.env.DB.prepare(
      "UPDATE accounts SET status='invalid', last_error=?, updated_at=datetime('now') WHERE id=?"
    ).bind(message, id).run();
    const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first();
    return c.json({ error: message, account }, 400);
  }

  const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, account });
});

// POST /api/accounts/:id/switch — 设为默认账户（唯一，由部分唯一索引兜底）
accountRoutes.post("/:id/switch", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_id" }, 400);

  const row = await c.env.DB.prepare("SELECT id, enabled FROM accounts WHERE id = ?").bind(id).first<{ id: number; enabled: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (Number(row.enabled) !== 1) return c.json({ error: "account_disabled" }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE accounts SET is_default = 0, updated_at = datetime('now')"),
    c.env.DB.prepare("UPDATE accounts SET is_default = 1, updated_at = datetime('now') WHERE id = ?").bind(id),
  ]);

  const account = await c.env.DB.prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, account });
});
