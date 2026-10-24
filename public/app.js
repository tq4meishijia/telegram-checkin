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
}

function updateNav() {
  const hash = location.hash || "#/";
  document.querySelectorAll("nav a.nav-link").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-route") === hash);
  });
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
  if (el) toggleTask(Number(el.dataset.id), el.checked);
});

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app-root").innerHTML = `
    <div class="shell">
      <nav>
        <span class="brand">TG Checkin</span>
        <span class="links">
          <a class="nav-link" href="#/" data-route="#/">仪表盘</a>
          <a class="nav-link" href="#/tasks" data-route="#/tasks">任务</a>
          <a class="nav-link" href="#/accounts" data-route="#/accounts">账户</a>
          <a class="nav-link" href="#/logs" data-route="#/logs">日志</a>
          <a class="nav-link" href="#/settings" data-route="#/settings">设置</a>
        </span>
      </nav>
      <div id="app"></div>
    </div>
  `;
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
      <div class="card" style="max-width:380px;width:100%;">
        <div>
          <h1 class="card__title" style="font-size:20px;">登录 TG Checkin</h1>
          <p class="card__sub">输入管理密码继续</p>
        </div>
        <div class="field">
          <label class="field__label" for="login-pw">管理密码</label>
          <input class="input" type="password" id="login-pw" placeholder="输入管理密码" autocomplete="current-password" />
        </div>
        <div class="field__error" id="login-err"></div>
        <button class="btn btn--primary btn--block" id="login-btn">登录</button>
        <p class="field__hint">初始密码为 <code class="mono">admin</code>，登录后请立即在「设置」页修改。</p>
      </div>
    </div>
  `;
  const btn = document.getElementById("login-btn");
  const pw = document.getElementById("login-pw");
  const err = document.getElementById("login-err");
  const submit = async () => {
    err.textContent = "";
    btn.classList.add("is-loading");
    btn.textContent = "登录中...";
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw.value }) });
      toast("登录成功", "ok");
      location.hash = "#/";
    } catch (e) {
      err.textContent = e.message === "too_many_attempts" ? "失败次数过多，请稍后再试" : "密码错误";
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
  el.innerHTML = `<div class="bento"><div class="card col-4"><p class="muted">加载中...</p></div></div>`;
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
      <div class="bento">
        ${!data.sessionConfigured ? `
        <div class="notice col-4">
          <span>⚠️</span>
          <span>尚未配置可用的 Telegram 账户，签到任务无法执行。<a href="#/accounts">前往账户页添加</a></span>
        </div>` : ""}

        <div class="card card--lift col-2 row-2">
          <div class="card__head">
            <div>
              <div class="card__title">今日执行</div>
              <div class="card__sub">按本地时区统计</div>
            </div>
            <span class="card__icon">📊</span>
          </div>
          <div class="stat-row mt-8">
            <div class="stat stat--ok"><span class="stat__num">${t.success || 0}</span><span class="stat__label">成功</span></div>
            <div class="stat stat--bad"><span class="stat__num">${t.failed || 0}</span><span class="stat__label">失败</span></div>
            <div class="stat stat--neutral"><span class="stat__num">${t.skipped || 0}</span><span class="stat__label">跳过</span></div>
          </div>
          <div class="card__body">跳过多为「迟到超过 30 分钟不补发」或「已被其他执行抢走」，属正常行为。</div>
        </div>

        <div class="card card--lift col-1">
          <div class="card__head"><div class="card__title">默认账户</div><span class="card__icon">👤</span></div>
          <div class="card__body">${accBadge}</div>
          <div class="card__body">${esc(acc ? (acc.name + (acc.tg_username ? " (@" + esc(acc.tg_username) + ")" : "")) : "尚未添加账户")}</div>
        </div>

        <div class="card card--lift col-1">
          <div class="card__head"><div class="card__title">任务</div><span class="card__icon">🗓️</span></div>
          <div class="stat stat--neutral"><span class="stat__num">${data.taskCount || 0}</span><span class="stat__label">签到任务</span></div>
          <div class="card__body">${data.accountCount || 0} 个 Telegram 账户</div>
        </div>

        <div class="card card--lift col-1">
          <div class="card__head"><div class="card__title">告警</div><span class="card__icon">🔔</span></div>
          <div class="card__body">同一任务连续失败 3 次起，会通过所属账户向「已保存消息」发一条告警。</div>
        </div>

        <div class="card card--lift col-1">
          <div class="card__head"><div class="card__title">密码</div><span class="card__icon">🔑</span></div>
          <div class="card__body">以 PBKDF2 哈希存储，可在设置页修改。</div>
          <div class="card__foot"><a class="btn btn--sm" href="#/settings">去修改</a></div>
        </div>

        <div class="card col-2">
          <div class="card__head"><div class="card__title">即将执行</div></div>
          <div class="rows">
            ${(data.upcoming || []).length === 0 ? '<p class="empty">未来 24 小时内没有待执行任务</p>' :
              data.upcoming.map((u) => `
                <div class="row">
                  <div class="row__main">
                    <div class="row__title">${esc(u.name)}</div>
                    <div class="row__meta">${esc(u.bot_username)} · ${esc(u.command)}</div>
                  </div>
                  <span class="badge badge--neutral">${relTime(u.next_run_at)}</span>
                </div>`).join("")}
          </div>
        </div>

        <div class="card col-2">
          <div class="card__head"><div class="card__title">快捷操作</div></div>
          <div class="btn-row">
            <button class="btn btn--primary" data-action="add-task">+ 新建任务</button>
            <button class="btn" data-action="add-account">+ 添加账户</button>
            <a class="btn" href="#/logs">查看日志</a>
          </div>
          <div class="card__body">任务每分钟由 cron 扫描一次，单轮最多执行 10 条，串行发送以避免触发 Telegram 风控。</div>
        </div>
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="bento"><div class="card col-4"><p class="empty">加载失败: ${esc(e.message)}</p></div></div>`;
  }
}

// ===== 任务页 =====
async function renderTasks(el, seq) {
  el.innerHTML = `<div class="bento"><div class="card col-4"><p class="muted">加载中...</p></div></div>`;
  try {
    const [{ tasks }, { accounts }] = await Promise.all([api("/api/tasks"), api("/api/accounts")]);
    if (seq !== currentRenderSeq) return;

    const enabledCount = tasks.filter((t) => Number(t.enabled) === 1).length;

    el.innerHTML = `
      <div class="bento">
        <div class="card col-2">
          <div class="card__head">
            <div>
              <div class="card__title">签到任务</div>
              <div class="card__sub">共 ${tasks.length} 个，${enabledCount} 个启用中</div>
            </div>
            <span class="card__icon">🗓️</span>
          </div>
          <div class="card__foot"><button class="btn btn--primary" data-action="add-task">+ 新建任务</button></div>
        </div>
        <div class="card col-1">
          <div class="card__title">目标账户</div>
          <div class="stat stat--neutral"><span class="stat__num">${accounts.length}</span><span class="stat__label">个可用账户</span></div>
        </div>
        <div class="card col-1">
          <div class="card__title">最近状态</div>
          <div class="card__body">${tasks.length === 0 ? "暂无任务" : tasks.filter((t) => t.last_status).slice(0, 1).map((t) => statusBadge(t.last_status)).join("") || '<span class="badge badge--neutral">未执行</span>'}</div>
        </div>

        ${tasks.length === 0 ? `
          <div class="card card--dashed col-4" data-action="add-task">
            <div>
              <div class="card__title">还没有任务</div>
              <div class="card__sub">点击新建第一个签到任务</div>
            </div>
          </div>` : tasks.map((t) => taskCard(t, accounts)).join("")}
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="bento"><div class="card col-4"><p class="empty">加载失败: ${esc(e.message)}</p></div></div>`;
  }
}

function taskCard(t, accounts) {
  const acc = accounts.find((a) => Number(a.id) === Number(t.account_id));
  return `
    <div class="card card--lift col-2">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(t.name)}</div>
          <div class="row__meta">${esc(t.bot_username)} · <span class="mono">${esc(t.command)}</span></div>
        </div>
        <label class="switch" title="启用/停用">
          <input type="checkbox" data-action="toggle" data-id="${t.id}" ${Number(t.enabled) === 1 ? "checked" : ""} aria-label="启用 ${esc(t.name)}">
          <span class="slider"></span>
        </label>
      </div>
      <div class="card__body">
        <div>${scheduleDesc(t)}${t.jitter_minutes ? ` ±${t.jitter_minutes}m` : ""}</div>
        <div class="dim">下次 ${fmtTime(t.next_run_at)}（${relTime(t.next_run_at)}）</div>
        <div class="dim">账户 ${esc(acc ? acc.name : "#" + t.account_id)}${acc && acc.is_default ? " · 默认" : ""}</div>
        ${Number(t.capture_reply) === 1 ? `<div class="dim">抓取回复（等待 ${t.reply_wait_sec}s）</div>` : ""}
      </div>
      <div class="card__foot">
        ${t.last_status ? statusBadge(t.last_status) : '<span class="badge badge--neutral">未执行</span>'}
        ${t.last_error ? `<span class="dim" title="${esc(t.last_error)}">${esc(String(t.last_error).slice(0, 40))}</span>` : ""}
        <span class="row__actions">
          <button class="btn btn--sm" data-action="run" data-id="${t.id}">运行</button>
          <button class="btn btn--sm" data-action="edit" data-id="${t.id}">编辑</button>
          <button class="btn btn--sm btn--danger" data-action="delete-task" data-id="${t.id}">删除</button>
        </span>
      </div>
    </div>`;
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
    <div class="modal" role="dialog" aria-modal="true">
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

async function toggleTask(id, enabled) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
    toast(enabled ? "已启用" : "已停用", "ok");
  } catch (e) { toast("操作失败: " + e.message, "bad"); navigate(); }
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
  el.innerHTML = `<div class="bento"><div class="card col-4"><p class="muted">加载中...</p></div></div>`;
  try {
    const { accounts } = await api("/api/accounts");
    if (seq !== currentRenderSeq) return;
    const okCount = accounts.filter((a) => a.status === "ok").length;

    el.innerHTML = `
      <div class="bento">
        <div class="card col-2">
          <div class="card__head">
            <div>
              <div class="card__title">Telegram 账户</div>
              <div class="card__sub">共 ${accounts.length} 个，${okCount} 个可用</div>
            </div>
            <span class="card__icon">👥</span>
          </div>
          <div class="card__body">每个账户独立保存会话与签到任务，可并行运行、互不干扰。重启后状态由数据库自动恢复。</div>
          <div class="card__foot"><button class="btn btn--primary" data-action="add-account">+ 添加账户</button></div>
        </div>
        <div class="card col-1">
          <div class="card__title">默认账户</div>
          <div class="card__body">${accounts.length === 0 ? "无" : esc((accounts.find((a) => Number(a.is_default) === 1) || accounts[0]).name)}</div>
          <div class="dim">新建任务默认归属它</div>
        </div>
        <div class="card col-1">
          <div class="card__title">登录方式</div>
          <div class="card__body">本地脚本 <span class="mono">scripts/login.mjs</span> 取得 StringSession 后粘贴到此处。</div>
        </div>

        ${accounts.map((a) => accountCard(a)).join("")}
        <div class="card card--dashed col-2" data-action="add-account">
          <div>
            <div class="card__title">+ 添加账户</div>
            <div class="card__sub">粘贴新的 StringSession</div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="bento"><div class="card col-4"><p class="empty">加载失败: ${esc(e.message)}</p></div></div>`;
  }
}

function accountCard(a) {
  return `
    <div class="card card--lift col-2">
      <div class="card__head">
        <div>
          <div class="card__title">${esc(a.name)} ${Number(a.is_default) === 1 ? '<span class="badge badge--ok">默认</span>' : ""}</div>
          <div class="row__meta">${a.tg_username ? "@" + esc(a.tg_username) : "未获取到用户名"}${Number(a.enabled) !== 1 ? " · 已停用" : ""}</div>
        </div>
        <span class="card__icon">👤</span>
      </div>
      <div class="card__body">
        <div>${statusBadge(a.status)}${a.last_error && a.status === "invalid" ? ` <span class="dim" title="${esc(a.last_error)}">${esc(String(a.last_error).slice(0, 40))}</span>` : ""}</div>
        <div class="dim">最近验证 ${fmtTime(a.last_verified_at)}</div>
      </div>
      <div class="card__foot">
        <span class="row__actions">
          <button class="btn btn--sm" data-action="verify-account" data-id="${a.id}">验证</button>
          ${Number(a.is_default) === 1 ? "" : `<button class="btn btn--sm" data-action="switch-account" data-id="${a.id}">设为默认</button>`}
          <button class="btn btn--sm btn--danger" data-action="delete-account" data-id="${a.id}">删除</button>
        </span>
      </div>
    </div>`;
}

function showAccountModal() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal__title">添加 Telegram 账户</div>
      <div class="field">
        <label class="field__label" for="af-name">账户名称</label>
        <input class="input" id="af-name" placeholder="例如：小号A" />
      </div>
      <div class="field">
        <label class="field__label" for="af-session">StringSession</label>
        <textarea class="textarea" id="af-session" placeholder="粘贴 scripts/login.mjs 输出的 SESSION= 后面的长串"></textarea>
        <span class="field__hint">保存前会先连接 Telegram 验证有效性，失败不会写入。</span>
      </div>
      <div class="field__error" id="af-err"></div>
      <div class="modal__actions">
        <button class="btn" id="af-cancel">取消</button>
        <button class="btn btn--primary" id="af-save">验证并保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const err = overlay.querySelector("#af-err");
  overlay.querySelector("#af-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#af-save").onclick = async () => {
    err.textContent = "";
    const body = {
      name: overlay.querySelector("#af-name").value.trim(),
      session: overlay.querySelector("#af-session").value.trim(),
    };
    try {
      await api("/api/accounts", { method: "POST", body: JSON.stringify(body) });
      toast("账户已添加", "ok");
      overlay.remove();
      navigate();
    } catch (e) { err.textContent = e.message; }
  };
  overlay.querySelector("#af-name").focus();
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

async function renderLogs(el, seq) {
  logCursor = null;
  el.innerHTML = `<div class="bento"><div class="card col-4"><p class="muted">加载中...</p></div></div>`;
  try {
    const [{ logs }, { tasks }] = await Promise.all([
      api("/api/logs?limit=50"),
      api("/api/tasks"),
    ]);
    if (seq !== currentRenderSeq) return;
    if (logs.length > 0) logCursor = logs[logs.length - 1].id;

    el.innerHTML = `
      <div class="bento">
        <div class="card col-2">
          <div class="card__head">
            <div>
              <div class="card__title">执行日志</div>
              <div class="card__sub">倒序展示，每次执行一条</div>
            </div>
            <span class="card__icon">📜</span>
          </div>
          <div class="field">
            <label class="field__label" for="log-filter">按任务筛选</label>
            <select class="select" id="log-filter">
              <option value="">全部任务</option>
              ${tasks.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="card col-1">
          <div class="card__title">本页</div>
          <div class="stat stat--neutral"><span class="stat__num">${logs.length}</span><span class="stat__label">条记录</span></div>
        </div>
        <div class="card col-1">
          <div class="card__title">保留策略</div>
          <div class="card__body">30 天前的日志会被随机清理。</div>
        </div>
        <div class="card col-4" style="padding:0;">
          <div class="rows" id="log-body">
            ${logs.length === 0 ? '<p class="empty">暂无日志</p>' : logs.map(logRow).join("")}
          </div>
        </div>
        <div class="col-4 flex-between">
          <span class="dim">最多展示最近 50 条</span>
          <button class="btn" id="log-more" ${logs.length < 50 ? "disabled" : ""}>加载更多</button>
        </div>
      </div>
    `;

    const body = document.getElementById("log-body");
    const moreBtn = document.getElementById("log-more");
    document.getElementById("log-filter").onchange = async function () {
      const tid = this.value;
      const q = tid ? `/api/logs?task_id=${tid}&limit=50` : "/api/logs?limit=50";
      try {
        const { logs } = await api(q);
        logCursor = logs.length > 0 ? logs[logs.length - 1].id : null;
        body.innerHTML = logs.length === 0 ? '<p class="empty">暂无日志</p>' : logs.map(logRow).join("");
        moreBtn.disabled = logs.length < 50;
      } catch (e) { toast("加载失败: " + e.message, "bad"); }
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
        if (logs.length < 50) moreBtn.disabled = true;
      } catch (e) { toast("加载失败: " + e.message, "bad"); }
    };
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="bento"><div class="card col-4"><p class="empty">加载失败: ${esc(e.message)}</p></div></div>`;
  }
}

