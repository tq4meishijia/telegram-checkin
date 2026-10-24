import { Hono } from "hono";
import type { Env } from "./bindings";
import { authMiddleware, buildSetCookie, bumpAuthEpoch, secureEqual, signAuthCookie } from "./auth";
import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from "./ratelimit";
import { safeJson } from "./util";
import { sessionRoutes } from "./api/session";
import { taskRoutes } from "./api/tasks";
import { logRoutes } from "./api/logs";
import { overviewRoute } from "./api/overview";
import { runDueTasks } from "./cron/runner";

// 静态资源响应统一附加的 CSP：前端已无内联脚本/事件处理器，
// script-src 收紧为 'self'；style 保留 unsafe-inline（存在 style 属性）。
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const app = new Hono<{ Bindings: Env }>();

// 健康检查（无需鉴权）
app.get("/api/health", (c) => c.json({ ok: true }));

// 登录：恒定时间比对 + 同 IP 失败限流（60 秒 5 次）
app.post("/api/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || "local";

  const rl = await checkLoginAllowed(c.env, ip);
  if (!rl.ok) {
    return c.json({ error: "too_many_attempts", retry_after: rl.retryAfterSec }, 429);
  }

  const body = await safeJson<{ password?: unknown }>(c.req.raw);
  if (body === null) {
    return c.json({ error: "invalid_json" }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !(await secureEqual(password, c.env.ADMIN_PASSWORD))) {
    await recordLoginFailure(c.env, ip);
    return c.json({ error: "invalid_password" }, 401);
  }

  await clearLoginFailures(c.env, ip);
  const { value, maxAgeSec } = await signAuthCookie(c.env);
  c.header("Set-Cookie", buildSetCookie(value, c.req.url, maxAgeSec));
  return c.json({ ok: true });
});

// 退出登录：清 Cookie 并 bump epoch（吊销所有已签发的 Cookie）
app.post("/api/logout", async (c) => {
  try {
    await bumpAuthEpoch(c.env);
  } catch (err) {
    console.error("logout bump epoch failed:", err instanceof Error ? err.stack || err.message : err);
  }
  c.header("Set-Cookie", "auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return c.json({ ok: true });
});

// 鉴权中间件保护 /api/* 路由（login、logout、health 除外）
app.use("/api/*", authMiddleware);

// API 路由
app.route("/api/session", sessionRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/logs", logRoutes);
app.route("/api", overviewRoute);

// 静态资源回退（放在所有 /api 路由之后）
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  return new Response(res.body, { status: res.status, headers });
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDueTasks(env).catch((err) => {
        console.error("scheduled error:", err instanceof Error ? err.stack || err.message : err);
      })
    );
  },
};
