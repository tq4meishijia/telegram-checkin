import { Hono } from "hono";
import type { Env } from "./bindings";
import { authMiddleware, buildSetCookie, bumpAuthEpoch, signAuthCookie } from "./auth";
import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from "./ratelimit";
import { safeJson } from "./util";
import { verifyAdminPassword } from "./password";
import { accountRoutes } from "./api/accounts";
import { createLoginRoutes } from "./api/login";
import { createGramDriver } from "./tg/login-flow";
import { passwordRoutes } from "./api/password";
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
  if (!password || !(await verifyAdminPassword(c.env, password))) {
    await recordLoginFailure(c.env, ip);
    return c.json({ error: "invalid_password" }, 401);
  }

  await clearLoginFailures(c.env, ip);
  const { value, maxAgeSec } = await signAuthCookie(c.env);
  c.header("Set-Cookie", buildSetCookie(value, c.req.url, maxAgeSec));
  return c.json({ ok: true });
});

// 鉴权中间件保护 /api/* 路由。
// 注意 Hono 的中间件只作用于**其后注册**的路由——logout 故意注册在下面，
// 这样它必须携带有效 Cookie 才能调用（否则匿名请求就能全局吊销会话，见 P0-1）。
app.use("/api/*", authMiddleware);

// 退出登录：清 Cookie 并 bump epoch（吊销所有已签发的 Cookie）。需要鉴权。
app.post("/api/logout", async (c) => {
  try {
    await bumpAuthEpoch(c.env);
  } catch (err) {
    console.error("logout bump epoch failed:", err instanceof Error ? err.stack || err.message : err);
  }
  c.header("Set-Cookie", "auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return c.json({ ok: true });
});

// API 路由
// 网页交互式登录（手机号 → 验证码 → 两步密码）挂在 accounts 之前，
// 路径是 /api/accounts/login/*，与 accounts 的 /:id 不会冲突。
app.route("/api/accounts/login", createLoginRoutes(createGramDriver));
app.route("/api/accounts", accountRoutes);
app.route("/api/password", passwordRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/logs", logRoutes);
app.route("/api", overviewRoute);

// 静态资源回退（放在所有 /api 路由之后）
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
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
