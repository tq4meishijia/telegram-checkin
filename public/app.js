// ===== API 封装 =====
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (res.status === 401 && !path.includes("/login")) {
    // 已在登录页时不要重复赋值（相同 hash 不会再触发 hashchange）
    if (location.hash !== "#/login") location.hash = "#/login";
    throw new Error("unauthorized");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "request_failed");
  return data;
}

function toast(msg, ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
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

function scheduleDesc(t) {
  if (t.schedule_type === "daily") return `每天 ${t.schedule_value} (${t.timezone})`;
  return `每 ${t.schedule_value} 分钟`;
}

// ===== 路由 =====
const routes = {
  "#/login": renderLogin,
  "#/": renderDashboard,
  "#/tasks": renderTasks,
  "#/logs": renderLogs,
  "#/settings": renderSettings,
};

// 当前渲染代次：每次 navigate 递增；异步渲染结果若发现代次已过期则丢弃，
// 防止旧页面的请求回调覆盖新页面。
let currentRenderSeq = 0;

function navigate() {
  const seq = ++currentRenderSeq;
  const hash = location.hash || "#/";
  const render = routes[hash] || routes["#/"];
  document.getElementById("app").innerHTML = "";
  render(document.getElementById("app"), seq);
  updateNav();
}

function updateNav() {
  const hash = location.hash || "#/";
  document.querySelectorAll("nav a[data-route]").forEach((a) => {
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
    case "delete": deleteTask(id); break;
  }
});
document.addEventListener("change", (e) => {
  if (!(e.target instanceof Element)) return;
  const el = e.target.closest('input[data-action="toggle"]');
  if (!el) return;
  toggleTask(Number(el.dataset.id), el.checked);
});
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app-root").innerHTML = `
    <div class="container">
      <nav>
        <span class="brand">TG Checkin</span>
        <a href="#/" data-route="#/">仪表盘</a>
        <a href="#/tasks" data-route="#/tasks">任务</a>
        <a href="#/logs" data-route="#/logs">日志</a>
        <a href="#/settings" data-route="#/settings">设置</a>
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
    <div class="card" style="max-width:360px;margin:80px auto;">
      <h2 style="margin-bottom:16px;">登录</h2>
      <div class="form-group">
        <label>管理密码</label>
        <input type="password" id="login-pw" placeholder="输入管理密码" />
      </div>
      <button class="btn btn-primary" id="login-btn" style="width:100%;">登录</button>
    </div>
  `;
  document.getElementById("login-btn").onclick = async () => {
    const pw = document.getElementById("login-pw").value;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: pw }) });
      toast("登录成功");
      location.hash = "#/";
    } catch { toast("密码错误"); }
  };
  document.getElementById("login-pw").onkeydown = (e) => {
    if (e.key === "Enter") document.getElementById("login-btn").click();
  };
}

// ===== 仪表盘 =====
async function renderDashboard(el, seq) {
  el.innerHTML = `<div class="card">加载中...</div>`;
  try {
    // 传浏览器本地日界，让"今日"按本地时区口径统计（服务端默认按 UTC 日界）
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const data = await api(`/api/overview?from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}`);
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `
      <div class="stats">
        <div class="stat-card success"><div class="num">${data.today.success || 0}</div><div class="label">今日成功</div></div>
        <div class="stat-card failed"><div class="num">${data.today.failed || 0}</div><div class="label">今日失败</div></div>
        <div class="stat-card skipped"><div class="num">${data.today.skipped || 0}</div><div class="label">今日跳过</div></div>
      </div>
      ${!data.sessionConfigured ? '<div class="warning">⚠️ Session 未配置，请前往<a href="#/settings">设置页</a>配置 Telegram Session。</div>' : ""}
      <div class="card">
        <h3>即将执行</h3>
        ${data.upcoming.length === 0 ? "<p style='color:#8b949e'>暂无待执行任务</p>" : `
          <table>
            <thead><tr><th>任务</th><th>目标</th><th>指令</th><th>下次执行</th></tr></thead>
            <tbody>${data.upcoming.map((t) => `
              <tr><td>${esc(t.name)}</td><td>${esc(t.bot_username)}</td><td>${esc(t.command)}</td><td>${relTime(t.next_run_at)}</td></tr>
            `).join("")}</tbody>
          </table>
        `}
      </div>
    `;
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="card">加载失败: ${esc(e.message)}</div>`;
  }
}

