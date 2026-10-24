# UI 重设计 · 体验规范（Phase 2 交付物）

> 项目：telegram-checkin 管理前端（Cloudflare Workers + Hono + D1 + 原生零构建 SPA）
> 风格唯一依据：`docs/stylekit-dashboard-layout.md`；视觉基线：`docs/ui-redesign/01-visual-spec.md`（下称「P1」）
> 本文档读者：Phase 3 前端工程师（直接改 `public/app.js` / `public/style.css` / `public/index.html`）
> 硬约束 recap：零构建、零外部字体/CDN、零新增静态文件；hash 路由 / 全部 API / 业务逻辑 / `data-action` 事件委托 / `esc()` 不变；保留 `prefers-color-scheme` 暗色模式与 `prefers-reduced-motion` 降级；保留 `tests/frontend.test.ts` 断言的 app.js 功能锚点（见 §9-C1）。
> 本文只规范视觉与布局层的体验；所有取值沿用 P1 token（`--pad-*` / `--gap-*` / `--radius-*` / `--fs-*` / 语义色），不重复造轮子；凡本文与 P1 冲突处，按 §9 裁决表执行（禁止项 > 一致性 > 创意）。

---

## 0. 总览：一次登录后的完整任务流

```
#/login ──登录成功──> #/ 仪表盘 ──┬──> #/tasks 任务 ──> [新建/编辑任务模态] ──> 运行 / 开关 / 删除
                                  ├──> #/accounts 账户 ──> [添加账户向导模态：手机号→验证码→(2FA)→保存 | 粘贴Session]
                                  ├──> #/logs 日志 ──> 按任务筛选 / 加载更多
                                  └──> #/settings 设置 ──> 修改密码 ──> 自动回 #/login
```

- 六个路由字符串、渲染函数、API 全部不变；本文只改壳结构、类名、空/加载/错误态与交互细节。
- 页面骨架（侧栏 + 顶栏 + 内容）在 `DOMContentLoaded` 一次性注入 `#app-root`，之后只重渲染 `#app`（`.content`）。

---

## 1. 全局框架 IA

### 1.1 壳结构（唯一骨架，P1 §5 的落地）

```html
<body>
  <div id="app-root">
    <div class="layout">
      <aside class="sidebar" id="sidebar">…</aside>
      <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>
      <div class="main">
        <header class="topbar">…</header>
        <main class="content" id="app"></main>
      </div>
    </div>
  </div>
</body>
```

- `.layout { display:flex; min-height:100vh; }`；`.sidebar` 宽 `var(--sidebar-w)`=256px，两种色彩模式下都是深色签名（P1 §2.1）；`.main { flex:1; min-width:0; display:flex; flex-direction:column; }`；`.content { flex:1; padding: var(--pad-container); max-width:1400px; margin:0 auto; width:100%; }`。
- `#app` 是唯一渲染目标（hash 路由 → `render*` 函数写 `#app.innerHTML`）；`#app-root` 包裹壳，二者 id 必须保留（契约锚点）。

### 1.2 侧边栏（后台页唯一主导航）

- 结构自上而下：品牌区（高 56px，`🤖` + `TG Checkin`，白字 600）→ 导航区（`<nav aria-label="主导航">`，5 项）→ 底部用户区（`margin-top:auto`）。
- 导航 5 项（顺序即优先级，与现状一致）：

| 顺序 | 路由 | 图标 | 文案 |
|---|---|---|---|
| 1 | `#/` | 📊 | 仪表盘 |
| 2 | `#/tasks` | 🗓️ | 任务 |
| 3 | `#/accounts` | 👥 | 账户 |
| 4 | `#/logs` | 📜 | 日志 |
| 5 | `#/settings` | ⚙️ | 设置 |

- 每项 `<a class="sidebar__link" href="#/tasks" data-route="#/tasks">`；当前页同时具备 `is-active` 类与 `aria-current="page"`（双保险：CSS 类管视觉，ARIA 管读屏；裁决 C6）。**不加左侧粗边框条**（P1 风格红线）。
- 底部用户区：头像 `.avatar`（`A`，32×32，`--accent-strong` 底白字）+ 两行文字（`管理员` 13px/500 白；`admin` 12px `--sidebar-text`）+ 退出按钮（`🚪 退出`，`data-action="logout"` 不变，幽灵反色变体）。

### 1.3 顶栏（后台页）

左 → 右：汉堡钮（仅 <768px）→ 页面标题 `<h1 class="topbar__title">` → 右侧三件套（搜索 / 通知铃 / 用户区，`margin-left:auto`）。高度 `var(--topbar-h)`=56px，白底 1px 下边框，sticky。标题文本由 `updateNav()` 按路由同步（映射表见 §8.4）。

### 1.4 登录页 ↔ 后台页 的框架切换（`is-auth` 机制，JS 改动最小化）

**裁决：不动壳的渲染逻辑，用 `body.is-auth` 类由 CSS 切换。**

- `updateNav()` 内一行：`document.body.classList.toggle("is-auth", hash === "#/login");`（`updateNav` 已被 `navigate()` 每次调用，天然覆盖首次加载与后续路由切换，无需新挂钩）。
- CSS（Phase 3 落地）：

```css
body.is-auth .sidebar,
body.is-auth .sidebar-backdrop,
body.is-auth .topbar { display: none; }
body.is-auth .content { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
```

- 登录卡在 `.content` 内居中：保留 `.center-col` 作内层包裹（`display:flex; flex-direction:column; align-items:center;`），卡片 `max-width:400px; width:100%`。登录态下汉堡/侧栏/顶栏全部不可见，无抽屉、无焦点陷阱问题。
- 未登录访问 `#/` 等页：各 `render*` 的 `api()` 探针抛 `unauthorized` → `api()` 已负责跳 `#/login`（逻辑零改动），此时 `is-auth` 由 `updateNav` 在跳转后同步。

---

## 2. 顶栏三件套裁决

### 2.1 搜索框 —— 裁决：**实现为「当前页客户端过滤」**（纯视觉层，零接口）

风格要求顶栏含搜索（签名组件），但不允许假控件。客户端过滤可零接口风险地做成真功能，故实现而非移除。

- **生效范围**（路由 → 过滤容器选择器，`SEARCH_SCOPES` 表，代码见 §8.5）：

| 路由 | 过滤容器 | 过滤对象 |
|---|---|---|
| `#/` 仪表盘 | `.panel--upcoming .rows` | 「即将执行」列表行（不碰 KPI 与其他面板） |
| `#/tasks` | `.grid--cards` | 任务卡（不含头部统计面板、不含 dashed 添加卡） |
| `#/accounts` | `.grid--cards` | 账户卡（不含头部统计面板、不含 dashed 添加卡） |
| `#/logs` | `#log-body` | 已加载的日志行 |
| `#/settings`、`#/login` | 无 | **整槽隐藏**（`hidden` 类，无可过滤列表则不留控件） |

