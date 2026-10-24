import { Hono } from "hono";
import type { Env } from "../bindings";

export const overviewRoute = new Hono<{ Bindings: Env }>();

/**
 * ISO(带 Z) → SQLite datetime('now') 的空格格式。
 * run_logs.created_at 是空格格式，直接拿 ISO 'T' 串比较永远不匹配（'T' > ' '）。
 */
function isoToSqlite(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// GET /api/overview — 仪表盘数据
// 可选 query：from / to（ISO 带 Z）限定统计区间；缺省按 UTC 当天。
// 前端传浏览器本地日界，即可得到"本地今日"口径（默认 UTC 日界对东八区会早 8 小时翻天）。
overviewRoute.get("/overview", async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  const fromQ = c.req.query("from");
  const toQ = c.req.query("to");

  let sql = "SELECT status, COUNT(*) as count FROM run_logs WHERE created_at >= ?";
  const params: unknown[] = [];

  if (fromQ) {
    const v = isoToSqlite(fromQ);
    if (!v) return c.json({ error: "invalid_from" }, 400);
    params.push(v);
  } else {
    params.push(`${today} 00:00:00`);
  }

  if (toQ) {
    const v = isoToSqlite(toQ);
    if (!v) return c.json({ error: "invalid_to" }, 400);
    sql += " AND created_at < ?";
    params.push(v);
  }
  sql += " GROUP BY status";

  const stats = await c.env.DB.prepare(sql).bind(...params).all<{ status: string; count: number }>();

  const counts: Record<string, number> = { success: 0, failed: 0, skipped: 0 };
  for (const row of stats.results) {
    counts[row.status] = row.count;
  }

  // 未来 24h 待执行任务（enabled + next_run_at 落在 [now, now+24h]）。
  // 下界用 JS 生成的 ISO 绑定：next_run_at 存 ISO 'T' 格式，不能和 datetime('now') 的
  // 空格格式直接比字符串，必须用同样 ISO 格式的上/下界。
  const bound = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const upcoming = await c.env.DB.prepare(
    `SELECT id, name, bot_username, command, account_id, next_run_at FROM tasks
     WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at >= ? AND next_run_at <= ?
     ORDER BY next_run_at ASC LIMIT 5`
  ).bind(nowIso, bound).all();

  // 默认账户与账户总数（session 未配置时给前端一个明确提示）
  const defaultAccount = await c.env.DB.prepare(
    "SELECT id, name, status, tg_username, enabled FROM accounts WHERE is_default = 1"
  ).first<{ id: number; name: string; status: string; tg_username: string | null; enabled: number }>();
  const accountCountRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
  const taskCountRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>();

  return c.json({
    today: counts,
    upcoming: upcoming.results,
    // 兼容字段：默认账户是否已配置可用 session
    sessionConfigured: !!defaultAccount && defaultAccount.status === "ok",
    defaultAccount: defaultAccount ?? null,
    accountCount: accountCountRow?.n ?? 0,
    taskCount: taskCountRow?.n ?? 0,
  });
});
