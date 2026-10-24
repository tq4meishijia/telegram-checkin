import { Hono } from "hono";
import type { Env } from "../bindings";
import { safeJson } from "../util";
import { validateSchedule, validateTaskBody } from "../validation";
import { computeNextRun } from "../cron/schedule";
import { executeWithClaim } from "../cron/runner";

export const taskRoutes = new Hono<{ Bindings: Env }>();

/**
 * ISO(带 Z) → SQLite datetime('now') 的空格格式。
 * run_logs.created_at 是空格格式，直接拿 ISO 'T' 串比较永远不匹配（'T' > ' '）。
 */
function isoToSqlite(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** 取默认账户 id（is_default=1；无则 id 最小者）；没有任何账户返回 null */
async function resolveDefaultAccountId(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE is_default = 1").first<{ id: number }>();
  if (row) return row.id;
  const fallback = await env.DB.prepare("SELECT id FROM accounts ORDER BY id ASC LIMIT 1").first<{ id: number }>();
  return fallback?.id ?? null;
}

/** 校验账户存在且处于启用状态；不合法返回错误码 */
async function checkAccountUsable(env: Env, accountId: unknown): Promise<string | null> {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return "invalid_account_id";
  const row = await env.DB.prepare("SELECT enabled FROM accounts WHERE id = ?").bind(id).first<{ enabled: number }>();
  if (!row) return "account_not_found";
  if (Number(row.enabled) !== 1) return "account_disabled";
  return null;
}

// GET /api/tasks — 列表
taskRoutes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM tasks ORDER BY id ASC").all();
  return c.json({ tasks: rows.results });
});

// POST /api/tasks — 新建
taskRoutes.post("/", async (c) => {
  const body = await safeJson(c.req.raw);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const validated = validateTaskBody(body, { partial: false });
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const v = validated.value;

  // 账户归属：未指定则落到默认账户
  let accountId = v.account_id;
  if (accountId === undefined) {
    accountId = (await resolveDefaultAccountId(c.env)) ?? undefined;
    if (accountId === undefined) return c.json({ error: "no_account_configured" }, 400);
  } else {
    const accountError = await checkAccountUsable(c.env, accountId);
    if (accountError) return c.json({ error: accountError }, 400);
  }

  // 排期可解才算合法（daily/interval 均能算出下一个未来时刻）
  const nextRun = computeNextRun(
    {
      scheduleType: v.schedule_type!,
      scheduleValue: v.schedule_value!,
      timezone: v.timezone!,
      jitterMinutes: v.jitter_minutes!,
    },
    new Date()
  );
  if (!nextRun) return c.json({ error: "invalid_schedule" }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO tasks(name, bot_username, command, schedule_type, schedule_value, timezone, jitter_minutes, capture_reply, reply_wait_sec, enabled, account_id, next_run_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    v.name, v.bot_username, v.command, v.schedule_type, v.schedule_value,
    v.timezone, v.jitter_minutes, v.capture_reply, v.reply_wait_sec, v.enabled,
    accountId, nextRun.toISOString()
  ).run();

  const id = result.meta.last_row_id;
  const task = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  return c.json({ task }, 201);
});

// GET /api/tasks/:id — 详情
taskRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_id" }, 400);
  const task = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!task) return c.json({ error: "not_found" }, 404);
  return c.json({ task });
});

// PATCH /api/tasks/:id — 更新
taskRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_id" }, 400);

  const existing = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await safeJson(c.req.raw);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const validated = validateTaskBody(body, { partial: true });
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const patch = validated.value;

  // 合并存量
  const merged = { ...existing, ...patch };

  // 白名单列名（防注入）；值均为校验过的类型
  const fields = [
    "name", "bot_username", "command", "schedule_type", "schedule_value",
    "timezone", "jitter_minutes", "capture_reply", "reply_wait_sec", "enabled",
  ] as const;
  const updates: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (patch[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(patch[f]);
    }
  }

  // 账户归属变更：目标账户必须存在且启用
  if (patch.account_id !== undefined) {
    const accountError = await checkAccountUsable(c.env, patch.account_id);
    if (accountError) return c.json({ error: accountError }, 400);
    updates.push("account_id = ?");
    values.push(patch.account_id);
  }

  const scheduleChanged = ["schedule_type", "schedule_value", "timezone", "jitter_minutes"].some(
    (f) => patch[f as keyof typeof patch] !== undefined
  );
  const enabling = patch.enabled === 1 && Number(existing.enabled) !== 1;

  // 改了排期字段、或重新启用一个 next_run_at 为空的任务时，重算 next_run_at。
  // 仅在"确实要动排期"时才做组合校验——否则历史脏排期（早于校验上线前写入的）
  // 会让"启停切换"这种无关操作也一起失败（P2-4）。
  const needRecompute = scheduleChanged || (enabling && !existing.next_run_at);
  if (needRecompute) {
    const scheduleError = validateSchedule(merged.schedule_type, merged.schedule_value);
    if (scheduleError) return c.json({ error: scheduleError }, 400);

    const nextRun = computeNextRun(
      {
        scheduleType: merged.schedule_type as "daily" | "interval",
        scheduleValue: String(merged.schedule_value),
        timezone: String(merged.timezone),
        jitterMinutes: Number(merged.jitter_minutes),
      },
      new Date()
    );
    if (!nextRun) return c.json({ error: "invalid_schedule" }, 400);
    updates.push("next_run_at = ?");
    values.push(nextRun.toISOString());
  }

  if (updates.length === 0) return c.json({ error: "no_fields_to_update" }, 400);

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

  const task = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  return c.json({ task });
});

// DELETE /api/tasks/:id — 删除
taskRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_id" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// POST /api/tasks/:id/run — 立即执行一次（带抢占，防与 cron 并发；不影响原排期）
taskRoutes.post("/:id/run", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_id" }, 400);

  const task = await c.env.DB.prepare(
    `SELECT t.*, a.session AS account_session, a.api_id AS account_api_id, a.api_hash AS account_api_hash
     FROM tasks t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ?`
  ).bind(id).first<{
    id: number;
    name: string;
    bot_username: string;
    command: string;
    schedule_type: string;
    schedule_value: string;
    timezone: string;
    jitter_minutes: number;
    capture_reply: number;
    reply_wait_sec: number;
    next_run_at: string | null;
    fail_streak?: number;
    account_id: number;
    account_session: string;
    account_api_id: string;
    account_api_hash: string;
  }>();
  if (!task) return c.json({ error: "not_found" }, 404);

  const result = await executeWithClaim(c.env, task, { manual: true });
  if (result.detail === "already_claimed") {
    return c.json({ error: "already_running" }, 409);
  }
  return c.json({ ok: true, ...result });
});
