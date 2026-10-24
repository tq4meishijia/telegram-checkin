/**
 * 前端契约测试：不启动浏览器，静态校验 public/ 三件套是否满足
 * CSP（无内联事件处理器）、Bento 风格规则与响应式要求。
 * 视觉层面的最终确认仍需人工在浏览器里过一遍（见报告"未解决问题"）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

const appJs = read("public/app.js");
const styleCss = read("public/style.css");
const indexHtml = read("public/index.html");

describe("CSP 契约（script-src 'self'）", () => {
  it("app.js 不产生任何内联事件处理器属性", () => {
    // CSP script-src 'self' 下 onclick=/onchange=/oninput= 等属性一律不生效
    expect(appJs).not.toMatch(/\son(click|change|input|load|error|mouseover)\s*=/);
  });

  it("index.html 不含内联脚本", () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });

  it("静态资源只引用本域路径", () => {
    expect(indexHtml).toContain('href="/style.css"');
    expect(indexHtml).toContain('src="/app.js"');
    expect(appJs).not.toMatch(/https?:\/\/[^"'`]*\.(js|css)/);
  });
});

describe("Bento 风格契约", () => {
  it("使用 CSS Grid 且存在跨列/跨行卡片（不是等大网格）", () => {
    expect(styleCss).toMatch(/\.bento\s*\{[^}]*display:\s*grid/);
    expect(styleCss).toMatch(/\.col-2\s*\{[^}]*grid-column:\s*span 2/);
    expect(styleCss).toMatch(/\.row-2\s*\{[^}]*grid-row:\s*span 2/);
  });

  it("圆角统一且不含被禁用的 rounded-none / rounded-sm 等价值", () => {
    expect(styleCss).toContain("--radius: 16px");
    expect(styleCss).not.toMatch(/border-radius:\s*0(;|\s|$)/);
    expect(styleCss).not.toMatch(/border-radius:\s*2px/);
  });

  it("网格间距一致：桌面 16px、移动 12px", () => {
    const bento = styleCss.match(/\.bento\s*\{[^}]*\}/)![0];
    expect(bento).toMatch(/gap:\s*var\(--gap\)/); // 16px
    const mobile = styleCss.match(/@media \(max-width: 640px\)\s*\{[^@]*?\.bento\s*\{[^}]*\}/)![0];
    expect(mobile).toMatch(/gap:\s*var\(--gap-sm\)/); // 12px
  });

  it("卡片有悬停上浮 + 阴影扩散过渡", () => {
    expect(styleCss).toMatch(/\.card--lift:hover\s*\{[^}]*translateY\(-2px\)/);
    expect(styleCss).toMatch(/\.card--lift:hover\s*\{[^}]*box-shadow/);
    expect(styleCss).toMatch(/transition:[^;]*transform[^;]*var\(--dur\)/);
  });

  it("图标有 group-hover 联动（卡片悬停时放大）", () => {
    expect(styleCss).toMatch(/\.card--lift:hover \.card__icon\s*\{[^}]*scale\(1\.1\)/);
  });

  it("按下有 active:scale-95 反馈", () => {
    expect(styleCss).toMatch(/\.btn:active\s*\{[^}]*scale\(0\.95\)/);
  });

  it("使用系统字体栈，不用 Inter/Roboto/Geist", () => {
    expect(styleCss).toContain("-apple-system");
    expect(styleCss).not.toMatch(/\bInter\b/);
    expect(styleCss).not.toMatch(/\bRoboto\b/);
    expect(styleCss).not.toMatch(/\bGeist\b/);
  });

  it("无渐变文字 / 玻璃态 / 单侧粗边框装饰", () => {
    expect(styleCss).not.toMatch(/background-clip:\s*text/);
    expect(styleCss).not.toMatch(/backdrop-filter/);
    expect(styleCss).not.toMatch(/border-(left|right):\s*\d+px/);
  });
});

describe("响应式与无障碍契约", () => {
  it("三档断点：桌面 4 列 / 平板 2 列 / 手机 1 列", () => {
    expect(styleCss).toMatch(/@media \(max-width: 900px\)/);
    expect(styleCss).toMatch(/@media \(max-width: 640px\)/);
    expect(styleCss).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
    expect(styleCss).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(styleCss).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("有 prefers-reduced-motion 降级", () => {
    expect(styleCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("交互元素有 focus-visible 焦点样式", () => {
    expect(styleCss).toMatch(/\.btn:focus-visible/);
    expect(styleCss).toMatch(/\.switch input:focus-visible/);
  });

  it("暗色模式通过 prefers-color-scheme 适配", () => {
    expect(styleCss).toMatch(/@media \(prefers-color-scheme: dark\)/);
  });
});

describe("功能完整性契约", () => {
  it("六个页面路由全部注册", () => {
    for (const r of ["#/login", "#/", "#/tasks", "#/logs", "#/accounts", "#/settings"]) {
      expect(appJs).toContain(`"${r}"`);
    }
  });

  it("账户管理与密码修改的 API 调用齐全", () => {
    expect(appJs).toContain("/api/accounts");
    expect(appJs).toContain('data-action="add-account"');
    expect(appJs).toContain('data-action="verify-account"');
    expect(appJs).toContain('data-action="switch-account"');
    expect(appJs).toContain('data-action="delete-account"');
    expect(appJs).toContain("/api/password");
    expect(appJs).toContain('data-action="logout"');
  });

  it("原有功能入口全部保留", () => {
    expect(appJs).toContain('data-action="add-task"');
    expect(appJs).toContain('data-action="run"');
    expect(appJs).toContain('data-action="edit"');
    expect(appJs).toContain('data-action="delete-task"');
    expect(appJs).toContain('data-action="toggle"');
    expect(appJs).toContain("/api/tasks");
    expect(appJs).toContain("/api/logs");
    expect(appJs).toContain("/api/overview");
  });

  it("网页交互式登录向导：四个端点 + 四类输入 + 错误提示位齐全", () => {
    // 手机号 → 验证码 →（2FA）→ 保存，四步各自的端点
    expect(appJs).toContain("/api/accounts/login/start");
    expect(appJs).toContain("/api/accounts/login/code");
    expect(appJs).toContain("/api/accounts/login/password");
    expect(appJs).toContain("/api/accounts/login/finish");
    // 四类输入框
    expect(appJs).toContain('id="am-phone"');
    expect(appJs).toContain('id="am-code"');
    expect(appJs).toContain('id="am-2fa"');
    expect(appJs).toContain('id="am-api-id"');
    expect(appJs).toContain('id="am-api-hash"');
    // 每个步骤都有独立的错误提示位与步骤指示
    expect((appJs.match(/class="field__error" id="am-err"/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(appJs).toContain("function stepsHtml");
    // 两步验证密码必须用 password 类型输入
    expect(appJs).toMatch(/id="am-2fa" type="password"/);
  });

  it("登录错误码都有中文提示（不透传原始 RPC 错误名给用户）", () => {
    expect(appJs).toContain("function loginErr");
    for (const code of [
      "invalid_phone", "invalid_code", "code_expired", "password_required",
      "invalid_2fa_password", "flood_wait", "flow_expired", "too_many_attempts",
      "duplicate_account", "network_error", "api_id_restricted", "session_invalid",
    ]) {
      expect(appJs, `缺少错误码文案: ${code}`).toContain(code + ":");
    }
  });

  it("时区下拉覆盖任务已有值时不会静默改写（P1-1 修复）", () => {
    expect(appJs).toContain("function tzOptions(selected)");
    expect(appJs).toContain("SCHEDULE_TZS.includes(selected) ? SCHEDULE_TZS : [selected, ...SCHEDULE_TZS]");
  });

  it("敏感字段不会未经 esc() 直接插进 HTML", () => {
    // ${esc(x)} 安全；${x.name}/${u.command} 这种"整个表达式就是裸属性访问"的不允许
    // （.length / .id / 计数等非字符串属性不在此列）
    const raw = appJs.match(
      /\$\{[a-zA-Z_$][\w$]*\.(name|username|command|detail|error|session|bot_username|schedule_value|timezone|last_error|tg_username|task_name)\}/g
    ) || [];
    expect(raw).toEqual([]);
  });

  it("除登录页外，每个渲染函数都先做鉴权探针再渲染", () => {
    // 曾经的教训：renderSettings 漏了首行 api() 调用，导致未登录直接访问
    // #/settings 也能看到完整的密码修改表单（其他 4 个页面都有探针）。
    // 注意："加载中..."占位可以出现在探针之前，但实质内容不行。
    const fns = ["renderDashboard", "renderTasks", "renderAccounts", "renderLogs", "renderSettings"];
    for (const fn of fns) {
      const m = appJs.match(new RegExp(`(?:async )?function ${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
      expect(m, `${fn} 未找到函数定义`).not.toBeNull();
      // 剥掉"加载中"占位渲染，只看实质内容的渲染时机
      const body = m![1].replace(/el\.innerHTML\s*=\s*`[^`]*加载中[^`]*`/g, "");
      const firstApi = body.search(/api\(["'`]\/api\//);
      const firstRender = body.indexOf("el.innerHTML");
      expect(firstApi, `${fn} 缺少 api() 鉴权探针`).toBeGreaterThan(-1);
      expect(firstRender, `${fn} 没有实质内容渲染`).toBeGreaterThan(-1);
      expect(firstApi, `${fn} 的鉴权探针晚于首次实质渲染`).toBeLessThan(firstRender);
    }
  });

  it("登录页不冒充初始口令（避免与 secret 优先级冲突时误导用户）", () => {
    // 曾经的教训：登录页写死"初始密码为 admin"，但生产设了 ADMIN_PASSWORD
    // secret 时 admin 并不生效，用户被误导。提示必须说明前提条件。
    expect(appJs).not.toMatch(/初始密码为/);
    expect(appJs).toMatch(/未配置 <code class="mono">ADMIN_PASSWORD<\/code> 时初始口令为/);
  });

  it("api() 只对鉴权类 401 跳登录页，业务 401 留在原页面", () => {
    // 曾经的教训：原实现把任何 401 都当掉登录，导致 /api/password 的
    // invalid_old_password（原密码错误）把用户直接踢到登录页。
    expect(appJs).toContain("AUTH_401");
    expect(appJs).toMatch(/AUTH_401\.has\(data\.error\)/);
    expect(appJs).not.toMatch(/res\.status === 401 && !path\.includes/);
  });

  it("所有被调用的自有工具函数都有定义（防 esc 漏定义这类回归）", () => {
    // 曾经的教训：esc() 用在 30 处但漏了 function 定义，页面在浏览器里直接白屏，
    // 而单测全绿——因为没有任何测试真正加载过 app.js。
    const helpers = [
      "esc", "toast", "parseDate", "fmtTime", "relTime", "scheduleDesc", "statusBadge",
      "tzOptions", "taskCard", "accountCard", "logRow", "passwordScore", "api", "loginErr",
      "navigate", "updateNav",
      "renderLogin", "renderDashboard", "renderTasks", "renderLogs", "renderAccounts", "renderSettings",
      "showTaskModal", "showAccountModal",
      "toggleTask", "runTask", "editTask", "deleteTask",
      "verifyAccount", "switchAccount", "deleteAccount", "doLogout",
    ];
    for (const h of helpers) {
      expect(appJs, `缺少函数定义: ${h}`).toMatch(new RegExp(`function ${h}\\s*\\(`));
    }
    // 反向确认 esc 确实被大量使用（避免这条测试变成空转）
    expect((appJs.match(/esc\(/g) || []).length).toBeGreaterThan(20);
  });
});
