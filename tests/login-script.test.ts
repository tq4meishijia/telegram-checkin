/**
 * scripts/login.mjs 的 CLI 契约测试。
 *
 * 只覆盖"参数/环境变量不满足时立即退出"的分支——这些分支都在创建
 * TelegramClient 之前 return，不产生任何网络请求，所以可以在 CI 里跑。
 * 真正的登录（连接 DC、收验证码）需要真实手机号，不在自动化范围内。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = root + "scripts/login.mjs";

/** 干净环境：不继承宿主的 TG_* 变量，避免测试结果依赖本机配置 */
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("TG_")) env[k] = v as string;
  }
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const CREDS = { TG_API_ID: "17349", TG_API_HASH: "344583e45741c457fe1862106095a5eb" };

describe("scripts/login.mjs 参数守卫", () => {
  it("缺 TG_API_ID/TG_API_HASH → 退出 1 并提示", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("TG_API_ID");
  });

  it("非交互模式缺 TG_PHONE → 退出 1 并提示", () => {
    const r = run(["--non-interactive"], CREDS);
    expect(r.status).toBe(1);
    expect(r.out).toContain("非交互模式需要环境变量 TG_PHONE");
  });

  it("交互模式在非 TTY 环境下 → 退出 1 并指引改用 --non-interactive", () => {
    // spawnSync 的 stdio 是 pipe，process.stdin.isTTY 为 undefined
    const r = run([], CREDS);
    expect(r.status).toBe(1);
    expect(r.out).toContain("不是交互式终端");
    expect(r.out).toContain("--non-interactive");
  });

  it("交互模式默认启用（源码里没有把非交互写成默认）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(script, "utf8");
    // 默认必须走 readline 分支：只有显式 --non-interactive 或 TG_NON_INTERACTIVE 才关闭
    expect(src).toMatch(/process\.argv\.includes\("--non-interactive"\)/);
    expect(src).toMatch(/readline\.createInterface/);
    expect(src).toMatch(/node:readline\/promises/);
    // 三个交互回调都必须存在（手机号 / 验证码 / 二步密码）
    for (const cb of ["phoneNumber", "phoneCode", "password"]) {
      expect(src, `缺少 ${cb} 回调`).toContain(`${cb}: async`);
    }
  });
});
