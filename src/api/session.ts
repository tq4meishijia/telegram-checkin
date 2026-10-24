import { Hono } from "hono";
import type { Env } from "../bindings";
import { getSetting, setSetting, deleteSetting } from "../db";
import { withClient, withSession } from "../tg/client";
import { safeJson, withTimeout } from "../util";

export const sessionRoutes = new Hono<{ Bindings: Env }>();

// session 验证连接 Telegram 的超时（防止连接挂起拖住请求 / 频繁刷新触发限流）
const SESSION_VERIFY_TIMEOUT_MS = 20000;
// StringSession 长度上限（防误贴超大文本）
const SESSION_MAX_LEN = 4096;

// GET /api/session — 状态查询，不返回 session 字符串
sessionRoutes.get("/", async (c) => {
  const sessionStr = await getSetting(c.env, "tg_session");
  if (!sessionStr) {
    return c.json({ configured: false });
  }

  try {
    const me = await withTimeout(
      withClient(c.env, async (client) => client.getMe()),
      SESSION_VERIFY_TIMEOUT_MS,
      "session_verify"
    );
    const user = me as any;
    return c.json({
      configured: true,
      account: {
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        username: user.username || null,
        phone: user.phone || null,
      },
    });
  } catch (err: any) {
    return c.json({
      configured: true,
      account: null,
      error: err?.message || "invalid_session",
    });
  }
});

// PUT /api/session — 保存 session 并验证
sessionRoutes.put("/", async (c) => {
  const body = await safeJson<{ session?: unknown }>(c.req.raw);
  const session = body && typeof body.session === "string" ? body.session.trim() : "";
  if (!session || session.length > SESSION_MAX_LEN) {
    return c.json({ error: "session string required" }, 400);
  }

  // 先验证 session 有效性（用待保存的字符串建临时客户端，不污染库里已存 session）
  try {
    const me = await withTimeout(
      withSession(c.env, session, async (client) => client.getMe()),
      SESSION_VERIFY_TIMEOUT_MS,
      "session_verify"
    );
    const user = me as any;
    await setSetting(c.env, "tg_session", session);
    return c.json({
      ok: true,
      account: {
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
        username: user.username || null,
        phone: user.phone || null,
      },
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "invalid_session" }, 400);
  }
});

// DELETE /api/session — 清除
sessionRoutes.delete("/", async (c) => {
  await deleteSetting(c.env, "tg_session");
  return c.json({ ok: true });
});
