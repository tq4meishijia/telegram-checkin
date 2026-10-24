import { Hono } from "hono";
import type { Env } from "../bindings";
import { safeJson } from "../util";
import { hashPassword, validatePasswordStrength, verifyAdminPassword } from "../password";
import { bumpAuthEpoch } from "../auth";
import { setSetting } from "../db";

export const passwordRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/password — 修改管理密码
 * body: { old_password, new_password, confirm_password }
 *
 * 流程：校验原密码 → 校验两次新密码一致 → 校验强度 → 存 PBKDF2 哈希 → bump epoch。
 * 最后一步会**吊销所有已签发 Cookie**（含当前会话），属于有意的安全默认：
 * 改密码必须重新登录，避免旧会话在密码泄露后继续可用。
 */
passwordRoutes.post("/", async (c) => {
  const body = await safeJson<{
    old_password?: unknown;
    new_password?: unknown;
    confirm_password?: unknown;
  }>(c.req.raw);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const oldPw = typeof body.old_password === "string" ? body.old_password : "";
  const newPw = typeof body.new_password === "string" ? body.new_password : "";
  const confirm = typeof body.confirm_password === "string" ? body.confirm_password : "";

  if (!oldPw) return c.json({ error: "old_password_required" }, 400);
  if (!newPw || !confirm) return c.json({ error: "new_password_required" }, 400);

  // 1) 原密码必须正确（恒定时间比较）
  if (!(await verifyAdminPassword(c.env, oldPw))) {
    return c.json({ error: "invalid_old_password" }, 401);
  }

  // 2) 两次输入一致
  if (newPw !== confirm) return c.json({ error: "password_mismatch" }, 400);

  // 3) 强度
  const weak = validatePasswordStrength(newPw);
  if (weak) return c.json({ error: weak }, 400);

  // 4) 不能原样不变
  if (newPw === oldPw) return c.json({ error: "password_unchanged" }, 400);

  // 5) 只存哈希，不存明文
  await setSetting(c.env, "admin_pw_hash", await hashPassword(newPw));

  // 6) 全局吊销：所有已签发 Cookie 立即失效，下次请求全部跳登录页
  await bumpAuthEpoch(c.env);

  return c.json({ ok: true, relogin: true });
});
