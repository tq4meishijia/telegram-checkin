// ===== API 封装 =====
// 只有「鉴权类」401 才跳登录页。业务 401（如 /api/password 的 invalid_old_password）
// 必须在原页面展示错误——否则用户输错原密码会被直接踢到登录页，还以为是掉登录了。
const AUTH_401 = new Set(["unauthorized", "expired", "invalid_signature", "revoked"]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (res.status === 401 && data && AUTH_401.has(data.error)) {
    if (location.hash !== "#/login") location.hash = "#/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error((data && data.error) || "request_failed");
  return data;
}

function toast(msg, kind = "", ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " toast--" + kind : "");
  el.textContent = msg;
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// D1 datetime('now') 输出 'YYYY-MM-DD HH:MM:SS'（UTC，无 Z）；
// next_run_at 存的是 ISO '...Z'。空格格式会被浏览器当成本地时区解析，
// 这里统一转成带 Z 的 ISO 再解析。
function parseDate(s) {
  if (!s) return null;
  const iso = !/[zZ]$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  return new Date(iso);
}

function fmtTime(isoStr) {
  const d = parseDate(isoStr);
  if (!d || isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function relTime(isoStr) {
  const d = parseDate(isoStr);
  if (!d || isNaN(d.getTime())) return "-";
  const diff = d - Date.now();
  if (diff < 0) return "已过期";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "即将";
  if (mins < 60) return `${mins} 分钟后`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m 后`;
  return `${Math.floor(hrs / 24)} 天后`;
}

const SCHEDULE_TZS = ["Asia/Shanghai", "UTC", "Asia/Tokyo", "America/New_York", "Europe/London", "Europe/Paris", "Asia/Singapore", "Australia/Sydney"];

function scheduleDesc(t) {
  if (t.schedule_type === "daily") return `每天 ${esc(t.schedule_value)} (${esc(t.timezone)})`;
  return `每 ${esc(t.schedule_value)} 分钟`;
}

function statusBadge(s) {
  const map = { success: ["ok", "成功"], failed: ["bad", "失败"], skipped: ["neutral", "跳过"], ok: ["ok", "可用"], invalid: ["bad", "已失效"], unknown: ["warn", "未验证"] };
  const [kind, label] = map[s] || ["neutral", s];
  return `<span class="badge badge--${kind}">${label}</span>`;
}

// ===== 路由 =====
const routes = {
  "#/login": renderLogin,
  "#/": renderDashboard,
  "#/tasks": renderTasks,
  "#/logs": renderLogs,
  "#/accounts": renderAccounts,
  "#/settings": renderSettings,
};

// 当前渲染代次：每次 navigate 递增；异步渲染结果若发现代次已过期则丢弃，
// 防止旧页面的请求回调覆盖新页面。
let currentRenderSeq = 0;

function navigate() {
  const seq = ++currentRenderSeq;
  const hash = location.hash || "#/";
  const render = routes[hash] || routes["#/"];
  const el = document.getElementById("app");
  if (!el) return;
  el.innerHTML = "";
  render(el, seq);
  updateNav();
  // 路由切换即清空顶栏搜索（DOM 重建后天然无过滤残留）
  const searchBox = document.getElementById("topbar-search");
  if (searchBox) searchBox.value = "";
  searchQuery = "";
}

// 路由 → 顶栏标题映射（未知路由回落「仪表盘」）
const ROUTE_TITLES = {
  "#/": "仪表盘",
  "#/tasks": "签到任务",
  "#/accounts": "Telegram 账户",
  "#/logs": "执行日志",
  "#/settings": "设置",
  "#/login": "登录",
};

// 顶栏搜索的生效范围：设置/登录页没有可过滤列表，整槽隐藏（不留假控件）
const SEARCH_SCOPES = { "#/": 1, "#/tasks": 1, "#/accounts": 1, "#/logs": 1 };

function updateNav() {
  const hash = location.hash || "#/";
  document.querySelectorAll(".sidebar__link").forEach((a) => {
    const on = a.getAttribute("data-route") === hash;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const title = document.querySelector(".topbar__title");
  if (title) title.textContent = ROUTE_TITLES[hash] || "仪表盘";
  // 登录态切壳：CSS 负责隐藏侧栏/顶栏并让内容区居中
  document.body.classList.toggle("is-auth", hash === "#/login");
  const searchBox = document.getElementById("topbar-search");
  if (searchBox) searchBox.classList.toggle("hidden", !SEARCH_SCOPES[hash]);
}

// ===== 顶栏搜索：当前页客户端过滤（纯视觉层，不发请求） =====
let searchQuery = "";

function applySearch(q) {
  searchQuery = q;
  const app = document.getElementById("app");
  if (!app) return;
  // 按 data-search 标记过滤卡片/行；命中字段 = 标题/副标题/机器人/指令等文本
  const items = Array.from(app.querySelectorAll("[data-search]"));
  const boxes = new Map();
  for (const it of items) {
    const hay = Array.from(it.querySelectorAll(".panel__title, .panel__sub, .row__title, .row__meta, .mono"))
      .map((e) => e.textContent).join(" ").toLowerCase();
    const hit = !q || hay.includes(q);
    it.classList.toggle("is-hidden", !hit);
    if (!boxes.has(it.parentElement)) boxes.set(it.parentElement, []);
    boxes.get(it.parentElement).push(it);
  }
  // 有查询词时隐藏「添加」占位卡（它不是搜索结果）
  app.querySelectorAll(".panel--dashed").forEach((d) => {
    d.classList.toggle("is-hidden", !!q);
    if (q && d.parentElement && !boxes.has(d.parentElement)) boxes.set(d.parentElement, []);
  });
  // 容器内全部隐藏时，末尾插入无结果提示
  for (const [box, list] of boxes) {
    let hint = box.querySelector(":scope > [data-filter-empty]");
    const anyHit = list.some((it) => !it.classList.contains("is-hidden"));
    if (q && !anyHit) {
      if (!hint) {
        hint = document.createElement("p");
        hint.className = "empty";
        hint.setAttribute("data-filter-empty", "");
        hint.setAttribute("role", "status");
        box.appendChild(hint);
      }
      hint.innerHTML = '<span class="empty__icon" aria-hidden="true">🔍</span>'
        + '<span class="empty__title">没有匹配“' + esc(q) + '”的结果</span>'
        + '<span class="empty__hint">换个关键词，或清空搜索框查看全部</span>';
    } else if (hint) {
      hint.remove();
    }
  }
}

window.addEventListener("hashchange", navigate);

// 事件委托替代内联事件处理器（onclick/onchange），使页面可启用 CSP script-src 'self'
document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case "run": runTask(id, el); break;
    case "edit": editTask(id); break;
    case "delete-task": deleteTask(id); break;
    case "add-task": showTaskModal(null); break;
    case "add-account": showAccountModal(); break;
    case "verify-account": verifyAccount(id, el); break;
    case "switch-account": switchAccount(id, el); break;
    case "delete-account": deleteAccount(id); break;
    case "logout": doLogout(); break;
  }
});
document.addEventListener("change", (e) => {
  if (!(e.target instanceof Element)) return;
  const el = e.target.closest('input[data-action="toggle"]');
  if (el) toggleTask(Number(el.dataset.id), el.checked, el);
});

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app-root").innerHTML = `
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand"><span aria-hidden="true">🤖</span><span>TG Checkin</span></div>
        <nav class="sidebar__nav" aria-label="主导航">
          <a class="sidebar__link" href="#/" data-route="#/"><span class="sidebar__ico" aria-hidden="true">📊</span>仪表盘</a>
          <a class="sidebar__link" href="#/tasks" data-route="#/tasks"><span class="sidebar__ico" aria-hidden="true">🗓️</span>任务</a>
          <a class="sidebar__link" href="#/accounts" data-route="#/accounts"><span class="sidebar__ico" aria-hidden="true">👥</span>账户</a>
          <a class="sidebar__link" href="#/logs" data-route="#/logs"><span class="sidebar__ico" aria-hidden="true">📜</span>日志</a>
          <a class="sidebar__link" href="#/settings" data-route="#/settings"><span class="sidebar__ico" aria-hidden="true">⚙️</span>设置</a>
        </nav>
        <div class="sidebar__footer">
          <span class="avatar" aria-hidden="true">👤</span>
          <span class="sidebar__footer-meta">
            <span class="sidebar__footer-name">管理员</span>
            <span class="sidebar__footer-sub">admin</span>
          </span>
          <button class="btn btn--ghost-invert btn--sm" data-action="logout">🚪 退出</button>
        </div>
      </aside>
      <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn topbar__toggle" id="sidebar-toggle" aria-label="打开导航菜单" aria-expanded="false" aria-controls="sidebar"><span aria-hidden="true">☰</span></button>
          <h1 class="topbar__title">仪表盘</h1>
          <div class="topbar__right">
            <input class="input topbar__search" id="topbar-search" type="search" placeholder="搜索当前页…" aria-label="搜索当前页列表" />
            <a class="icon-btn topbar__bell" href="#/logs" aria-label="查看执行日志"><span aria-hidden="true">🔔</span></a>
            <span class="topbar__user"><span class="avatar" aria-hidden="true">👤</span><span class="topbar__user-name">管理员</span></span>
          </div>
        </header>
        <main class="content" id="app"></main>
      </div>
    </div>
  `;

  // --- 移动端抽屉（<768px）：汉堡 / backdrop / ESC / 点链接后关闭 ---
  const sidebar = document.getElementById("sidebar");
  const drawerToggle = document.getElementById("sidebar-toggle");
  function setDrawer(open) {
    document.body.classList.toggle("drawer-open", open);
    sidebar.classList.toggle("is-open", open);
    drawerToggle.setAttribute("aria-expanded", String(open));
    drawerToggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    if (open) {
      const first = sidebar.querySelector(".sidebar__link");
      if (first) first.focus();
    } else if (getComputedStyle(drawerToggle).display !== "none") {
      drawerToggle.focus();
    }
  }
  drawerToggle.addEventListener("click", () => setDrawer(!sidebar.classList.contains("is-open")));
  document.getElementById("sidebar-backdrop").addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebar.classList.contains("is-open")) setDrawer(false);
  });
  sidebar.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".sidebar__link") && sidebar.classList.contains("is-open")) setDrawer(false);
  });
  window.matchMedia("(min-width: 768px)").addEventListener("change", (e) => {
    if (e.matches) setDrawer(false);
  });

  // --- 顶栏搜索：当前页客户端过滤 ---
  document.getElementById("topbar-search").addEventListener("input", function () {
    applySearch(this.value.trim().toLowerCase());
  });

  // hash 为空时，赋值 "#/" 会自动触发 hashchange → navigate，不要再手动调一次
  if (!location.hash) {
    location.hash = "#/";
  } else {
    navigate();
  }
});

// ===== 登录页 =====
function renderLogin(el) {
  el.innerHTML = `
    <div class="center-col">
      <div class="panel auth-card">
        <div>
          <h1 class="h1">登录 TG Checkin</h1>
          <p class="panel__sub">输入管理密码继续</p>
        </div>
        <div class="field">
          <label class="field__label" for="login-pw">管理密码</label>
          <input class="input" type="password" id="login-pw" placeholder="输入管理密码" autocomplete="current-password" />
        </div>
        <div class="field__error" id="login-err"></div>
        <button class="btn btn--primary btn--block" id="login-btn">登录</button>
        <p class="field__hint">未配置 <code class="mono">ADMIN_PASSWORD</code> 时初始口令为 <code class="mono">admin</code>；忘记密码可用 <code class="mono">wrangler secret put ADMIN_PASSWORD</code> 重置。</p>
      </div>
    </div>
  `;
  const btn = document.getElementById("login-btn");
  const pw = document.getElementById("login-pw");
  const err = document.getElementById("login-err");
  const submit = async () => {
    err.textContent = "";
    pw.classList.remove("is-error");
    pw.removeAttribute("aria-invalid");
    btn.classList.add("is-loading");
    btn.textContent = "登录中...";
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw.value }) });
      toast("登录成功", "ok");
      location.hash = "#/";
    } catch (e) {
      err.textContent = e.message === "too_many_attempts" ? "失败次数过多，请稍后再试" : "密码错误";
      pw.classList.add("is-error");
      pw.setAttribute("aria-invalid", "true");
    } finally {
      btn.classList.remove("is-loading");
      btn.textContent = "登录";
    }
  };
  btn.onclick = submit;
  pw.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  pw.focus();
}

// ===== 仪表盘 =====
async function renderDashboard(el, seq) {
  el.innerHTML = `
    <div class="stack" aria-busy="true">
      <div class="kpi-grid">
        <div class="panel"><div class="skeleton skeleton--text" style="width:40%" aria-hidden="true"></div><div class="skeleton skeleton--kpi" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--text" style="width:40%" aria-hidden="true"></div><div class="skeleton skeleton--kpi" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--text" style="width:40%" aria-hidden="true"></div><div class="skeleton skeleton--kpi" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--text" style="width:40%" aria-hidden="true"></div><div class="skeleton skeleton--kpi" aria-hidden="true"></div></div>
      </div>
      <div class="grid grid--panels">
        <div class="panel col-2"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      </div>
      <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      <p class="empty" role="status">加载中...</p>
    </div>
  `;
  try {
    // 传浏览器本地日界，让"今日"按本地时区口径统计（服务端默认按 UTC 日界）
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const data = await api(`/api/overview?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`);
    if (seq !== currentRenderSeq) return;

    const t = data.today || {};
    const acc = data.defaultAccount;
    const accBadge = acc ? statusBadge(acc.status) : '<span class="badge badge--warn">未配置</span>';

    el.innerHTML = `
      <div class="stack">
        ${!data.sessionConfigured ? `
        <div class="notice">
          <span aria-hidden="true">⚠️</span>
          <span>尚未配置可用的 Telegram 账户，签到任务无法执行。<a href="#/accounts">前往账户页添加</a></span>
        </div>` : ""}

        <div class="kpi-grid">
          <div class="kpi">
            <span class="kpi__label">今日成功</span>
            <span class="kpi__value">${t.success || 0}</span>
          </div>
          <div class="kpi">
            <span class="kpi__label">今日失败</span>
            <span class="kpi__value">${t.failed || 0}</span>
          </div>
          <div class="kpi">
            <span class="kpi__label">签到任务</span>
            <span class="kpi__value">${data.taskCount || 0}</span>
          </div>
          <div class="kpi">
            <span class="kpi__label">Telegram 账户</span>
            <span class="kpi__value">${data.accountCount || 0}</span>
          </div>
        </div>

        <div class="grid grid--panels">
          <section class="panel col-2" aria-labelledby="dash-today">
            <div class="panel__head">
              <div>
                <h2 class="panel__title" id="dash-today">今日执行</h2>
                <div class="panel__sub">按本地时区统计</div>
              </div>
              <span class="panel__icon" aria-hidden="true">📊</span>
            </div>
            <div class="stat-row">
              <div class="stat stat--ok"><span class="stat__num">${t.success || 0}</span><span class="stat__label">成功</span></div>
              <div class="stat stat--bad"><span class="stat__num">${t.failed || 0}</span><span class="stat__label">失败</span></div>
              <div class="stat stat--neutral"><span class="stat__num">${t.skipped || 0}</span><span class="stat__label">跳过</span></div>
            </div>
            <div class="panel__body">跳过多为「迟到超过 30 分钟不补发」或「已被其他执行抢走」，属正常行为。</div>
          </section>

          <section class="panel col-1" aria-labelledby="dash-acc">
            <div class="panel__head">
              <h2 class="panel__title" id="dash-acc">默认账户</h2>
              <span class="panel__icon" aria-hidden="true">👤</span>
            </div>
            <div class="panel__body">
              <div>${accBadge}</div>
              <div>${esc(acc ? (acc.name + (acc.tg_username ? " (@" + esc(acc.tg_username) + ")" : "")) : "尚未添加账户")}</div>
            </div>
          </section>
        </div>

        <div class="grid grid--panels">
          <section class="panel panel--interactive col-1" aria-labelledby="dash-quick">
            <div class="panel__head">
              <h2 class="panel__title" id="dash-quick">快捷操作</h2>
              <span class="panel__icon" aria-hidden="true">⚡</span>
            </div>
            <div class="btn-row">
              <button class="btn btn--primary" data-action="add-task">+ 新建任务</button>
              <button class="btn" data-action="add-account">+ 添加账户</button>
              <a class="btn" href="#/logs">查看日志</a>
            </div>
            <div class="panel__body">任务每分钟由 cron 扫描一次，单轮最多执行 10 条，串行发送以避免触发 Telegram 风控。</div>
          </section>

          <section class="panel col-1" aria-labelledby="dash-alert">
            <div class="panel__head">
              <h2 class="panel__title" id="dash-alert">告警说明</h2>
              <span class="panel__icon" aria-hidden="true">🔔</span>
            </div>
            <div class="panel__body">同一任务连续失败 3 次起，会通过所属账户向「已保存消息」发一条告警。</div>
          </section>

          <section class="panel col-1" aria-labelledby="dash-pw">
            <div class="panel__head">
              <h2 class="panel__title" id="dash-pw">密码</h2>
              <span class="panel__icon" aria-hidden="true">🔑</span>
            </div>
            <div class="panel__body">以 PBKDF2 哈希存储，可在设置页修改。</div>
            <div class="panel__foot"><a class="btn btn--sm" href="#/settings">去修改</a></div>
          </section>
        </div>

        <div class="grid grid--panels">
          <section class="panel panel--upcoming panel--flat col-3" aria-labelledby="dash-upcoming">
            <div class="panel__head">
              <h2 class="panel__title" id="dash-upcoming">即将执行</h2>
              <span class="panel__icon" aria-hidden="true">🗓️</span>
            </div>
            <div class="rows">
              ${(data.upcoming || []).length === 0 ? `
              <div class="empty">
                <span class="empty__icon" aria-hidden="true">📭</span>
                <span class="empty__title">未来 24 小时内没有待执行任务</span>
                <span class="empty__hint">任务启用后，下次执行时间会显示在这里</span>
                <a class="btn btn--sm" href="#/tasks">前往任务页</a>
              </div>` : data.upcoming.map((u) => `
                <div class="row" data-search>
                  <div class="row__main">
                    <div class="row__title">${esc(u.name)}</div>
                    <div class="row__meta">${esc(u.bot_username)} · ${esc(u.command)}</div>
                  </div>
                  <span class="badge badge--neutral">${relTime(u.next_run_at)}</span>
                </div>`).join("")}
            </div>
          </section>
        </div>
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="stack"><div class="empty"><span class="empty__icon" aria-hidden="true">⚠️</span><span class="empty__title">加载失败</span><span class="empty__hint">${esc(e.message)}，刷新页面重试</span></div></div>`;
  }
}

// ===== 任务页 =====
async function renderTasks(el, seq) {
  el.innerHTML = `
    <div class="stack" aria-busy="true">
      <div class="grid grid--panels">
        <div class="panel col-2"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      </div>
      <div class="grid grid--cards">
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
      </div>
      <p class="empty" role="status">加载中...</p>
    </div>
  `;
  try {
    const [{ tasks }, { accounts }] = await Promise.all([api("/api/tasks"), api("/api/accounts")]);
    if (seq !== currentRenderSeq) return;

    const enabledCount = tasks.filter((t) => Number(t.enabled) === 1).length;

    el.innerHTML = `
      <div class="stack">
        <div class="grid grid--panels">
          <section class="panel col-2" aria-labelledby="tasks-title">
            <div class="panel__head">
              <div>
                <h2 class="panel__title" id="tasks-title">签到任务</h2>
                <div class="panel__sub">共 ${tasks.length} 个，${enabledCount} 个启用中</div>
              </div>
              <span class="panel__icon" aria-hidden="true">🗓️</span>
            </div>
            <div class="panel__body">任务按各自排期执行，可暂停、手动运行或编辑；开关在请求期间会自动禁用，防止连点产生竞态。</div>
            <div class="panel__foot"><button class="btn btn--primary" data-action="add-task">+ 新建任务</button></div>
          </section>
          <section class="panel col-1" aria-labelledby="tasks-acc">
            <div class="panel__head"><h2 class="panel__title" id="tasks-acc">目标账户</h2></div>
            <div class="stat stat--neutral"><span class="stat__num">${accounts.length}</span><span class="stat__label">个可用账户</span></div>
          </section>
          <section class="panel col-1" aria-labelledby="tasks-last">
            <div class="panel__head"><h2 class="panel__title" id="tasks-last">最近状态</h2></div>
            <div class="panel__body">${tasks.length === 0 ? "暂无任务" : tasks.filter((t) => t.last_status).slice(0, 1).map((t) => statusBadge(t.last_status)).join("") || '<span class="badge badge--neutral">未执行</span>'}</div>
          </section>
        </div>

        ${tasks.length === 0 ? `
        <div class="grid grid--cards">
          <div class="panel panel--dashed" data-action="add-task">
            <span class="empty__icon" aria-hidden="true">🗒️</span>
            <div class="panel__title">还没有任务</div>
            <div class="panel__sub">点击新建第一个签到任务</div>
          </div>
        </div>` : `
        <div class="grid grid--cards">
          ${tasks.map((t) => taskCard(t, accounts)).join("")}
        </div>`}
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="stack"><div class="empty"><span class="empty__icon" aria-hidden="true">⚠️</span><span class="empty__title">加载失败</span><span class="empty__hint">${esc(e.message)}，刷新页面重试</span></div></div>`;
  }
}

function taskCard(t, accounts) {
  const acc = accounts.find((a) => Number(a.id) === Number(t.account_id));
  return `
    <section class="panel" data-search>
      <div class="panel__head">
        <div>
          <h3 class="panel__title">${esc(t.name)}</h3>
          <div class="row__meta">${esc(t.bot_username)} · <span class="mono">${esc(t.command)}</span></div>
        </div>
        <label class="switch" title="启用/停用">
          <input type="checkbox" data-action="toggle" data-id="${t.id}" ${Number(t.enabled) === 1 ? "checked" : ""} aria-label="启用 ${esc(t.name)}">
          <span class="slider"></span>
        </label>
      </div>
      <div class="panel__body">
        <div>${scheduleDesc(t)}${t.jitter_minutes ? ` ±${t.jitter_minutes}m` : ""}</div>
        <div class="dim">下次 ${fmtTime(t.next_run_at)}（${relTime(t.next_run_at)}）</div>
        <div class="dim">账户 ${esc(acc ? acc.name : "#" + t.account_id)}${acc && acc.is_default ? " · 默认" : ""}</div>
        ${Number(t.capture_reply) === 1 ? `<div class="dim">抓取回复（等待 ${t.reply_wait_sec}s）</div>` : ""}
      </div>
      <div class="panel__foot">
        ${t.last_status ? statusBadge(t.last_status) : '<span class="badge badge--neutral">未执行</span>'}
        ${t.last_error ? `<span class="dim" title="${esc(t.last_error)}">${esc(String(t.last_error).slice(0, 40))}</span>` : ""}
        <span class="row__actions">
          <button class="btn btn--sm" data-action="run" data-id="${t.id}">运行</button>
          <button class="btn btn--sm" data-action="edit" data-id="${t.id}">编辑</button>
          <button class="btn btn--sm btn--danger" data-action="delete-task" data-id="${t.id}">删除</button>
        </span>
      </div>
    </section>`;
}

function tzOptions(selected) {
  const list = SCHEDULE_TZS.includes(selected) ? SCHEDULE_TZS : [selected, ...SCHEDULE_TZS];
  return list.map((tz) => `<option value="${esc(tz)}" ${tz === selected ? "selected" : ""}>${esc(tz)}</option>`).join("");
}

function showTaskModal(task) {
  const isEdit = !!task;
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal modal--wide" role="dialog" aria-modal="true">
      <div class="modal__title">${isEdit ? "编辑任务" : "新建任务"}</div>
      <div class="field">
        <label class="field__label" for="tf-name">名称</label>
        <input class="input" id="tf-name" value="${esc(task?.name || "")}" />
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field__label" for="tf-bot">目标机器人（@bot 或 me）</label>
          <input class="input" id="tf-bot" value="${esc(task?.bot_username || "")}" placeholder="@some_bot" />
        </div>
        <div class="field">
          <label class="field__label" for="tf-cmd">指令</label>
          <input class="input" id="tf-cmd" value="${esc(task?.command || "")}" placeholder="/checkin" />
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field__label" for="tf-type">类型</label>
          <select class="select" id="tf-type">
            <option value="daily" ${task?.schedule_type === "daily" ? "selected" : ""}>每天定时</option>
            <option value="interval" ${task?.schedule_type === "interval" ? "selected" : ""}>每隔 N 分钟</option>
          </select>
        </div>
        <div class="field" id="fg-time">
          <label class="field__label" for="tf-time">时间（08:00 或 08:00,20:00）</label>
          <input class="input" id="tf-time" value="${task?.schedule_type === "daily" ? esc(task?.schedule_value || "") : ""}" />
        </div>
        <div class="field hidden" id="fg-interval">
          <label class="field__label" for="tf-interval">间隔分钟数</label>
          <input class="input" id="tf-interval" value="${task?.schedule_type === "interval" ? esc(task?.schedule_value || "") : ""}" />
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field__label" for="tf-tz">时区</label>
          <select class="select" id="tf-tz">${tzOptions(task?.timezone || "Asia/Shanghai")}</select>
        </div>
        <div class="field">
          <label class="field__label" for="tf-account">执行账户</label>
          <select class="select" id="tf-account"></select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="field__label" for="tf-jitter">随机抖动（分钟）</label>
          <input class="input" type="number" id="tf-jitter" value="${task?.jitter_minutes ?? 0}" min="0" />
        </div>
        <div class="field">
          <label class="field__label"><input type="checkbox" id="tf-capture" ${task?.capture_reply ? "checked" : ""} /> 抓取机器人回复</label>
        </div>
      </div>
      <div class="field__error" id="modal-err"></div>
      <div class="modal__actions">
        <button class="btn" id="modal-cancel">取消</button>
        <button class="btn btn--primary" id="modal-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const typeSelect = overlay.querySelector("#tf-type");
  const fgTime = overlay.querySelector("#fg-time");
  const fgInterval = overlay.querySelector("#fg-interval");
  function toggleTypeFields() {
    fgTime.classList.toggle("hidden", typeSelect.value !== "daily");
    fgInterval.classList.toggle("hidden", typeSelect.value !== "interval");
  }
  typeSelect.onchange = toggleTypeFields;
  toggleTypeFields();

  const accountSel = overlay.querySelector("#tf-account");
  api("/api/accounts").then(({ accounts }) => {
    if (!document.body.contains(overlay)) return;
    accountSel.innerHTML = accounts.map((a) =>
      `<option value="${a.id}" ${Number(task?.account_id) === Number(a.id) ? "selected" : ""}>${esc(a.name)}${Number(a.is_default) ? "（默认）" : ""}</option>`
    ).join("") || '<option value="">（无可用账户）</option>';
  }).catch(() => { accountSel.innerHTML = '<option value="">加载失败</option>'; });

  overlay.querySelector("#modal-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#modal-save").onclick = async () => {
    const err = overlay.querySelector("#modal-err");
    err.textContent = "";
    const body = {
      name: overlay.querySelector("#tf-name").value.trim(),
      bot_username: overlay.querySelector("#tf-bot").value.trim(),
      command: overlay.querySelector("#tf-cmd").value.trim(),
      schedule_type: typeSelect.value,
      schedule_value: typeSelect.value === "daily"
        ? overlay.querySelector("#tf-time").value.trim()
        : overlay.querySelector("#tf-interval").value.trim(),
      timezone: overlay.querySelector("#tf-tz").value,
      jitter_minutes: Number(overlay.querySelector("#tf-jitter").value) || 0,
      capture_reply: overlay.querySelector("#tf-capture").checked ? 1 : 0,
    };
    const accId = Number(accountSel.value);
    if (accId > 0) body.account_id = accId;
    try {
      if (isEdit) {
        await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast("已更新", "ok");
      } else {
        await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
        toast("已创建", "ok");
      }
      overlay.remove();
      navigate();
    } catch (e) { err.textContent = e.message; }
  };
  overlay.querySelector("#tf-name").focus();
}

async function toggleTask(id, enabled, input) {
  // 请求在飞时禁用开关，防止连点产生竞态；失败时 navigate() 重渲染自然回滚
  const wrap = input ? input.closest(".switch") : null;
  if (input) input.disabled = true;
  if (wrap) wrap.classList.add("is-busy");
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
    toast(enabled ? "已启用" : "已停用", "ok");
  } catch (e) { toast("操作失败: " + e.message, "bad"); navigate(); }
  finally {
    if (input) input.disabled = false;
    if (wrap) wrap.classList.remove("is-busy");
  }
}

async function runTask(id, btn) {
  btn.classList.add("is-loading");
  const old = btn.textContent;
  btn.textContent = "...";
  try {
    const res = await api(`/api/tasks/${id}/run`, { method: "POST" });
    toast(`执行结果: ${res.status}`, res.status === "success" ? "ok" : "bad");
  } catch (e) { toast("执行失败: " + e.message, "bad"); }
  btn.classList.remove("is-loading");
  btn.textContent = old;
  navigate();
}

async function editTask(id) {
  try {
    const { task } = await api(`/api/tasks/${id}`);
    showTaskModal(task);
  } catch (e) { toast("加载失败: " + e.message, "bad"); }
}

async function deleteTask(id) {
  if (!confirm("确认删除此任务？")) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("已删除", "ok");
    navigate();
  } catch (e) { toast("删除失败: " + e.message, "bad"); }
}

// ===== 账户页 =====
async function renderAccounts(el, seq) {
  el.innerHTML = `
    <div class="stack" aria-busy="true">
      <div class="grid grid--panels">
        <div class="panel col-2"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      </div>
      <div class="grid grid--cards">
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
        <div class="panel"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--badge" aria-hidden="true"></div></div>
      </div>
      <p class="empty" role="status">加载中...</p>
    </div>
  `;
  try {
    const { accounts } = await api("/api/accounts");
    if (seq !== currentRenderSeq) return;
    const okCount = accounts.filter((a) => a.status === "ok").length;

    el.innerHTML = `
      <div class="stack">
        <div class="grid grid--panels">
          <section class="panel col-2" aria-labelledby="acc-title">
            <div class="panel__head">
              <div>
                <h2 class="panel__title" id="acc-title">Telegram 账户</h2>
                <div class="panel__sub">共 ${accounts.length} 个，${okCount} 个可用</div>
              </div>
              <span class="panel__icon" aria-hidden="true">👥</span>
            </div>
            <div class="panel__body">每个账户独立保存会话与签到任务，可并行运行、互不干扰。重启后状态由数据库自动恢复。</div>
            <div class="panel__foot"><button class="btn btn--primary" data-action="add-account">+ 添加账户</button></div>
          </section>
          <section class="panel col-1" aria-labelledby="acc-default">
            <div class="panel__head"><h2 class="panel__title" id="acc-default">默认账户</h2></div>
            <div class="panel__body">${accounts.length === 0 ? "无" : esc((accounts.find((a) => Number(a.is_default) === 1) || accounts[0]).name)}</div>
            <div class="dim">新建任务默认归属它</div>
          </section>
          <section class="panel col-1" aria-labelledby="acc-login">
            <div class="panel__head"><h2 class="panel__title" id="acc-login">登录方式</h2></div>
            <div class="panel__body">网页内输入手机号 + 验证码直接登录；也可粘贴 <span class="mono">scripts/login.mjs</span> 导出的 StringSession。</div>
          </section>
        </div>

        <div class="grid grid--cards">
          ${accounts.map((a) => accountCard(a)).join("")}
          <div class="panel panel--dashed" data-action="add-account">
            <span class="empty__icon" aria-hidden="true">👥</span>
            <div class="panel__title">+ 添加账户</div>
            <div class="panel__sub">手机号登录 / 粘贴 Session</div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="stack"><div class="empty"><span class="empty__icon" aria-hidden="true">⚠️</span><span class="empty__title">加载失败</span><span class="empty__hint">${esc(e.message)}，刷新页面重试</span></div></div>`;
  }
}

function accountCard(a) {
  return `
    <section class="panel" data-search>
      <div class="panel__head">
        <div>
          <h3 class="panel__title">${esc(a.name)} ${Number(a.is_default) === 1 ? '<span class="badge badge--ok">默认</span>' : ""}</h3>
          <div class="row__meta">${a.tg_username ? "@" + esc(a.tg_username) : "未获取到用户名"}${Number(a.enabled) !== 1 ? " · 已停用" : ""}</div>
        </div>
        <span class="panel__icon" aria-hidden="true">👤</span>
      </div>
      <div class="panel__body">
        <div>${statusBadge(a.status)}${a.last_error && a.status === "invalid" ? ` <span class="dim" title="${esc(a.last_error)}">${esc(String(a.last_error).slice(0, 40))}</span>` : ""}</div>
        <div class="dim">最近验证 ${fmtTime(a.last_verified_at)}</div>
      </div>
      <div class="panel__foot">
        <span class="row__actions">
          <button class="btn btn--sm" data-action="verify-account" data-id="${a.id}">验证</button>
          ${Number(a.is_default) === 1 ? "" : `<button class="btn btn--sm" data-action="switch-account" data-id="${a.id}">设为默认</button>`}
          <button class="btn btn--sm btn--danger" data-action="delete-account" data-id="${a.id}">删除</button>
        </span>
      </div>
    </section>`;
}

// ===== 添加账户向导（手机号交互式登录 / 粘贴 Session） =====

/** Telegram 登录错误码 → 中文提示。未列出的原样展示，便于排查。 */
const LOGIN_ERR = {
  invalid_phone: "手机号格式不正确，需含国际区号（如 +8613xxxxxxxxx）",
  invalid_code: "验证码错误，请重新输入",
  invalid_code_format: "请输入 3-10 位数字验证码",
  code_expired: "验证码已过期，请重新发送",
  phone_banned: "该手机号已被 Telegram 封禁",
  phone_not_registered: "该手机号尚未注册 Telegram",
  phone_flood: "该号码请求过于频繁，请稍后再试",
  password_required: "该账户需要两步验证密码",
  invalid_2fa_password: "两步验证密码错误",
  invalid_2fa_password_format: "请输入两步验证密码",
  flood_wait: "操作过于频繁，请稍后再试",
  flow_not_found: "登录会话已失效，请重新开始",
  flow_expired: "登录超时（10 分钟），请重新开始",
  too_many_attempts: "尝试次数过多，请重新开始",
  duplicate_account: "该 Telegram 账号已经添加过了",
  network_error: "无法连接 Telegram，请检查网络或代理",
  tg_credentials_missing: "服务端未配置 TG_API_ID / TG_API_HASH",
  invalid_api_credentials: "api_id / api_hash 不合法，请检查是否填错",
  api_id_restricted:
    "服务端配置的 api_id 是公开值，Telegram 禁止用它发送验证码。请到 my.telegram.org → API development tools 申请自己的 api_id/api_hash，填在下方「高级」里再试。",
  user_deactivated: "该 Telegram 账号已注销",
  session_invalid: "登录会话失效，请重新开始",
  login_incomplete: "登录未完成，请重新开始",
  invalid_stage: "操作顺序不对，请重新开始",
  timeout: "操作超时，请重试",
};

function loginErr(code) {
  return LOGIN_ERR[code] || "操作失败：" + code;
}

function showAccountModal() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="am-title">
      <div class="modal__title" id="am-title">添加 Telegram 账户</div>
      <div class="tabs" role="tablist">
        <button class="tab is-active" data-tab="phone" role="tab" aria-selected="true">手机号登录</button>
        <button class="tab" data-tab="session" role="tab" aria-selected="false">粘贴 Session</button>
      </div>
      <div id="am-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#am-body");
  /** 向导状态：flowId 非空表示服务端有未完成的登录流程，取消时要清掉 */
  const st = { flowId: null, phone: "", apiId: "", apiHash: "" };

  function dropFlow() {
    if (!st.flowId) return;
    // 尽力而为：清掉服务端的未授权 session，失败不影响前端
    api("/api/accounts/login/" + st.flowId, { method: "DELETE" }).catch(() => {});
    st.flowId = null;
  }

  function closeOverlay() {
    dropFlow();
    overlay.remove();
  }
  overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };

  function stepsHtml(active) {
    const order = ["phone", "code", "ready"];
    const labels = { phone: "手机号", code: "验证码", ready: "保存" };
    const ai = order.indexOf(active);
    return `<div class="steps">${order.map((k, i) => {
      const cls = i === ai ? "is-active" : i < ai ? "is-done" : "";
      return `<span class="step ${cls}"><span class="step__dot">${i + 1}</span>${labels[k]}</span>`;
    }).join('<span class="step__sep">→</span>')}</div>`;
  }

  // --- 步骤 1：手机号 ---
  function stepPhone() {
    body.innerHTML = `
      ${stepsHtml("phone")}
      <div class="field">
        <label class="field__label" for="am-phone">手机号（含国际区号）</label>
        <input class="input" id="am-phone" type="tel" inputmode="tel" autocomplete="tel"
               placeholder="+8613xxxxxxxxx" value="${esc(st.phone)}" />
        <span class="field__hint">验证码会发到这个号码的 Telegram App；App 未登录时走短信。</span>
      </div>
      <details class="adv"${st.apiId ? " open" : ""}>
        <summary>高级：使用自己的 api_id / api_hash</summary>
        <div class="grid-2">
          <div class="field">
            <label class="field__label" for="am-api-id">api_id</label>
            <input class="input" id="am-api-id" inputmode="numeric" placeholder="12345678" value="${esc(st.apiId)}" />
          </div>
          <div class="field">
            <label class="field__label" for="am-api-hash">api_hash</label>
            <input class="input" id="am-api-hash" placeholder="32 位十六进制" value="${esc(st.apiHash)}" />
          </div>
        </div>
        <span class="field__hint">在 my.telegram.org → API development tools 免费申请。留空则用服务端配置的默认凭据。</span>
      </details>
      <div class="field__error" id="am-err"></div>
      <div class="modal__actions">
        <button class="btn" id="am-cancel">取消</button>
        <button class="btn btn--primary" id="am-send">发送验证码</button>
      </div>
    `;
    const phoneEl = body.querySelector("#am-phone");
    const idEl = body.querySelector("#am-api-id");
    const hashEl = body.querySelector("#am-api-hash");
    const errEl = body.querySelector("#am-err");
    const btn = body.querySelector("#am-send");
    body.querySelector("#am-cancel").onclick = closeOverlay;

    const send = async () => {
      errEl.textContent = "";
      phoneEl.classList.remove("is-error");
      phoneEl.removeAttribute("aria-invalid");
      idEl.classList.remove("is-error");
      hashEl.classList.remove("is-error");
      const cleaned = phoneEl.value.trim().replace(/[\s\-().]/g, "");
      if (!/^\+?[1-9]\d{5,19}$/.test(cleaned)) {
        errEl.textContent = "请输入含国际区号的手机号，例如 +8613xxxxxxxxx";
        phoneEl.classList.add("is-error");
        phoneEl.setAttribute("aria-invalid", "true");
        phoneEl.focus();
        return;
      }
      // 自定义凭据：要么都填，要么都不填（只填一个必然是配置错误）
      const apiId = idEl.value.trim();
      const apiHash = hashEl.value.trim();
      if (!apiId !== !apiHash) {
        errEl.textContent = "api_id 与 api_hash 需要同时填写";
        (apiId ? hashEl : idEl).classList.add("is-error");
        (apiId ? hashEl : idEl).setAttribute("aria-invalid", "true");
        (apiId ? hashEl : idEl).focus();
        return;
      }
      st.apiId = apiId;
      st.apiHash = apiHash;
      st.phone = cleaned.startsWith("+") ? cleaned : "+" + cleaned;

      const payload = { phone: st.phone };
      if (apiId) {
        payload.api_id = apiId;
        payload.api_hash = apiHash;
      }

      btn.classList.add("is-loading");
      btn.textContent = "发送中...";
      try {
        const res = await api("/api/accounts/login/start", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        st.flowId = res.flow_id;
        stepCode(Boolean(res.is_code_via_app));
      } catch (e) {
        errEl.textContent = loginErr(e.message);
        // 凭据被拒时自动展开高级区，省得用户再点一次
        if (e.message === "api_id_restricted" || e.message === "invalid_api_credentials") {
          const adv = body.querySelector(".adv");
          if (adv) adv.open = true;
          (apiId ? idEl : hashEl).classList.add("is-error");
          (apiId ? idEl : hashEl).setAttribute("aria-invalid", "true");
        }
        btn.classList.remove("is-loading");
        btn.textContent = "发送验证码";
      }
    };
    btn.onclick = send;
    phoneEl.onkeydown = (e) => { if (e.key === "Enter") send(); };
    phoneEl.focus();
  }

  // --- 步骤 2：验证码 ---
  function stepCode(viaApp) {
    body.innerHTML = `
      ${stepsHtml("code")}
      <div class="notice notice--ok">验证码已发送${viaApp ? "到 Telegram App" : "（短信）"}：<span class="mono">${esc(st.phone)}</span></div>
      <div class="field">
        <label class="field__label" for="am-code">验证码</label>
        <input class="input" id="am-code" inputmode="numeric" autocomplete="one-time-code"
               maxlength="10" placeholder="5 位数字" />
        <span class="field__hint">Telegram 有时会把验证码直接显示在 App 的聊天里。</span>
      </div>
      <div class="field__error" id="am-err"></div>
      <div class="modal__actions">
        <button class="btn" id="am-back">返回</button>
        <button class="btn btn--primary" id="am-verify">验证</button>
      </div>
    `;
    const codeEl = body.querySelector("#am-code");
    const errEl = body.querySelector("#am-err");
    const btn = body.querySelector("#am-verify");
    body.querySelector("#am-back").onclick = () => { dropFlow(); stepPhone(); };

    const verify = async () => {
      errEl.textContent = "";
      const code = codeEl.value.replace(/\s/g, "");
      if (!/^\d{3,10}$/.test(code)) {
        errEl.textContent = "请输入 3-10 位数字验证码";
        codeEl.focus();
        return;
      }
      btn.classList.add("is-loading");
      btn.textContent = "验证中...";
      try {
        const res = await api("/api/accounts/login/code", {
          method: "POST",
          body: JSON.stringify({ flow_id: st.flowId, code }),
        });
        if (res.need_password) stepPassword();
        else stepReady(res.user);
      } catch (e) {
        errEl.textContent = loginErr(e.message);
        btn.classList.remove("is-loading");
        btn.textContent = "验证";
        codeEl.select();
      }
    };
    btn.onclick = verify;
    codeEl.onkeydown = (e) => { if (e.key === "Enter") verify(); };
    codeEl.focus();
  }

  // --- 步骤 2b：两步验证密码（仅在账号开启 2FA 时出现） ---
  function stepPassword() {
    body.innerHTML = `
      ${stepsHtml("code")}
      <div class="notice">该账户开启了两步验证，请输入密码继续。</div>
      <div class="field">
        <label class="field__label" for="am-2fa">两步验证密码</label>
        <input class="input" id="am-2fa" type="password" autocomplete="current-password"
               placeholder="输入两步验证密码" />
      </div>
      <div class="field__error" id="am-err"></div>
      <div class="modal__actions">
        <button class="btn" id="am-cancel">取消</button>
        <button class="btn btn--primary" id="am-pw">登录</button>
      </div>
    `;
    const pwEl = body.querySelector("#am-2fa");
    const errEl = body.querySelector("#am-err");
    const btn = body.querySelector("#am-pw");
    body.querySelector("#am-cancel").onclick = closeOverlay;

    const submit = async () => {
      errEl.textContent = "";
      if (!pwEl.value) {
        errEl.textContent = "请输入两步验证密码";
        pwEl.focus();
        return;
      }
      btn.classList.add("is-loading");
      btn.textContent = "登录中...";
      try {
        const res = await api("/api/accounts/login/password", {
          method: "POST",
          body: JSON.stringify({ flow_id: st.flowId, password: pwEl.value }),
        });
        stepReady(res.user);
      } catch (e) {
        errEl.textContent = loginErr(e.message);
        btn.classList.remove("is-loading");
        btn.textContent = "登录";
        pwEl.select();
      }
    };
    btn.onclick = submit;
    pwEl.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    pwEl.focus();
  }

  // --- 步骤 3：命名并保存 ---
  function stepReady(user) {
    const uname = user && user.username ? "@" + user.username : "";
    const who = uname || (user && user.first_name ? user.first_name : st.phone);
    const suggested = who;
    body.innerHTML = `
      ${stepsHtml("ready")}
      <div class="notice notice--ok">登录成功：${esc(who)}${user && user.id ? "（ID " + esc(String(user.id)) + "）" : ""}</div>
      <div class="field">
        <label class="field__label" for="am-name">账户名称</label>
        <input class="input" id="am-name" maxlength="40" value="${esc(suggested)}" />
        <span class="field__hint">只用于在本站区分账户，之后可随时修改。</span>
      </div>
      <div class="field__error" id="am-err"></div>
      <div class="modal__actions">
        <button class="btn" id="am-cancel">取消</button>
        <button class="btn btn--primary" id="am-save">保存账户</button>
      </div>
    `;
    const nameEl = body.querySelector("#am-name");
    const errEl = body.querySelector("#am-err");
    const btn = body.querySelector("#am-save");
    body.querySelector("#am-cancel").onclick = closeOverlay;

    const save = async () => {
      errEl.textContent = "";
      btn.classList.add("is-loading");
      btn.textContent = "保存中...";
      try {
        await api("/api/accounts/login/finish", {
          method: "POST",
          body: JSON.stringify({ flow_id: st.flowId, name: nameEl.value.trim() }),
        });
        st.flowId = null;
        overlay.remove();
        toast("账户已添加", "ok");
        navigate();
      } catch (e) {
        errEl.textContent = loginErr(e.message);
        btn.classList.remove("is-loading");
        btn.textContent = "保存账户";
      }
    };
    btn.onclick = save;
    nameEl.onkeydown = (e) => { if (e.key === "Enter") save(); };
    nameEl.focus();
  }

  // --- 备用：直接粘贴 StringSession（本地脚本导出） ---
  function stepSession() {
    body.innerHTML = `
      <div class="field">
        <label class="field__label" for="am-name2">账户名称</label>
        <input class="input" id="am-name2" placeholder="例如：小号A" />
      </div>
      <div class="field">
        <label class="field__label" for="am-session">StringSession</label>
        <textarea class="textarea" id="am-session" placeholder="粘贴 scripts/login.mjs 输出的 SESSION= 后面的长串"></textarea>
        <span class="field__hint">保存前会先连接 Telegram 验证有效性，失败不会写入。</span>
      </div>
      <div class="field__error" id="am-err"></div>
      <div class="modal__actions">
        <button class="btn" id="am-cancel">取消</button>
        <button class="btn btn--primary" id="am-save2">验证并保存</button>
      </div>
    `;
    const errEl = body.querySelector("#am-err");
    const btn = body.querySelector("#am-save2");
    body.querySelector("#am-cancel").onclick = closeOverlay;
    btn.onclick = async () => {
      errEl.textContent = "";
      btn.classList.add("is-loading");
      btn.textContent = "验证中...";
      try {
        await api("/api/accounts", {
          method: "POST",
          body: JSON.stringify({
            name: body.querySelector("#am-name2").value.trim(),
            session: body.querySelector("#am-session").value.trim(),
          }),
        });
        overlay.remove();
        toast("账户已添加", "ok");
        navigate();
      } catch (e) {
        errEl.textContent = loginErr(e.message);
        btn.classList.remove("is-loading");
        btn.textContent = "验证并保存";
      }
    };
    body.querySelector("#am-name2").focus();
  }

  // --- Tab 切换 ---
  overlay.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      overlay.querySelectorAll(".tab").forEach((t) => {
        t.classList.remove("is-active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");
      dropFlow();
      if (tab.dataset.tab === "session") stepSession();
      else stepPhone();
    };
  });

  stepPhone();
}

async function verifyAccount(id, btn) {
  btn.classList.add("is-loading");
  btn.textContent = "...";
  try {
    await api(`/api/accounts/${id}/verify`, { method: "POST" });
    toast("账户可用", "ok");
  } catch (e) { toast("验证失败: " + e.message, "bad"); }
  btn.classList.remove("is-loading");
  btn.textContent = "验证";
  navigate();
}

async function switchAccount(id, btn) {
  btn.classList.add("is-loading");
  btn.textContent = "...";
  try {
    await api(`/api/accounts/${id}/switch`, { method: "POST" });
    toast("已设为默认账户", "ok");
  } catch (e) { toast("切换失败: " + e.message, "bad"); }
  btn.classList.remove("is-loading");
  btn.textContent = "设为默认";
  navigate();
}

async function deleteAccount(id) {
  if (!confirm("确认删除此账户？该账户名下的全部任务与日志将一并删除。")) return;
  try {
    await api(`/api/accounts/${id}`, { method: "DELETE" });
    toast("已删除", "ok");
    navigate();
  } catch (e) { toast("删除失败: " + e.message, "bad"); }
}

// ===== 日志页 =====
let logCursor = null;

// 日志列表空态（图标 + 标题 + 提示）
const LOGS_EMPTY = `<div class="empty"><span class="empty__icon" aria-hidden="true">📜</span><span class="empty__title">暂无日志</span><span class="empty__hint">任务执行后，这里会显示每次执行的结果</span></div>`;
// 筛选切换时的 3 行局部骨架（aria-busy 期间展示）
const LOG_SKELETON = `<div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>`.repeat(3);

async function renderLogs(el, seq) {
  logCursor = null;
  el.innerHTML = `
    <div class="stack" aria-busy="true">
      <div class="grid grid--panels">
        <div class="panel col-2"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" style="width:60%" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      </div>
      <div class="panel panel--list">
        <div class="rows">
          <div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>
          <div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>
          <div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>
          <div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>
          <div class="row row--skeleton" aria-hidden="true"><div class="row__main"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div><span class="skeleton skeleton--badge"></span><span class="skeleton skeleton--text skeleton--narrow"></span></div>
        </div>
      </div>
      <p class="empty" role="status">加载中...</p>
    </div>
  `;
  try {
    const [{ logs }, { tasks }] = await Promise.all([
      api("/api/logs?limit=50"),
      api("/api/tasks"),
    ]);
    if (seq !== currentRenderSeq) return;
    if (logs.length > 0) logCursor = logs[logs.length - 1].id;

    el.innerHTML = `
      <div class="stack">
        <div class="grid grid--panels">
          <section class="panel col-2" aria-labelledby="logs-title">
            <div class="panel__head">
              <div>
                <h2 class="panel__title" id="logs-title">执行日志</h2>
                <div class="panel__sub">倒序展示，每次执行一条</div>
              </div>
              <span class="panel__icon" aria-hidden="true">📜</span>
            </div>
            <div class="field">
              <label class="field__label" for="log-filter">按任务筛选</label>
              <select class="select" id="log-filter">
                <option value="">全部任务</option>
                ${tasks.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
              </select>
            </div>
          </section>
          <section class="panel col-1" aria-labelledby="logs-count">
            <div class="panel__head"><h2 class="panel__title" id="logs-count">本页</h2></div>
            <div class="stat stat--neutral"><span class="stat__num">${logs.length}</span><span class="stat__label">条记录</span></div>
          </section>
          <section class="panel col-1" aria-labelledby="logs-retention">
            <div class="panel__head"><h2 class="panel__title" id="logs-retention">保留策略</h2></div>
            <div class="panel__body">30 天前的日志会被随机清理。</div>
          </section>
        </div>

        <div class="grid grid--panels">
          <section class="panel panel--flat panel--list col-3" aria-label="日志列表">
            <div class="rows" id="log-body">
              ${logs.length === 0 ? LOGS_EMPTY : logs.map(logRow).join("")}
            </div>
          </section>
        </div>

        <div class="flex-between">
          <span class="dim">最多展示最近 50 条</span>
          <button class="btn" id="log-more" ${logs.length < 50 ? "disabled" : ""}>加载更多</button>
        </div>
      </div>
    `;

    const body = document.getElementById("log-body");
    const moreBtn = document.getElementById("log-more");
    document.getElementById("log-filter").onchange = async function () {
      const sel = this;
      const tid = sel.value;
      const q = tid ? `/api/logs?task_id=${tid}&limit=50` : "/api/logs?limit=50";
      // 局部加载：禁用筛选器 + 骨架行，不全屏替换
      sel.disabled = true;
      body.setAttribute("aria-busy", "true");
      body.innerHTML = LOG_SKELETON;
      try {
        const { logs } = await api(q);
        logCursor = logs.length > 0 ? logs[logs.length - 1].id : null;
        body.innerHTML = logs.length === 0 ? LOGS_EMPTY : logs.map(logRow).join("");
        moreBtn.disabled = logs.length < 50;
      } catch (e) { toast("加载失败: " + e.message, "bad"); }
      finally {
        sel.disabled = false;
        body.removeAttribute("aria-busy");
        // 追加/重渲染后重跑一次当前搜索过滤，避免新行绕过过滤器
        if (searchQuery) applySearch(searchQuery);
      }
    };
    moreBtn.onclick = async () => {
      if (logCursor === null) return;
      const tid = document.getElementById("log-filter").value;
      const q = `/api/logs?limit=50&before_id=${logCursor}${tid ? `&task_id=${tid}` : ""}`;
      try {
        const { logs } = await api(q);
        if (logs.length === 0) { moreBtn.disabled = true; return; }
        logCursor = logs[logs.length - 1].id;
        body.insertAdjacentHTML("beforeend", logs.map(logRow).join(""));
        // 追加行同样要过当前搜索过滤器
        if (searchQuery) applySearch(searchQuery);
        if (logs.length < 50) moreBtn.disabled = true;
      } catch (e) { toast("加载失败: " + e.message, "bad"); }
    };
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="stack"><div class="empty"><span class="empty__icon" aria-hidden="true">⚠️</span><span class="empty__title">加载失败</span><span class="empty__hint">${esc(e.message)}，刷新页面重试</span></div></div>`;
  }
}

function logRow(l) {
  return `<div class="row" data-search>
    <div class="row__main">
      <div class="row__title">${esc(l.task_name || "#" + l.task_id)}</div>
      <div class="row__meta">${fmtTime(l.created_at)}</div>
    </div>
    ${statusBadge(l.status)}
    <span class="dim" title="${esc(l.detail || "")}">${esc(String(l.detail || "").slice(0, 50))}</span>
    <span class="dim">${l.duration_ms ? (l.duration_ms / 1000).toFixed(1) + "s" : "-"}</span>
  </div>`;
}

// ===== 设置页 =====
function passwordScore(pw) {
  let s = 0;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

async function renderSettings(el, seq) {
  el.innerHTML = `
    <div class="stack" aria-busy="true">
      <div class="grid grid--panels">
        <div class="panel col-2"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--narrow" style="height:4px" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
        <div class="panel col-1"><div class="skeleton skeleton--title" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div><div class="skeleton skeleton--text" aria-hidden="true"></div></div>
      </div>
      <p class="empty" role="status">加载中...</p>
    </div>
  `;

  // 鉴权探针：未登录时 api() 会抛 unauthorized 并自动跳登录页。
  // 必须先探针再渲染——否则匿名访问 #/settings 会直接看到密码修改表单
  // （曾经的回归：重写时漏了这段，其他 4 个页面都有）。
  try {
    await api("/api/accounts");
  } catch (e) {
    if (e.message === "unauthorized") return; // api() 已负责跳转，这里不再渲染
    el.innerHTML = `<div class="stack"><div class="empty"><span class="empty__icon" aria-hidden="true">⚠️</span><span class="empty__title">加载失败</span><span class="empty__hint">${esc(e.message)}，刷新页面重试</span></div></div>`;
    return;
  }
  if (seq !== currentRenderSeq) return;

  el.innerHTML = `
    <div class="stack">
      <div class="grid grid--panels">
        <section class="panel col-2" aria-labelledby="set-pw">
          <div class="panel__head">
            <div>
              <h2 class="panel__title" id="set-pw">修改管理密码</h2>
              <div class="panel__sub">修改成功后所有已登录会话将失效，需重新登录</div>
            </div>
            <span class="panel__icon" aria-hidden="true">🔑</span>
          </div>
          <div class="field">
            <label class="field__label" for="pw-old">原密码</label>
            <input class="input" type="password" id="pw-old" autocomplete="current-password" />
          </div>
          <div class="field">
            <label class="field__label" for="pw-new">新密码</label>
            <input class="input" type="password" id="pw-new" autocomplete="new-password" />
            <div class="meter" id="pw-meter">
              <span class="meter__seg"></span><span class="meter__seg"></span>
              <span class="meter__seg"></span><span class="meter__seg"></span>
            </div>
            <span class="field__hint" id="pw-hint">至少 12 位，且包含两类以上字符（小写/大写/数字/符号）</span>
          </div>
          <div class="field">
            <label class="field__label" for="pw-confirm">确认新密码</label>
            <input class="input" type="password" id="pw-confirm" autocomplete="new-password" />
          </div>
          <div class="field__error" id="pw-err"></div>
          <div class="panel__foot"><button class="btn btn--primary" id="pw-save">修改密码</button></div>
        </section>

        <section class="panel col-1" aria-labelledby="set-acc">
          <div class="panel__head">
            <h2 class="panel__title" id="set-acc">Telegram 账户</h2>
            <span class="panel__icon" aria-hidden="true">👥</span>
          </div>
          <div class="panel__body">账户、会话与任务都在「账户」页管理。Session 字符串只保存在 D1，任何接口都不会返回它。</div>
          <div class="panel__foot"><a class="btn" href="#/accounts">前往账户页</a></div>
        </section>

        <section class="panel col-1" aria-labelledby="set-about">
          <div class="panel__head">
            <h2 class="panel__title" id="set-about">关于</h2>
            <span class="panel__icon" aria-hidden="true">ℹ️</span>
          </div>
          <div class="panel__body prose">管理密码以 PBKDF2-SHA256（10 万次迭代 + 随机盐）派生后存储，数据库中不保存明文；登录比对走恒定时间比较，并受同 IP 60 秒 5 次的失败限流保护。</div>
        </section>

        <section class="panel col-1" aria-labelledby="set-logout">
          <div class="panel__head">
            <h2 class="panel__title" id="set-logout">退出登录</h2>
            <span class="panel__icon" aria-hidden="true">🚪</span>
          </div>
          <div class="panel__body">退出会使服务端纪元 +1，吊销所有设备上已签发的登录 Cookie。</div>
          <div class="panel__foot"><button class="btn btn--danger" data-action="logout">退出登录</button></div>
        </section>
      </div>
    </div>
  `;

  const newPw = document.getElementById("pw-new");
  const segs = document.getElementById("pw-meter").children;
  const hint = document.getElementById("pw-hint");
  newPw.oninput = () => {
    const s = passwordScore(newPw.value);
    for (let i = 0; i < segs.length; i++) {
      segs[i].className = "meter__seg" + (i < s ? (s >= 3 ? " is-on" : " is-warn") : "");
    }
  };

  const err = document.getElementById("pw-err");
  const oldPw = document.getElementById("pw-old");
  document.getElementById("pw-save").onclick = async () => {
    err.textContent = "";
    oldPw.classList.remove("is-error");
    oldPw.removeAttribute("aria-invalid");
    const body = {
      old_password: oldPw.value,
      new_password: newPw.value,
      confirm_password: document.getElementById("pw-confirm").value,
    };
    try {
      await api("/api/password", { method: "POST", body: JSON.stringify(body) });
      toast("密码已修改，请重新登录", "ok");
      setTimeout(() => { location.hash = "#/login"; }, 600);
    } catch (e) {
      err.textContent = e.message;
      oldPw.classList.add("is-error");
      oldPw.setAttribute("aria-invalid", "true");
    }
  };
}

async function doLogout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch { /* 即使失败也跳登录页 */ }
  toast("已退出登录", "ok");
  location.hash = "#/login";
}

// ===== 工具 =====
/** HTML 转义：所有用户数据插值前必须过这里（& < > " 四类） */
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