- **匹配字段**：每张卡/行内 `.panel__title, .panel__sub, .row__title, .row__meta, .mono` 的 textContent 拼接后小写 `includes` 查询词。即任务卡匹配「名称 / 机器人 / 指令 / 排期文案 / 账户名」，账户卡匹配「名称 / @username」，日志行匹配「任务名 / 时间 / 详情摘要」。按钮文字（运行/编辑/删除）与徽章不参与匹配，避免「运行」命中全部卡片。
- **匹配即过滤**：命中 `.is-filtered { display:none !important; }`；有查询词时同时隐藏 `.panel--dashed`（添加卡不是结果）。
- **无结果提示**：容器内动态插入 `<p class="empty" data-filter-empty role="status">没有匹配“{q}”的结果<span class="empty__hint">换个关键词，或清空搜索框查看全部</span></p>`（`{q}` 必须过 `esc()`）；查询清空后 `hidden` 复位。
- **切换页面即清空**：`navigate()` 里 `searchInput.value = ""`（DOM 重建后天然无过滤残留）。
- **日志「加载更多」追加后**：追加完对追加行重跑一次当前过滤（一行 `applySearch(q)`），否则新行绕过过滤器。
- 输入 `<input type="search" class="input topbar__search" id="topbar-search" aria-label="搜索当前页列表">`，无 form 包裹（Enter 不提交、不刷新）；`input` 事件直连（列表 ≤ 数百条，无需防抖）。
- 尺寸：≥1024px 宽 240px；768–1023px 宽 160px；**<768px 隐藏**（顶栏只剩汉堡+标题+铃铛+头像，移动端以日志页的任务下拉筛选 + 短列表弥补；隐藏而非置灰，避免假控件）。

### 2.2 通知铃 —— 裁决：**跳 `#/logs` 的链接，不带未读点**

- `<a class="icon-btn" href="#/logs" aria-label="查看执行日志">🔔</a>`，hover 底色按 P1 §6.2。
- **不做的原因**：未读点唯一可用数据是 `/api/overview` 的 `today.failed`，但顶栏是持久壳——一次性获取会随时间失效（跑过一次任务后红点就是谎言），每次导航重fetch则新增请求面与失败态；「今日失败」已在仪表盘 KPI 与日志徽章中充分暴露。按「禁止假控件」精神，宁缺毋假。
- 预留升级路径（本文不实现）：若团队坚持红点，方案为 `navigate()` 后 fire-and-forget 拉 `/api/overview`，`today.failed > 0` 时给铃铛加 `.dot`（6px `--bad` 圆点），失败静默忽略——需接受「每页一次额外请求」。

### 2.3 用户区 —— 裁决：头像 + 「管理员」纯展示，<640px 只留头像

- `.topbar__user` = `.avatar`（28×28，`A`）+ `管理员`（13px）；**不做下拉菜单**（无菜单基础设施，且退出登录在侧栏底部与设置页都有入口，重复入口违背一致性）。非交互元素，不加 `cursor:pointer`/`role`。

---

## 3. 逐页面布局规范

通用约定：
- 每页根元素 = `<div class="stack">`（`display:flex; flex-direction:column; gap: var(--gap-lg)`），内部按「notice → KPI 行 → 面板网格 → 全宽面板」顺序堆叠；禁止手写 margin 微调。
- 面板网格 `.grid.grid--panels`（3 列）+ `.col-2`（span 2）；卡片网格 `.grid.grid--cards`（2 列）；KPI 行 `.grid.grid--kpi`（4 列）。全部 <1024px 塌陷为 1 列（`.col-*` 复位 `grid-column:auto`），`.grid--cards` <768px 塌 1 列。
- 面板标题 `.panel__title` 用 `<h2>`（P1 §3：≥768px 自动升 H2 档），面板用 `<section aria-labelledby="...">`；顶栏 `.topbar__title` 是全页唯一 `<h1>`（登录页除外，见 §3.6）。
- 页面级错误态统一：`.empty`（⚠️ + 「加载失败」+ `esc(消息)` + 「刷新页面重试」），替换现状 `<p class="empty">加载失败: ...</p>`。

### 3.1 仪表盘 `#/`（renderDashboard）

数据：`/api/overview` → `today{success,failed,skipped}`、`defaultAccount{name,tg_username,status}`、`taskCount`、`accountCount`、`sessionConfigured`、`upcoming[]{name,bot_username,command,next_run_at}`。

```
┌─ .stack ────────────────────────────────────────────────┐
│ [notice warn] 仅 sessionConfigured=false：⚠️ 尚未配置可用账户… │
│ .grid--kpi：┌今日成功┐┌今日失败┐┌签到任务┐┌Telegram账户┐   │
│ .grid--panels：┌─ 今日执行 (col-2) ──┐┌ 默认账户 (col-1) ┐ │
│               │ stat-row: 成功/失败/跳过 ││ 徽章+名称(@u)  │ │
│ .grid--panels：┌快捷操作┐┌告警说明┐┌密码┐                  │
│ .panel--upcoming（全宽）：即将执行 · .rows 列表             │
└──────────────────────────────────────────────────────────┘
```

