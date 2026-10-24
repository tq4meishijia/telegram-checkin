import { Hono } from "hono";
import type { Env } from "../bindings";

export const logRoutes = new Hono<{ Bindings: Env }>();

// GET /api/logs?task_id=&limit=&before_id=
logRoutes.get("/", async (c) => {
  const limitQ = c.req.query("limit");
  const limitRaw = limitQ ? Number(limitQ) : NaN;
  // NaN / 超范围 / 负数一律收敛：limit=abc → 默认 50；limit=-1 → 1（SQLite 负 LIMIT = 无限制，必须挡掉）
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;

  const taskIdQ = c.req.query("task_id");
  let taskId: number | undefined;
  if (taskIdQ) {
    taskId = Number(taskIdQ);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return c.json({ error: "invalid_task_id" }, 400);
    }
  }

  const beforeIdQ = c.req.query("before_id");
  let beforeId: number | undefined;
  if (beforeIdQ) {
    beforeId = Number(beforeIdQ);
    if (!Number.isInteger(beforeId) || beforeId <= 0) {
      return c.json({ error: "invalid_before_id" }, 400);
    }
  }

  let sql = "SELECT l.*, t.name as task_name FROM run_logs l LEFT JOIN tasks t ON l.task_id = t.id";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (taskId !== undefined) {
    conditions.push("l.task_id = ?");
    params.push(taskId);
  }
  if (beforeId !== undefined) {
    conditions.push("l.id < ?");
    params.push(beforeId);
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY l.id DESC LIMIT ?";
  params.push(limit);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ logs: rows.results });
});