// ===== 任务页 =====
async function renderTasks(el, seq) {
  el.innerHTML = `<div class="card">加载中...</div>`;
  try {
    const { tasks } = await api("/api/tasks");
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `
      <div class="flex-between mb-16">
        <h2>任务列表</h2>
        <button class="btn btn-primary" id="add-task-btn">+ 新建任务</button>
      </div>
      <div class="card" style="padding:0;overflow:auto;">
        <table>
          <thead><tr><th>名称</th><th>目标</th><th>指令</th><th>排期</th><th>下次执行</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${tasks.length === 0 ? '<tr><td colspan="7" style="text-align:center;color:#8b949e;padding:24px;">暂无任务</td></tr>' : tasks.map((t) => `
            <tr>
              <td>${esc(t.name)}</td>
              <td>${esc(t.bot_username)}</td>
              <td>${esc(t.command)}</td>
              <td>${scheduleDesc(t)}${t.jitter_minutes ? ` ±${t.jitter_minutes}m` : ""}</td>
              <td>${fmtTime(t.next_run_at)}</td>
              <td>${t.last_status ? `<span class="badge badge-${t.last_status}">${t.last_status}</span>` : "-"}</td>
              <td class="flex" style="flex-wrap:nowrap;">
                <label class="switch"><input type="checkbox" ${t.enabled ? "checked" : ""} data-action="toggle" data-id="${t.id}"><span class="slider"></span></label>
                <button class="btn btn-sm run-btn" data-action="run" data-id="${t.id}">运行</button>
                <button class="btn btn-sm" data-action="edit" data-id="${t.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-action="delete" data-id="${t.id}">删除</button>
              </td>
            </tr>
          `).join("")}</tbody>
        </table>
      </div>
    `;
    document.getElementById("add-task-btn").onclick = () => showTaskModal();
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="card">加载失败: ${esc(e.message)}</div>`;
  }
}

function showTaskModal(task) {
  const isEdit = !!task;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2>${isEdit ? "编辑任务" : "新建任务"}</h2>
      <div class="form-group"><label>名称</label><input id="tf-name" value="${esc(task?.name || "")}" /></div>
      <div class="form-group"><label>目标机器人 (如 @bot 或 me)</label><input id="tf-bot" value="${esc(task?.bot_username || "")}" /></div>
      <div class="form-group"><label>指令</label><input id="tf-cmd" value="${esc(task?.command || "")}" /></div>
      <div class="form-group">
        <label>类型</label>
        <select id="tf-type">
          <option value="daily" ${task?.schedule_type === "daily" ? "selected" : ""}>每天定时</option>
          <option value="interval" ${task?.schedule_type === "interval" ? "selected" : ""}>每隔 N 分钟</option>
        </select>
      </div>
      <div class="form-group" id="fg-time"><label>时间 (如 08:00 或 08:00,20:00)</label><input id="tf-time" value="${task?.schedule_type === "daily" ? esc(task?.schedule_value || "") : ""}" /></div>
      <div class="form-group hidden" id="fg-interval"><label>间隔分钟数</label><input id="tf-interval" value="${task?.schedule_type === "interval" ? esc(task?.schedule_value || "") : ""}" /></div>
      <div class="form-group">
        <label>时区</label>
        <select id="tf-tz">
          ${["Asia/Shanghai","UTC","Asia/Tokyo","America/New_York","Europe/London"].map((tz) =>
            `<option value="${tz}" ${task?.timezone === tz ? "selected" : ""}>${tz}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group"><label>随机抖动(分钟)</label><input type="number" id="tf-jitter" value="${task?.jitter_minutes ?? 0}" min="0" /></div>
      <div class="form-group"><label><input type="checkbox" id="tf-capture" ${task?.capture_reply ? "checked" : ""} /> 抓取机器人回复</label></div>
      <div class="form-actions">
        <button class="btn" id="modal-cancel">取消</button>
        <button class="btn btn-primary" id="modal-save">保存</button>
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

  overlay.querySelector("#modal-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#modal-save").onclick = async () => {
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
    try {
      if (isEdit) {
        await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast("已更新");
      } else {
        await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
        toast("已创建");
      }
      overlay.remove();
      navigate();
    } catch (e) { toast("保存失败: " + e.message); }
  };
}

async function toggleTask(id, enabled) {
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled ? 1 : 0 }) });
    toast(enabled ? "已启用" : "已停用");
  } catch (e) { toast("操作失败: " + e.message); navigate(); }
};

async function runTask(id, btn) {
  btn.classList.add("loading");
  btn.textContent = "...";
  try {
    const res = await api(`/api/tasks/${id}/run`, { method: "POST" });
    toast(`执行结果: ${res.status}`);
  } catch (e) { toast("执行失败: " + e.message); }
  btn.classList.remove("loading");
  btn.textContent = "运行";
};

async function editTask(id) {
  try {
    const { task } = await api(`/api/tasks/${id}`);
    showTaskModal(task);
  } catch (e) { toast("加载失败: " + e.message); }
};

async function deleteTask(id) {
  if (!confirm("确认删除此任务？")) return;
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    toast("已删除");
    navigate();
  } catch (e) { toast("删除失败: " + e.message); }
};