| 区块 | 规格 | 数据字段 |
|---|---|---|
| notice | `.notice`（warn 档）全宽，⚠️ 前缀 + 文案 + `<a href="#/accounts">前往账户页添加</a>`；**仅在 `sessionConfigured=false` 时渲染** | `sessionConfigured` |
| KPI×4 | `.kpi`：label + `.kpi__value`（36px/600/tabular-nums）+ **无趋势行**（无历史数据，不编造，见下） | `today.success`、`today.failed`、`taskCount`、`accountCount` |
| 今日执行（主，col-2） | `.panel__head`（标题 + sub「按本地时区统计」+ 📊 图标）→ `.stat-row` 三项 `.stat`（`.stat__num` = `--fs-h2`/600/tabular-nums，色 `--ok-text`/`--bad-text`/`--text`）→ `.panel__body` 说明文案（保留现状「跳过多为…」） | `today.success/failed/skipped` |
| 默认账户（辅，col-1） | 徽章 `statusBadge(status)` 或「未配置」warn 徽章 + 名称（`name` + `(@tg_username)`，无则「尚未添加账户」）+ foot 链接「管理账户」→ `#/accounts` | `defaultAccount.*` |
| 快捷操作（col-1） | `.btn-row`：`+ 新建任务`(primary, add-task) / `+ 添加账户`(add-account) / `查看日志`(a→#/logs) + body 说明（保留现状 cron 文案） | — |
| 告警说明（col-1） | 🔔 + 现状文案（连续失败 3 次发告警） | — |
| 密码（col-1） | 🔑 + 现状文案 + foot「去修改」→ `#/settings` | — |
| 即将执行（全宽） | `.panel.panel--upcoming`，`.panel--flat`（靠边框分隔）→ `.rows`；空态见 §6.1 | `upcoming[]`（name/bot_username/command/next_run_at，徽章用 `relTime()`） |

**KPI 趋势行裁决**：四卡全部不显示趋势。唯一可能的「较昨日」需要历史接口，本项目没有；按「有真实数据才显示」裸奔不如不显示。KPI 卡因此无 trend 元素，hover 上浮特许保留（P1 §6.3）。

### 3.2 任务页 `#/tasks`（renderTasks）

数据：`/api/tasks` + `/api/accounts`（Promise.all，现状不变）。

```
┌─ .stack ─────────────────────────────────────────┐
│ .grid--panels：┌ 签到任务 (col-2) ─┌目标账户(col-1)┌最近状态(col-1)┐ │
│ .grid--cards：┌任务卡┐┌任务卡┐（2 列；空列表时为 1 张 dashed）      │
└──────────────────────────────────────────────────┘
```

- **头部面板行**：主面板（col-2）= 标题「签到任务」+ sub「共 N 个，M 个启用中」+ 🗓️ + foot `+ 新建任务`(primary)；目标账户（col-1）= `.stat` 账户数；最近状态（col-1）= 最近一条 `last_status` 徽章，无则「未执行」neutral 徽章（保留现状取值逻辑）。
- **任务卡**（`.grid--cards`，2 列 ≥768px）：`.panel`，head = 名称（`.panel__title`）+ `bot_username · mono(command)` + 右侧 `.switch`（`aria-label="启用 {name}"`，`title="启用/停用"`）；body = 排期行（`scheduleDesc()` + `±jitter`）+ 下次执行（`fmtTime` + `relTime`，`--text-2`）+ 账户行（名称 + 「· 默认」）+ 抓取回复行（`capture_reply=1` 时）；foot = 状态徽章（`last_status` 或「未执行」）+ `last_error` 截断 40 字（`title` 全量）+ 操作组（`.row__actions`：运行 / 编辑 / 删除-danger）。
- **空状态**：`.grid--cards` 内一张 `.panel--dashed`（🗒️「还没有任务」/「点击新建第一个签到任务」，`data-action="add-task"`，整卡可点）。
- 卡片禁用 hover 上浮（仅 KPI 特许上浮；卡片是 `.panel`，无位移）。

### 3.3 账户页 `#/accounts`（renderAccounts）

数据：`/api/accounts`。

- **头部面板行**：主面板（col-2）= 「Telegram 账户」+ sub「共 N 个，M 个可用」+ 👥 + 现状说明文案 + foot `+ 添加账户`；默认账户（col-1）= 默认账户名 + 「新建任务默认归属它」；登录方式（col-1）= 现状文案（手机号+验证码 / StringSession）。
- **账户卡**（`.grid--cards`，2 列）：head = 名称 + 「默认」ok 徽章（`is_default=1`）+ `@tg_username`（无则「未获取到用户名」，`enabled≠1` 追加「· 已停用」）+ 👤；body = 状态徽章 + `last_error` 截断（仅 invalid 时）+ 「最近验证 `fmtTime(last_verified_at)`」；foot = 验证 / 设为默认（非默认时才有）/ 删除-danger。
- **空/追加**：卡片网格末尾常驻一张 `.panel--dashed`（「+ 添加账户」/「手机号登录 / 粘贴 Session」，`data-action="add-account"`）。零账户时头部三面板 + 这一张 dashed 即为空状态（信息不空白）。

### 3.4 日志页 `#/logs`（renderLogs）

数据：`/api/logs?limit=50[&before_id&task_id]` + `/api/tasks`（筛选项）。

```
┌─ .stack ───────────────────────────────────────────────┐
│ .grid--panels：┌ 执行日志+筛选 (col-2) ─┌本页(col-1)┌保留策略(col-1)┐ │
│ .panel--flat 全宽（padding:0）：.rows #log-body            │
│ .flex-between：「最多展示最近 50 条」 + [加载更多]          │
└────────────────────────────────────────────────────────┘
```

- **筛选面板**（col-2）：标题「执行日志」+ sub「倒序展示，每次执行一条」+ 📜；`.field` 内 `<select class="select" id="log-filter">`（label `for="log-filter"`，「全部任务」+ 任务名选项，`esc()`）。
- **计数面板**（col-1）：「本页」+ `.stat` 条数；**保留策略**（col-1）：现状文案（30 天前随机清理）。
- **列表面板**（全宽）：`.panel.panel--flat`，`padding:0`，内嵌 `.rows#log-body`；行 = `.row`（`row__main` = 任务名 + `fmtTime(created_at)`；状态徽章；`detail` 截断 50 字 `title` 全量；时长 `duration_ms/1000` 秒或 `-`）。行 hover 底色，最后行无下边框。
- **底栏**：左「最多展示最近 50 条」（`--text-2`），右 `#log-more`；`logs.length < 50` 时 `disabled`（P1 §6.7 禁用态）。加载更多 onClick 逻辑、游标 `logCursor`、筛选 onchange 逻辑零改动，仅补交互态（§5）。

### 3.5 设置页 `#/settings`（renderSettings）

数据：探针 `/api/accounts`；提交 `/api/password`。**先探针后渲染**（契约，现状保持）。

- **主面板（col-2）**「修改管理密码」：🔑 + sub「修改成功后所有已登录会话将失效，需重新登录」；三个 `.field`（`pw-old`/`pw-new`/`pw-confirm`，均 `type=password` + 正确 `autocomplete`）；`pw-new` 下 `.meter#pw-meter`（4 段，`is-on`/`is-warn`）+ `.field__hint#pw-hint`（现状文案）；`#pw-err` 错误位；foot `#pw-save`（primary）。强度评分 `passwordScore()` 与 oninput 逻辑零改动。
- **三面板（col-1 ×3）**：Telegram 账户（👥 + 现状文案 + foot 链接「前往账户页」）；关于（ℹ️ + `.prose` 现状文案，68ch 限宽）；退出登录（🚪 + 现状文案 + foot `data-action="logout"` danger 钮）。
- 错误态：`#pw-err` 出文字时同步给 `#pw-old` 加 `.is-error` + `aria-invalid="true"`（§5）。

### 3.6 登录页 `#/login`（renderLogin）

- 无侧栏无顶栏（`body.is-auth`，§1.4）。`.content` 居中，`.center-col` 内一张 `.panel`（`max-width:400px; width:100%`）。
- 内容（id 全部保留）：`<h1>` 标题「登录 TG Checkin」+ sub「输入管理密码继续」→ `.field`（label `for="login-pw"`，`#login-pw` password + `autocomplete="current-password"`）→ `<div class="field__error" id="login-err">` → `#login-btn`（primary，`btn--block`）→ 提示文案（**逐字保留**：「未配置 `<code class="mono">ADMIN_PASSWORD</code>` 时初始口令为 `<code class="mono">admin</code>`；忘记密码可用 `<code class="mono">wrangler secret put ADMIN_PASSWORD</code>` 重置。」，测试锚点）。
- 交互：`pw.focus()` 现状保留；提交中 `#login-btn` 加 `.is-loading` + 文案「登录中...」；失败时 `#login-err` 出文案（现状映射：`too_many_attempts` / 「密码错误」）并给 `#login-pw` 加 `.is-error`；重新提交时清除。
- `esc()` 用于提示文案中无用户数据，但提交逻辑、`api()`、跳转 `#/` 零改动。

### 3.7 两个模态框（结构零改，仅视觉与间距）

- **任务模态**（`showTaskModal`）：`.overlay` > `.modal.modal--wide`（max-width 560px）+ `role="dialog" aria-modal="true"`；标题「新建/编辑任务」；`.grid-2` 双列字段组（bot/cmd、type/time|interval、tz/account、jitter/capture）——`<640px` 时 `.grid-2` 塌 1 列；`#tf-account` 异步选项加载逻辑零改动（失败兜底「加载失败」option 保留）；`#modal-err` + actions（`#modal-cancel` / `#modal-save`）。所有 `tf-*` id、`fg-time`/`fg-interval` 的 `hidden` 切换逻辑零改动。
- **账户向导**（`showAccountModal`）：`.modal`（520px）+ `aria-labelledby="am-title"`；`.tabs`（手机号登录 / 粘贴 Session，`role=tablist` 零改动）；`#am-body` 内四步（phone/code/2fa/ready）+ session 备用；`stepsHtml()`、`am-err` ×4、`adv` 折叠、`dropFlow`/`closeOverlay` 全部零改动；步骤内 `.notice--ok`/`.notice` 按 P1 §6.11。
- **间距**：模态内字段间 `--gap-md`；`.grid-2` gap `--gap-sm`；actions 右对齐、`<640px` 换行后仍右对齐。
- **建议增强（低风险，Phase 3 可取舍）**：给两个模态加 ESC 关闭（`overlay` 上 `keydown`，`Escape` → 任务模态 `overlay.remove()` / 账户向导 `closeOverlay()`）；不为模态做焦点陷阱（现状焦点会落在首个输入框，可接受）。

---

## 4. 响应式三档细则

断点：**≥1024px / 768–1023px / <768px**（与 P1 §5 一致；token 的 md 块用 `min-width:768px`）。另有一个子档 **<640px** 只影响顶栏用户区与模态宽度。

### 4.1 ≥1024px（桌面）

| 组件 | 形态 |
|---|---|
| 侧边栏 | 常驻 256px（sticky，`height:100vh`），汉堡隐藏，backdrop 不存在交互 |
| 顶栏 | 标题 H1 24px；搜索 240px；铃铛；头像+「管理员」 |
| KPI 行 | `.grid--kpi` 4 列 |
| 面板网格 | `.grid--panels` 3 列（col-2 + col-1） |
| 卡片网格 | `.grid--cards` 2 列（任务/账户卡） |
| 日志/即将执行 | 全宽面板 |
| 设置页 | 密码 col-2 + 三面板 col-1 同行 |
| 模态 | 520px（账户）/ 560px（任务 `.modal--wide`），`.grid-2` 双列 |

### 4.2 768–1023px（平板）

| 组件 | 变化 |
|---|---|
| 侧边栏 | 仍常驻（内容区 = 视口 −256px） |
| 顶栏 | 搜索缩 160px；其余同桌面 |
| KPI 行 | **2 列**（4 张卡 2×2） |
| 面板网格 | **1 列堆叠**，`.col-2` 复位为整宽（主面板不再跨列，靠内部信息密度体现主次） |
| 卡片网格 | 仍 2 列（卡宽 ~250–370px，foot 按钮组允许换行） |
| notice / 列表面板 | 全宽不变 |
| 设置页 | 密码面板整宽，三面板整宽堆叠 |
| 模态 | 520/560px，`.grid-2` 仍双列（<640 才塌） |

### 4.3 <768px（手机）

| 组件 | 变化 |
|---|---|
| 侧边栏 | **抽屉化**：`position:fixed; inset:0 auto 0 0; transform:translateX(-100%)`，`.is-open` 滑出（`transition: transform var(--dur) var(--ease)`）；`.sidebar__link` 触摸目标 ≥40px 高 |
| 汉堡 | `.topbar__toggle` 显示（40×40 `.icon-btn`，`☰`），`aria-expanded` 同步 |
| backdrop | `body.drawer-open .sidebar-backdrop` 显示（`--overlay` 纯色，无模糊）；点击关闭 |
| 抽屉关闭路径 | ① backdrop 点击 ② ESC ③ 点任一导航链接后 ④ resize 跨过 768px 时强制关闭 ⑤ 汉堡再点（toggle） |
| 焦点管理 | 打开：焦点移入第一个 `.sidebar__link`；关闭：焦点还给汉堡；打开期间 `body.drawer-open { overflow:hidden }` 锁滚动 |
| 顶栏 | 标题 H1 20px；**搜索隐藏**；铃铛保留；用户区**只留头像**（<640 同规则，此处全量生效） |
| KPI 行 | **1 列**（裁决 C3：比 P1 的 <640 更早塌陷，与档位边界统一） |
| 面板/卡片网格 | 全部 1 列 |
| 模态 | 近全宽（`max-width:none`，`.modal--wide` 同样），`.grid-2` 塌 1 列，actions 换行右对齐 |
| 表格/行 | `.row` 允许 `flex-wrap`，操作组换行到第二行（现状已 wrap） |

### 4.4 触控与指针差异

- 触屏（`pointer:coarse` 无法可靠 hover）：所有可点元素 ≥40×40（`.icon-btn` 40、`.btn` 36+、抽屉链接 40+）；hover 底色反馈在触屏上退化为 active 底色，不丢可达性信息。
- `:hover` 一律配 `@media (hover:hover)` 包裹（Phase 3 落地细节），避免移动端点击后 hover 粘滞。

---

## 5. 交互状态矩阵（在 P1 §7 基础上补应用特有状态）

| 状态 | 触发 | 规则 | 适用 |
|---|---|---|---|
| 任务开关切换中 | `toggleTask` 请求在飞 | 该 `input[data-action=toggle]` 置 `disabled`，外层 `.switch` 加 `.is-busy`（`opacity:.55; pointer-events:none`）；`finally` 恢复。防止连点产生竞态；失败时现状 `navigate()` 重渲染自然回滚 | 任务卡开关 |
| 运行/验证/设为默认 按钮 loading | `runTask`/`verifyAccount`/`switchAccount` | 沿用现状：`.is-loading` + 文案变 `...` + `pointer-events:none`；完成后还原文案并 `navigate()` | `.btn--sm` 操作钮 |
| 删除确认 | `deleteTask`/`deleteAccount` | 原生 `confirm()` 现状保留（零依赖、可键盘操作） | 删除钮 |
| 日志筛选切换 | `#log-filter` onchange | select 置 `disabled` + `#log-body` 加 `aria-busy="true"` + 注入 3 行骨架（§6.4）；成功/失败后恢复，失败走 toast | 日志页 |
| 加载更多 | `#log-more` onClick | 请求在飞时按钮 `disabled`；返回 <50 条或 0 条时置 `disabled`（现状逻辑）；`logCursor===null` 时禁用 | 日志页 |
| 搜索无结果 | 搜索框有值且 0 命中 | 容器内 `.empty[data-filter-empty]`（§2.1），`role="status"` | 任务/账户/日志/仪表盘 |
| 搜索清空 | 输入框清空 / 路由切换 | 移除全部 `.is-filtered`，隐藏 no-results；路由切换时 `navigate()` 清空输入框 | 全局 |
| 表单错误 | 登录/向导/密码修改失败 | 错误位 `.field__error` 出文字（现状）+ **可定位到字段时**给对应输入加 `.is-error`（边框 `--bad-text` + ring 12%）+ `aria-invalid="true"`；重新提交时清除。映射：`#login-err`→`#login-pw`；手机号格式错→`#am-phone`；api 凭据错→`#am-api-hash`；`#pw-err`→`#pw-old`；`#modal-err` 为通用错误不定位字段 | 全站表单 |
| 侧栏当前页 | 路由变化 | `.is-active` + `aria-current="page"`（§1.2） | `.sidebar__link` |
| 模态 loading | 向导各步提交 | 各步主按钮 `.is-loading` + 文案（「发送中...」/「验证中...」/「登录中...」/「保存中...」，现状保留） | 账户向导 |
| toast | 全局 | `role="status"` 补上（读屏可感知）；其余按 P1 §6.12 | `.toast` |
| 禁用 | 加载更多/无更多 | `disabled` 属性 + `opacity:.55`（P1 §7），保留原生语义 | 按钮 |

**动效降级**：P1 §7 的 `prefers-reduced-motion` 块已全局覆盖 transition/animation，抽屉滑出、模态入场、骨架脉冲、KPI 上浮全部瞬时化；hover 底色反馈保留（可达性信息）。

---

## 6. 空状态与加载态规范

### 6.1 空状态（图标 + 标题 + 提示 + 可选动作，逐页文案）

| 页面/容器 | 图标 | 标题 | 提示 / 动作 |
|---|---|---|---|
| 仪表盘 · 即将执行 | 📭 | 未来 24 小时内没有待执行任务 | 提示「任务启用后，下次执行时间会显示在这里」+ 动作链接「前往任务页」→ `#/tasks` |
| 任务页 · 卡片网格 | 🗒️ | 还没有任务 | 点击新建第一个签到任务（整卡 `data-action="add-task"`，`.panel--dashed`） |
| 账户页 · 卡片网格末尾 | 👥 | + 添加账户 | 手机号登录 / 粘贴 Session（`.panel--dashed`，`data-action="add-account"`） |
| 日志页 · 列表 | 📜 | 暂无日志 | 任务执行后，这里会显示每次执行的结果 |
| 搜索无结果（全局） | 🔍 | 没有匹配“{q}”的结果 | 换个关键词，或清空搜索框查看全部 |
| 页面级错误（全局） | ⚠️ | 加载失败 | `esc(错误消息)` + 「刷新页面重试」 |

结构：`.empty > .empty__icon + .empty__title + .empty__hint (+ .btn--sm 动作)`（P1 §6.14）。空状态不是裸文字，也不是空白。

### 6.2 页面级加载 —— 裁决：**骨架屏 + 「加载中…」文案**

选骨架不选纯空态：五个后台页结构已知，骨架能消除布局跳动（CLS），且纯 CSS 零成本。**硬性要求：初始占位必须是含字面「加载中」的模板字符串直接赋给 `el.innerHTML`**（`tests/frontend.test.ts` 的探针顺序断言靠剥离该占位成立，改成函数调用或去掉文案会导致测试失败）。推荐形态：

```js
el.innerHTML = `
  <div class="stack" aria-busy="true">
    <div class="grid grid--kpi">
      <div class="panel kpi-skeleton"><div class="skeleton skeleton--text" style="width:40%"></div><div class="skeleton skeleton--kpi"></div></div>
      …×4…
    </div>
    <div class="panel"><div class="skeleton skeleton--title"></div><div class="skeleton skeleton--text"></div></div>
  </div>
  <p class="empty" role="status">加载中...</p>`;
```

（骨架块加 `aria-hidden="true"`；「加载中...」文字供读屏与测试双用。）

| 页面 | 骨架构成 |
|---|---|
| 仪表盘 | KPI 行 4 张（label 条 + `.skeleton--kpi`）+ 主面板 1（title + 3 text）+ 辅面板 1（title + 2 text）+ 全宽面板 1（title + 3 行 text） |
| 任务/账户 | 头部面板 1（title + 2 text）+ 卡片 4（title + 2 text + 1 badge 条） |
| 日志 | 筛选面板 1（title + select 条）+ 计数面板 1 + 5 行 `.row--skeleton` |
| 设置 | 主面板 1（title + 4 text + meter 条）+ 小面板 3（title + 2 text） |
| 登录页 | 无骨架（同步渲染，`pw.focus()` 立即生效） |

### 6.3 骨架组件（对 P1 §6.14 的补充）

- 沿用：`.skeleton`、`.skeleton--text`（12px）、`.skeleton--title`（16px/40%）、`.skeleton--kpi`（36px/60%）、`@keyframes skeleton-pulse`（opacity 脉冲，无渐变）。
- 新增（本文补充，需 Phase 3 一并落地）：`.skeleton--badge { height:18px; width:56px; }`、`.skeleton--narrow { max-width:120px; }`、`.row--skeleton { align-items:center; }`（日志骨架行）。
- 骨架只出现在**首次加载**；筛选切换、加载更多用局部骨架（§6.4），不全屏替换。

### 6.4 局部加载

- 日志筛选切换：`#log-body` 注入 3 行 `.row--skeleton`（`aria-hidden`），容器 `aria-busy="true"`，select `disabled`；完成后恢复。
- 加载更多：按钮 `disabled` + 文案保持「加载更多」（不加「加载中...」文字，按钮 disabled 即状态可见）；追加行插入后重跑搜索过滤（§2.1）。
- 按钮提交：`.is-loading`（P1 §6.7），不加 spinner 资源。

---

## 7. 无障碍要点（a11y 清单）

1. **地标与标题层级**：`<main class="content" id="app">` 是主地标；`.topbar__title` 为每页唯一 `<h1>`（登录页由卡片标题承担）；面板标题 `<h2>`，面板 `<section aria-labelledby>`；侧栏 `<nav aria-label="主导航">`。
2. **`aria-current`**：当前导航项 `aria-current="page"` + `.is-active` 双写（§1.2）；读屏播报「当前页」。
3. **图标一律 `aria-hidden="true"`**：emoji 装饰（📊🗓️👥📜⚙️🔔🚪🤖）不进入可访问名；可读名称由相邻文字或 `aria-label` 提供。
4. **图标按钮 `aria-label`**：汉堡（「打开导航」/打开后改「关闭导航」，`aria-expanded`、`aria-controls="sidebar"` 同步）；通知铃（「查看执行日志」）；开关 input（`aria-label="启用 {name}"`，现状已有）。
5. **抽屉焦点管理**（<768px）：打开 → 焦点移至第一个 `.sidebar__link`；ESC / backdrop / 导航链接点击 → 关闭并把焦点还给汉堡；打开期间 `body.drawer-open { overflow:hidden }`；resize ≥768px 强制关闭并复位焦点态。backdrop `aria-hidden="true"`。
6. **焦点可见**：`.btn`/`.switch input`/`.sidebar__link`/`.icon-btn`/`.input` 均有 `:focus-visible` 2px ring（P1 §6.1 与既有 `.btn:focus-visible`、`.switch input:focus-visible` 契约保留）；键盘顺序 = DOM 顺序，侧栏 → 顶栏 → 内容，无 tabindex 劫持。
7. **状态不靠颜色单独传达**：所有徽章带文字（`statusBadge()` 输出「成功/失败/跳过/未执行/可用/失效」）；KPI 数字有 label 文字相邻；错误同时有文字 + `aria-invalid`。
8. **模态**：`role="dialog" aria-modal="true"` 保留；打开聚焦首个输入框（现状）；ESC 关闭为建议增强（§3.7）；不做焦点陷阱（已知限制，接受）。
9. **表单错误**：`.field__error` 与输入框用 `aria-describedby` 关联（可定位字段时，§5）；错误文字即播报内容，不依赖颜色。
10. **动态区域**：toast 加 `role="status"`；骨架容器 `aria-busy="true"` + 骨架块 `aria-hidden`；搜索无结果 `.empty` 带 `role="status"`；「加载中...」为可读文案。
11. **reduced-motion**：P1 §7 全局降级块覆盖一切 transition/animation（含抽屉滑出与骨架脉冲）；信息性 hover 反馈保留。
12. **对比度**：全部文字 ≥4.5:1（P1 §2 验算表）；`--text-3`/`--sidebar-text`/反色按钮文字仅用于非信息或已验算场景；暗色模式同一套语义色自动翻转。

---

## 8. 给 Phase 3 的 DOM / 类名落地清单

> 原则：`index.html` 不动；壳由 `DOMContentLoaded` 注入 `#app-root`（现状机制）；只重写 `style.css` 与 `app.js` 的壳/类名/交互态；**不新增任何静态文件**（无 wrangler.toml `run_worker_first` 同步需求）。所有 `data-action` 值、元素 id、函数名、`esc()` 用法、`api()` 探针顺序、AUTH_401 逻辑、登录页提示文案逐字不变。

### 8.1 壳结构模板（DOMContentLoaded 注入 `#app-root`）

```html
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
    <div class="sidebar__user">
      <span class="avatar" aria-hidden="true">A</span>
      <span class="sidebar__user-meta"><span class="sidebar__user-name">管理员</span><span class="sidebar__user-sub">admin</span></span>
      <button class="btn btn--ghost-invert btn--sm" data-action="logout">🚪 退出</button>
    </div>
  </aside>
  <div class="sidebar-backdrop" id="sidebar-backdrop" aria-hidden="true"></div>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn topbar__toggle" id="sidebar-toggle" aria-label="打开导航" aria-expanded="false" aria-controls="sidebar"><span aria-hidden="true">☰</span></button>
      <h1 class="topbar__title">仪表盘</h1>
      <div class="topbar__right">
        <input class="input topbar__search" id="topbar-search" type="search" placeholder="搜索本页…" aria-label="搜索当前页列表">
        <a class="icon-btn" href="#/logs" aria-label="查看执行日志"><span aria-hidden="true">🔔</span></a>
        <span class="topbar__user"><span class="avatar" aria-hidden="true">A</span><span class="topbar__user-name">管理员</span></span>
      </div>
    </header>
    <main class="content" id="app"></main>
  </div>
</div>
```

- 保留 id：`app-root`（外壳容器）、`app`（渲染目标）。
- z-index 分工：`.sidebar-backdrop` 35 / `.topbar` 45 / `.sidebar` 50 / `.overlay` 200 / `.toast` 300。
- `.sidebar` ≥768px `position:sticky; top:0; height:100vh`；<768px `position:fixed` + 抽屉变换（§4.3）。
- CSS 需保留的既有契约：`.btn:focus-visible`、`.switch input:focus-visible`、`@media (prefers-color-scheme: dark)`、`@media (prefers-reduced-motion: reduce)`。

### 8.2 `is-auth` 登录态切换（CSS + 一行 JS）

- JS（在 `updateNav()` 内）：`document.body.classList.toggle("is-auth", hash === "#/login");`
- CSS：见 §1.4 代码块。登录态隐藏 `.sidebar` / `.sidebar-backdrop` / `.topbar`，`.content` 全屏居中；`renderLogin` 内 `.center-col` 包裹登录卡（`max-width:400px`）。
- 顺序保证：`navigate()` 每次都会调 `updateNav()`，覆盖首屏与路由切换，无需额外挂钩。

### 8.3 抽屉 JS（约 20 行，DOMContentLoaded 内绑定）

```js
const sidebar = document.getElementById("sidebar");
const drawerToggle = document.getElementById("sidebar-toggle");
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  sidebar.classList.toggle("is-open", open);
  drawerToggle.setAttribute("aria-expanded", String(open));
  drawerToggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  if (open) (sidebar.querySelector(".sidebar__link") || {}).focus?.();
  else if (getComputedStyle(drawerToggle).display !== "none") drawerToggle.focus();
}
drawerToggle.addEventListener("click", () => setDrawer(!sidebar.classList.contains("is-open")));
document.getElementById("sidebar-backdrop").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebar.classList.contains("is-open")) setDrawer(false); });
sidebar.addEventListener("click", (e) => {
  if (e.target.closest(".sidebar__link") && sidebar.classList.contains("is-open")) setDrawer(false);
});
matchMedia("(min-width: 768px)").addEventListener("change", (e) => { if (e.matches) setDrawer(false); });
```

配套 CSS（`style.css` 新增；z-index 与 §8.1 分工表一致：sidebar 50 > topbar 45 > backdrop 35，保证抽屉打开时汉堡仍在 backdrop 之上可点击关闭）：

```css
/* 抽屉（仅 <768px） */
@media (max-width: 767px) {
  .topbar__toggle { display: inline-flex; }
  .sidebar { position: fixed; inset: 0 auto 0 0; height: 100%;
             transform: translateX(-100%);
             transition: transform var(--dur) var(--ease);
             z-index: 50; }
  .sidebar.is-open { transform: none; }
  body.drawer-open { overflow: hidden; }
  body.drawer-open .sidebar-backdrop { display: block; position: fixed; inset: 0;
             background: var(--overlay); z-index: 35; }
}
@media (min-width: 768px) {
  .topbar__toggle { display: none; }
  .sidebar-backdrop { display: none; }
}
```

抽屉与模态共用同一遮罩 token：CSS 只写 `var(--overlay)`，数值以 P1 §1.1 token 为准（亮 `rgba(17,24,39,.5)` / 暗 `rgba(3,7,18,.6)`），本文不另设数值；禁 `backdrop-filter`（反玻璃态）。

### 8.4 `updateNav()` 改写（选择器 + 标题 + is-auth + 搜索可见性）

```js
const ROUTE_TITLES = { "#/": "仪表盘", "#/tasks": "任务", "#/accounts": "账户", "#/logs": "日志", "#/settings": "设置", "#/login": "登录" };

function updateNav() {
  const hash = location.hash || "#/";
  document.querySelectorAll(".sidebar__link").forEach((a) => {
    const on = a.getAttribute("data-route") === hash;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const t = document.querySelector(".topbar__title");
  if (t) t.textContent = ROUTE_TITLES[hash] || "仪表盘";
  document.body.classList.toggle("is-auth", hash === "#/login");
  const s = document.getElementById("topbar-search");
  if (s) s.classList.toggle("hidden", !SEARCH_SCOPES[hash]);
}
```

- 旧选择器 `nav a.nav-link` / `.active` 类全部替换为 `.sidebar__link` / `.is-active`（裁决 C6）。
- `ROUTE_TITLES` 为路由→标题映射表；未知路由回落「仪表盘」。登录态顶栏隐藏，标题文本不影响视觉。

---

### 8.5 搜索 JS（约 30 行，`applySearch` + 一处绑定）

```js
const SEARCH_SCOPES = {
  "#/": "#app .panel--upcoming .rows",
  "#/tasks": "#app .grid--cards",
  "#/accounts": "#app .grid--cards",
  "#/logs": "#app #log-body",
};
const SEARCH_FIELDS = ".panel__title, .panel__sub, .row__title, .row__meta, .mono";

function applySearch(q) {
  const root = document.querySelector(SEARCH_SCOPES[location.hash || "#/"]);
  if (!root) return;
  const items = Array.from(root.children).filter((el) => el.matches(".row, .panel"));
  let shown = 0;
  for (const it of items) {
    const hit = !q || Array.from(it.querySelectorAll(SEARCH_FIELDS))
      .map((e) => e.textContent).join(" ").toLowerCase().includes(q);
    it.classList.toggle("is-filtered", !hit);
    if (hit) shown++;
  }
  const dashed = root.querySelector(".panel--dashed");
  if (dashed) dashed.classList.toggle("is-filtered", !!q);
  let empty = root.querySelector("[data-filter-empty]");
  if (q && shown === 0) {
    if (!empty) {
      empty = document.createElement("p");
      empty.className = "empty";
      empty.setAttribute("data-filter-empty", "");
      empty.setAttribute("role", "status");
      root.appendChild(empty);
    }
    empty.hidden = false;
    empty.innerHTML = '没有匹配“' + esc(q) + '”的结果<span class="empty__hint">换个关键词，或清空搜索框查看全部</span>';
  } else if (empty) {
    empty.hidden = true;
  }
}
```

- 绑定（DOMContentLoaded）：`document.getElementById("topbar-search").addEventListener("input", function () { applySearch(this.value.trim().toLowerCase()); });`
- `navigate()` 内复位：`const s = document.getElementById("topbar-search"); if (s) s.value = "";`
- 日志「加载更多」追加后：补一行 `applySearch(document.getElementById("topbar-search").value.trim().toLowerCase());`
- 依赖的模板改动（仅加类名/容器，不动 id 与 data-action）：仪表盘「即将执行」面板加 `panel--upcoming`；任务/账户页卡片网格容器统一为 `.grid--cards`；CSS 加 `.is-filtered { display:none !important; }`。
- 注意 `esc()` 用于 `q` 插入 HTML；`textContent` 路径天然安全。CSP 兼容（`addEventListener`，无内联属性）。

### 8.6 交互态 JS 增量（三处，均 ≤6 行）

1. `toggleTask(id, enabled, input)`：进入即 `input.disabled = true; input.closest(".switch")?.classList.add("is-busy");`，`finally` 恢复；委托处传 `el`（即 input 自身）为第三参。CSS：`.switch.is-busy { opacity:.55; pointer-events:none; }`。
2. `#log-filter` onchange：进入 `this.disabled = true;` + `#log-body.setAttribute("aria-busy","true")` + 注入 3 行 `.row--skeleton`（`aria-hidden="true"`，每行 `row__main` 内 `.skeleton--title` + `.skeleton--text`，右侧 `.skeleton--badge` + `.skeleton--narrow`）；`finally` 恢复。原 fetch/cursor/toast 逻辑不动。
3. 表单错误：`login-err` / `pw-err` 出文字时给 `#login-pw` / `#pw-old` 加 `.is-error` + `aria-invalid="true"`，提交开始时移除；向导手机号格式错给 `#am-phone`、api 凭据错给 `#am-api-hash` 加 `.is-error`。CSS：`.input.is-error { border-color: var(--bad-text); box-shadow: 0 0 0 3px var(--bad-ring); }`。

### 8.7 关键 CSS 类清单（`style.css` 重写范围，对齐 P1 §8 映射表）

| 新增/保留 | 说明 |
|---|---|
| `.layout .main .content .stack` | 壳与页面垂直堆叠（`gap: var(--gap-lg)`） |
| `.sidebar .sidebar__brand .sidebar__nav .sidebar__link(.is-active) .sidebar__ico .sidebar__user .sidebar__user-meta .sidebar__user-name .sidebar__user-sub` | 侧栏（两模式深色签名） |
| `.sidebar-backdrop` / `body.drawer-open` / `body.is-auth` | 抽屉与登录态开关 |
| `.topbar .topbar__toggle .topbar__title .topbar__right .topbar__search .topbar__user .topbar__user-name .icon-btn` | 顶栏 |
| `.grid .grid--kpi .grid--panels .grid--cards .col-2` | 栅格（4/3/2 列 → 1 列塌陷） |
| `.kpi .kpi__label .kpi__value` | KPI 卡（仅仪表盘行） |
| `.panel .panel__head .panel__title .panel__sub .panel__body .panel__foot .panel__dashed .panel--flat .panel--upcoming .panel--wide` | 面板家族 |
| `.stat .stat__num .stat__label .stat--ok .stat--bad .stat--neutral .stat-row` | 面板内嵌数值（**保留旧类名**，裁决 C2） |
| `.avatar` | 头像（侧栏 32 / 顶栏 28） |
| `.rows .row .row__main .row__title .row__meta .row__actions .row__mono .row--skeleton` | 行列表 |
| `.badge .badge--ok/bad/warn/neutral` `.btn .btn--primary/danger/ghost/sm/block .btn--ghost-invert .btn-row` `.field .field__label .field__hint .field__error .input .select .textarea .switch .slider .meter .meter__seg` | 组件沿用 P1 §8 映射，token 换新 |
| `.skeleton .skeleton--text .skeleton--title .skeleton--kpi .skeleton--badge .skeleton--narrow` | 骨架（§6.3） |
| `.empty .empty__icon .empty__title .empty__hint` `.notice .notice--warn/ok/bad` `.toast` `.tabs .tab .tab.is-active` `.steps .step .step__dot .step__sep .step.is-active .step.is-done` `.adv` `.modal .modal__title .modal__actions .modal--wide` `.grid-2` `.center-col` `.mono .muted .dim .mt-8 .mb-16 .flex .flex-between .hidden .prose .page-title` | 沿用类名，重绘样式 |
| `.is-filtered` `.is-error` `.is-loading` `.is-busy` `.drawer-open`（body） `.is-auth`（body） | 状态类 |

### 8.8 测试锚点保持清单（Phase 3 自查用）

- app.js：6 路由字符串；`data-action` 全部取值；全部元素 id（`app`/`app-root`/`am-*`/`login-*`/`tf-*`/`pw-*`/`log-*`/`modal-*`）；`class="field__error" id="am-err"` ≥4；`function stepsHtml`；`function tzOptions(selected)` 及 `SCHEDULE_TZS.includes(selected) ? SCHEDULE_TZS : [selected, ...SCHEDULE_TZS]`；登录页提示文案逐字；`render*` 先 `api()` 探针后渲染（**占位必须含字面「加载中」**，§6.2）；`AUTH_401` 逻辑；`esc()` >20 处；函数名清单（`renderLogin`…`doLogout`/`esc`/`toast`/`parseDate`/`fmtTime`/`relTime`/`scheduleDesc`/`statusBadge`/`tzOptions`/`taskCard`/`accountCard`/`logRow`/`passwordScore`/`api`/`loginErr`/`navigate`/`updateNav`）。
- style.css：`.btn:focus-visible`、`.switch input:focus-visible`、`@media (prefers-color-scheme: dark)`、`@media (prefers-reduced-motion: reduce)` 四条断言必须原样保留。
- **`tests/frontend.test.ts` 的 CSS 风格断言块（`.bento`/`.col-2 span 2`/`--radius:16px`/`.card--lift`/`scale(0.95)`/`max-width:900px`/`repeat(4,1fr)` 等）需在 Phase 4 随新规范更新**——详见 §9-C1，Phase 3 不要为迁就旧断言而退回旧类名。

---

## 9. 冲突消解记录（按「禁止项 > 一致性 > 创意」裁决）

| # | 冲突点 | 裁决 | 理由 / 后续 |
|---|---|---|---|
| C1 | `tests/frontend.test.ts` 的 CSS 风格断言（`.bento{display:grid}`、`.col-2{grid-column:span 2}`、`.row-2`、`--radius:16px`、`.card--lift:hover translateY(-2px)`、`.card__icon scale(1.1)`、`.btn:active scale(0.95)`、`@media (max-width:900px/640px)`、`repeat(4\|2\|1, minmax(0,1fr))`）与 P1 新类名/新值（`.grid`/`.kpi`/`.panel`、`--radius-card:12px`、`scale(0.97)`、min-width 断点 768/1024）不兼容 | **以 P1 为准**：team-lead 枚举的功能锚点（路由、data-action、id、函数、esc、探针、AUTH_401、登录文案）逐条保留；上述 CSS 断言属「旧风格的样式测试」，**Phase 4 集成验证时更新测试**（改写为断言新类名/新值/新断点），不得为迁就测试退回旧设计 | 测试是工具不是需求；旧断言锁定的正是本次要替换的视觉。Phase 3 交付时 `vitest` 风格块可能红，属预期，Phase 4 一并处理 |
| C2 | P1 §8 建议把 `.stat/.stat__num/.stat__label` 并入 `.kpi__*` | **保留 `.stat` 家族**用于面板内嵌数值（仪表盘「今日执行」、任务/账户/日志计数面板），`.kpi` 专用于仪表盘 KPI 行；`.stat` 样式按新 token 重绘（`--fs-h2`/600/tabular-nums） | 一致性优先：`.stat` 在 4 个 render 函数的头部面板与主面板中复用，合并改名徒增触点且两处视觉规格不同（36px vs 20px） |
| C3 | KPI 行 1 列断点：P1 §6.3 为 <640px，team-lead 档位定义为 <768px | **<768px 塌 1 列** | 档位边界统一（三档 1024/768），减少心智负担；641–767px 区间 1 列 KPI 可接受 |
| C4 | 顶栏搜索：P1 §6.2-R8 留待裁决 | **实现为当前页客户端过滤**（§2.1），settings/login 隐藏，<768px 隐藏 | 风格签名要求顶栏有搜索；客户端过滤零接口风险；不可用时整槽隐藏，不留假控件 |
| C5 | 通知铃未读点：P1 说可选 | **不带点**，纯链接（§2.2） | 持久顶栏无数据订阅机制，红点会过期说谎；失败信息已在仪表盘 KPI/日志徽章暴露。升级路径已记录 |
| C6 | 导航当前页类名 `active`（旧）vs `is-active`（P1 二选一） | **`is-active` + `aria-current="page"`** 双写 | P1 倾向 is- 前缀统一；ARIA 兜底读屏 |
| C7 | 模态 ESC 关闭：P1 §6.13「保持现状」（现状无 ESC 处理） | **建议增加**（§3.7，低风险 ≤3 行/模态） | role=dialog 的标准键盘出口；不改变提交流程。Phase 3 如不加也可接受（有点击遮罩 + 取消钮兜底） |
| C8 | 侧栏底部用户区文案「管理员 / admin」与顶栏重复 | 保留（P1 结构要求底部用户区 + 退出按钮） | 侧栏是退出登录的固定入口，顶栏用户区仅作身份展示；职责不同不构成冗余 |

---

## 10. 交付自检

- [x] §1 框架 IA：壳结构 / 侧栏 5 项 / 顶栏 / is-auth 切换机制（CSS + 一行 JS）
- [x] §2 顶栏三件套裁决：搜索=客户端过滤（范围/匹配/无结果/清空全定义）；铃铛=链接无点；用户区=<640 只留头像
- [x] §3 逐页面：面板清单 / 栅格跨度 / 数据字段 / 空加载错误态（仪表盘、任务、账户、日志、设置、登录、两模态）
- [x] §4 响应式三档 + <640 子档 + 触控差异，逐组件列变化
- [x] §5 交互状态矩阵（开关忙态 / 按钮 loading / 筛选加载 / 加载更多禁用 / 搜索无结果 / 表单 is-error / 侧栏当前页）
- [x] §6 空状态逐页文案 + 页面级骨架屏（保留「加载中」测试锚点）+ 局部加载
- [x] §7 无障碍 12 条（aria-current / aria-label / 抽屉焦点 / 焦点可见 / 非颜色传达 / reduced-motion）
- [x] §8 Phase 3 落地清单：壳模板 / is-auth / 抽屉 JS / updateNav+标题映射 / 搜索 JS / 交互态增量 / 类名表 / 锚点自查
- [x] §9 冲突 8 项全部裁决并记录
- [x] 零新增静态文件；不改业务/API/路由/data-action/id/函数名/esc/探针/登录文案
- [x] 与 P1 token、组件、禁止项完全一致（差异仅 C2/C3/C6/C7 已记录裁决）

## 11. 给协作者的对齐点

- **给 visual-architect**：本文对 P1 的增量仅为 C2（`.stat` 保留）、C3（KPI <768 塌陷）、§6.3 三个骨架修饰类、`.grid--cards`/`.panel--upcoming`/`.is-filtered`/`.is-error` 等状态类——建议回填进 01 文档附录，保持单一事实源。
- **给 Phase 3**：先壳（§8.1–8.4）后页面（§3）后状态（§5/§6）；每页落地后用 §8.8 自查锚点；`vitest` 风格块报错属预期（C1），不要回退类名。
- **给 Phase 4**：更新 `tests/frontend.test.ts` 的「Bento 风格契约」与「响应式与无障碍契约」两个 describe 块至新规范（类名/半径/缩放/断点），功能块零改动。



