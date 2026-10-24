/**
 * 本地登录脚本（Node，不在 Worker 里）→ 产出 StringSession
 *
 * 两种模式：
 *   交互模式（默认）：终端里按提示依次输入 手机号 → 验证码 → 二步密码
 *   非交互模式（--non-interactive）：手机号/二步密码走环境变量、验证码由脚本轮询文件，
 *                                   供 Agent / CI 等无 TTY 环境驱动
 *
 * 用法：
 *   node --env-file=.dev.vars scripts/login.mjs                      # 交互模式（默认）
 *   node --env-file=.dev.vars scripts/login.mjs --non-interactive     # 非交互模式
 *
 * 环境变量：
 *   TG_API_ID / TG_API_HASH          必填（.dev.vars 已预填 tdesktop 公开值）
 *   TG_PHONE                         手机号；交互模式下可省略（会提示输入）
 *   TG_2FA                           二步验证密码；交互模式下可省略（会提示输入）
 *   TG_CODE_FILE                     非交互模式：验证码文件路径（默认 .tg_code.txt）
 *   TG_PROXY_HOST / TG_PROXY_PORT    SOCKS5 代理（默认 127.0.0.1:7897，本机 GFW 环境用）
 *
 * 成功后输出 SESSION=xxx，把整串粘贴到管理界面「账户」页的「+ 添加账户」即可。
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import fs from "node:fs";

const NON_INTERACTIVE =
  process.argv.includes("--non-interactive") || process.env.TG_NON_INTERACTIVE === "1";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error("需要环境变量 TG_API_ID / TG_API_HASH（可用 node --env-file=.dev.vars 加载）");
  process.exit(1);
}

if (NON_INTERACTIVE && !process.env.TG_PHONE) {
  console.error("非交互模式需要环境变量 TG_PHONE");
  process.exit(1);
}

// 交互模式必须有 TTY，否则 readline 会一直挂着等输入
if (!NON_INTERACTIVE && !process.stdin.isTTY) {
  console.error("当前 stdin 不是交互式终端，无法弹出输入提示。");
  console.error("  在终端里直接运行：node --env-file=.dev.vars scripts/login.mjs");
  console.error("  自动化环境请改用：node --env-file=.dev.vars scripts/login.mjs --non-interactive");
  process.exit(1);
}

const codeFile = process.env.TG_CODE_FILE || ".tg_code.txt";

// 交互模式：readline 提示（promises 版，question() 返回 Promise）
const rl = NON_INTERACTIVE
  ? null
  : readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt) {
  const answer = await rl.question(prompt);
  return answer.trim();
}

/** 非交互模式：轮询验证码文件，出现内容即作为验证码返回 */
async function waitForCode(timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = fs.readFileSync(codeFile, "utf8").trim();
      if (s) return s;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("等待验证码超时（5 分钟）");
}

if (NON_INTERACTIVE && fs.existsSync(codeFile)) fs.unlinkSync(codeFile);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
  // 本机 GFW 环境下直连 Telegram DC 会超时，走 Clash 混合端口（SOCKS5）。
  proxy: {
    ip: process.env.TG_PROXY_HOST || "127.0.0.1",
    port: Number(process.env.TG_PROXY_PORT || 7897),
    socksType: 5,
  },
});

async function main() {
  await client.connect();
  console.log(`[driver] connected（${NON_INTERACTIVE ? "非交互" : "交互"}模式）`);

  await client.start({
    // 环境变量优先（交互模式下也可复用 .dev.vars 里预填的手机号）
    phoneNumber: async () => {
      if (process.env.TG_PHONE) return process.env.TG_PHONE;
      if (NON_INTERACTIVE) throw new Error("非交互模式需要 TG_PHONE");
      return await ask("手机号（含国际区号，如 +8613xxxxxxxxx）: ");
    },

    // isCodeViaApp 由 GramJS 传入：true = 验证码发到已登录的 Telegram 客户端
    phoneCode: async (isCodeViaApp) => {
      if (NON_INTERACTIVE) {
        console.log("[driver] waiting for code in " + codeFile);
        return await waitForCode();
      }
      return await ask(isCodeViaApp ? "Telegram App 内收到的验证码: " : "短信验证码: ");
    },

    // 未开启二步验证时直接回车即可
    password: async () => {
      if (process.env.TG_2FA) return process.env.TG_2FA;
      if (NON_INTERACTIVE) return "";
      return await ask("二步验证密码（未开启直接回车）: ");
    },

    onError: (err) => console.error("登录错误:", err?.message || err),
  });

  const session = client.session.save();
  console.log("\n登录成功！\n");
  console.log("SESSION=" + session);

  try {
    const me = await client.getMe();
    console.log(`\n账号: ${me.firstName || ""} ${me.lastName || ""} (@${me.username || "N/A"})`);
  } catch {}

  await client.disconnect();
}

main()
  .catch((err) => {
    console.error("失败:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (rl) rl.close();
  });