// ===== 日志页 =====
async function renderLogs(el, seq) {
  el.innerHTML = `<div class="card">加载中...</div>`;
  try {
    const [{ logs }, { tasks }] = await Promise.all([
      api("/api/logs?limit=50"),
      api("/api/tasks"),
    ]);
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `
      <div class="flex-between mb-16">
        <h2>执行日志</h2>
        <select id="log-filter" style="width:auto;">
          <option value="">全部任务</option>
          ${tasks.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
        </select>
      </div>
      <div class="card" style="padding:0;overflow:auto;">
        <table>
          <thead><tr><th>时间</th><th>任务</th><th>状态</th><th>详情</th><th>耗时</th></tr></thead>
          <tbody id="log-body">${logs.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:#8b949e;padding:24px;">暂无日志</td></tr>' : logs.map(logRow).join("")}</tbody>
        </table>
      </div>
    `;
    document.getElementById("log-filter").onchange = async function () {
      const tid = this.value;
      const q = tid ? `/api/logs?task_id=${tid}&limit=50` : "/api/logs?limit=50";
      const { logs } = await api(q);
      document.getElementById("log-body").innerHTML = logs.length === 0
        ? '<tr><td colspan="5" style="text-align:center;color:#8b949e;padding:24px;">暂无日志</td></tr>'
        : logs.map(logRow).join("");
    };
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="card">加载失败: ${esc(e.message)}</div>`;
  }
}

function logRow(l) {
  return `<tr>
    <td>${fmtTime(l.created_at)}</td>
    <td>${esc(l.task_name || "#"+l.task_id)}</td>
    <td><span class="badge badge-${l.status}">${l.status}</span></td>
    <td title="${esc(l.detail || "")}">${esc((l.detail || "").slice(0, 60))}</td>
    <td>${l.duration_ms ? (l.duration_ms / 1000).toFixed(1) + "s" : "-"}</td>
  </tr>`;
}

// ===== 设置页 =====
async function renderSettings(el, seq) {
  el.innerHTML = `<div class="card">加载中...</div>`;
  try {
    const data = await api("/api/session");
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `
      <h2 style="margin-bottom:16px;">设置</h2>
      <div class="card">
        <h3>Telegram Session</h3>
        ${data.configured && data.account ? `
          <div class="flex" style="margin-top:8px;">
            <span class="badge badge-success">已配置</span>
            <span>${esc(data.account.name || "")} ${data.account.username ? "(@" + esc(data.account.username) + ")" : ""}</span>
          </div>
          <button class="btn btn-danger mt-16" id="clear-session">清除 Session</button>
        ` : data.configured ? `
          <div class="warning mt-8">Session 已配置但无法验证账号: ${esc(data.error || "unknown")}</div>
          <button class="btn btn-danger mt-16" id="clear-session">清除 Session</button>
        ` : `
          <div class="warning mt-8">Session 未配置</div>
          <div class="form-group mt-16">
            <label>粘贴 StringSession</label>
            <textarea id="session-input" rows="4" placeholder="粘贴 session 字符串..."></textarea>
          </div>
          <button class="btn btn-primary" id="save-session">保存并验证</button>
        `}
      </div>
      <div class="card mt-16">
        <h3>关于</h3>
        <p style="font-size:13px;color:#8b949e;">管理密码通过 Cloudflare Workers Secrets 配置，修改需使用 <code>wrangler secret put ADMIN_PASSWORD</code>。</p>
        <p style="font-size:13px;color:#8b949e;margin-top:4px;">Telegram API 凭据在 <a href="https://my.telegram.org/apps" target="_blank">my.telegram.org/apps</a> 获取。</p>
      </div>
    `;

    const clearBtn = document.getElementById("clear-session");
    if (clearBtn) {
      clearBtn.onclick = async () => {
        if (!confirm("确认清除 Session？所有签到任务将停止。")) return;
        try {
          await api("/api/session", { method: "DELETE" });
          toast("已清除");
          navigate();
        } catch (e) { toast("清除失败: " + e.message); }
      };
    }

    const saveBtn = document.getElementById("save-session");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const session = document.getElementById("session-input").value.trim();
        if (!session) return toast("请输入 session");
        saveBtn.classList.add("loading");
        saveBtn.textContent = "验证中...";
        try {
          const res = await api("/api/session", { method: "PUT", body: JSON.stringify({ session }) });
          toast("保存成功: " + (res.account?.name || ""));
          navigate();
        } catch (e) { toast("验证失败: " + e.message); }
        saveBtn.classList.remove("loading");
        saveBtn.textContent = "保存并验证";
      };
    }
  } catch (e) {
    if (seq !== currentRenderSeq) return;
    el.innerHTML = `<div class="card">加载失败: ${esc(e.message)}</div>`;
  }
}

// ===== 工具 =====
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