function logRow(l) {
  return `<div class="row">
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

function renderSettings(el, seq) {
  el.innerHTML = `
    <div class="bento">
      <div class="card col-2 row-2">
        <div class="card__head">
          <div>
            <div class="card__title">修改管理密码</div>
            <div class="card__sub">修改成功后所有已登录会话将失效，需重新登录</div>
          </div>
          <span class="card__icon">🔑</span>
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
        <div class="card__foot"><button class="btn btn--primary" id="pw-save">修改密码</button></div>
      </div>

      <div class="card col-2">
        <div class="card__head">
          <div><div class="card__title">Telegram 账户</div></div>
          <span class="card__icon">👥</span>
        </div>
        <div class="card__body">账户、会话与任务都在「账户」页管理。Session 字符串只保存在 D1，任何接口都不会返回它。</div>
        <div class="card__foot"><a class="btn" href="#/accounts">前往账户页</a></div>
      </div>

      <div class="card col-2">
        <div class="card__head">
          <div><div class="card__title">关于</div></div>
          <span class="card__icon">ℹ️</span>
        </div>
        <div class="card__body prose">
          管理密码以 PBKDF2-SHA256（10 万次迭代 + 随机盐）派生后存储，数据库中不保存明文；
          登录比对走恒定时间比较，并受同 IP 60 秒 5 次的失败限流保护。
        </div>
      </div>

      <div class="card col-2">
        <div class="card__head">
          <div><div class="card__title">退出登录</div></div>
          <span class="card__icon">🚪</span>
        </div>
        <div class="card__body">退出会使服务端纪元 +1，吊销所有设备上已签发的登录 Cookie。</div>
        <div class="card__foot"><button class="btn btn--danger" data-action="logout">退出登录</button></div>
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
  document.getElementById("pw-save").onclick = async () => {
    err.textContent = "";
    const body = {
      old_password: document.getElementById("pw-old").value,
      new_password: newPw.value,
      confirm_password: document.getElementById("pw-confirm").value,
    };
    try {
      await api("/api/password", { method: "POST", body: JSON.stringify(body) });
      toast("密码已修改，请重新登录", "ok");
      setTimeout(() => { location.hash = "#/login"; }, 600);
    } catch (e) { err.textContent = e.message; }
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
