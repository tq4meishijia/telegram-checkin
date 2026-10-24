# UI 重设计 · 视觉规范（Phase 1 交付物）

> 项目：telegram-checkin 管理前端（Cloudflare Workers + Hono + D1 + 原生零构建 SPA）
> 风格唯一依据：`docs/stylekit-dashboard-layout.md`（StyleKit · Dashboard Layout）
> 本文档读者：Phase 3 前端工程师（直接改 `public/style.css` / `public/app.js` 的类名与结构）、Phase 2 体验专家（布局/交互/无障碍细化）
> 硬约束 recap：零构建、零外部字体/CDN（CSP `script-src 'self'`）、hash 路由与全部 API 不变、事件委托 `data-action` 与 `esc()` 不变、保留 `prefers-color-scheme` 暗色模式、侧边栏两种模式下都保持深色签名。

---

## 0. 设计原则（5 条，裁决优先级从高到低）

1. **签名结构不可动**：左侧 `w-64`（256px）深色侧边栏（`#111827`，两种模式下都是深色）+ 顶部白色工具栏 + 内容区 `#f9fafb` 底、白色面板。这是本风格唯一识别特征，任何页面不得退回顶部横导航。
2. **主次分明**：KPI 行 4 等宽（KPI 不是面板，允许等宽）；面板区必须主 2/3 + 辅 1/3，禁止所有面板完全相同；间距全局一套标尺，禁止逐面板微调。
3. **克制的微交互**：只有颜色/阴影/2px 位移三类反馈；基准 `duration-150 + ease-out`；可点元素 `active:scale-[0.97]`；禁止 bounce/elastic、禁止渐变、禁止玻璃态、禁用态必须可见。
4. **对比度先行**：正文与信息性文字一律 ≥ WCAG AA 4.5:1（本文所有取色均已验算，见 §2 对比度表）；`gray-400`/`gray-500`（暗色）只做 placeholder/禁用/装饰，不承载信息；状态不得只用颜色传达（徽章必须带文字）。
5. **零构建落地**：全部视觉 = CSS 自定义属性 + 类名约定；图标继续用表情符号（📊🗓️👥📜⚙️🔔🚪👤⚠️，无图标库可用，平台渲染差异可接受）；不新增任何静态文件（若新增必须同步 `wrangler.toml` 的 `run_worker_first`）。

---

## 1. Token 映射表（风格 Token → CSS 自定义属性 → 亮色/暗色值）

工程师把下面两段直接替换 `public/style.css` 现有 `:root` 与暗色 media query 即可（md 断点用同一套变量重声明，避免组件里写断点）。

### 1.1 颜色 Token

| 风格 Token（stylekit 原文） | CSS 变量 | 亮色值 | 暗色值 | 用途/备注 |
|---|---|---|---|---|
| 背景主色 `bg-[#f9fafb]` | `--bg` | `#f9fafb` | `#030712` | 内容区页面底 |
| 背景辅色 `bg-white` | `--surface` | `#ffffff` | `#1f2937` | 面板/卡片/模态/toast 反色底 |
| （内嵌面） | `--surface-2` | `#f9fafb` | `#111827` | 输入框、表头、代码块、dashed 面板 hover |
| （悬停/次按钮底） | `--surface-3` | `#f3f4f6` | `#374151` | 次按钮、tab 容器、骨架屏、行 hover（强） |
| 行/可操作面板 hover 底 | `--hover-bg` | `#f9fafb` | `rgba(255,255,255,0.04)` | `hover:bg-gray-50` 等效 |
| 侧边栏 `bg-gray-900` | `--sidebar-bg` | `#111827` | `#111827` | **两种模式都保持深色签名** |
| 侧边栏文字 | `--sidebar-text` | `#d1d5db` | `#d1d5db` | 12.15:1 on #111827 |
| 侧边栏文字（激活） | `--sidebar-text-strong` | `#ffffff` | `#ffffff` | |
| 侧边栏 hover 底 | `--sidebar-hover` | `rgba(255,255,255,0.05)` | 同左 | |
| 侧边栏 active 底 `bg-white/10` | `--sidebar-active` | `rgba(255,255,255,0.10)` | 同左 | |
| 侧边栏分隔线 | `--sidebar-border` | `rgba(255,255,255,0.08)` | 同左 | |
| 顶栏底 | `--topbar-bg` | `#ffffff` | `#1f2937` | 白底（暗色下用面板色） |
| 强调色（主）`#6366f1` | `--accent` | `#6366f1` | `#6366f1` | 焦点框、激活指示、KPI hover 数字、图表主色（**不作白字按钮底**，见裁决 R2） |
| 主按钮底（AA 修正） | `--accent-strong` | `#4f46e5` | `#4f46e5` | 白字 6.29:1 |
| 主按钮 hover | `--accent-strong-hover` | `#4338ca` | `#6366f1` | 暗色下 hover 提亮 |
| 主按钮边框（暗色描边） | `--accent-border` | `transparent` | `#6366f1` | 暗色下保证按钮边界 ≥3:1 |
| 成功/增 `#10b981` | `--ok` | `#10b981` | `#10b981` | 仅图表/实心块，**不上白底文字** |
| 成功文字 | `--ok-text` | `#047857` | `#4ade80` | 徽章、KPI 数字、趋势文字 |
| 成功浅底 | `--ok-bg` | `#ecfdf5` | `#064e3b` | |
| 成功边框 | `--ok-border` | `#a7f3d0` | `#065f46` | |
| 警示/平 `#f59e0b` | `--warn` | `#f59e0b` | `#f59e0b` | 仅图表/实心块 |
| 警示文字 | `--warn-text` | `#a16207` | `#fbbf24` | |
| 警示浅底 | `--warn-bg` | `#fffbeb` | `#422006` | |
| 警示边框 | `--warn-border` | `#fde68a` | `#78350f` | |
| 危险/减 `#ef4444` | `--bad` | `#ef4444` | `#ef4444` | 仅图表/实心块/通知点 |
| 危险文字 | `--bad-text` | `#b91c1c` | `#f87171` | |
| 危险浅底 | `--bad-bg` | `#fef2f2` | `#450a0a` | |
| 危险边框 | `--bad-border` | `#fecaca` | `#7f1d1d` | |
| 危险按钮底 | `--danger-btn` | `#dc2626` | `#dc2626` | 白字 4.83:1 |
| 危险按钮 hover | `--danger-btn-hover` | `#b91c1c` | `#ef4444` | |
| 中性徽章底/字 | `--neutral-bg` / `--neutral-text` | `#f3f4f6` / `#52525b` | `#374151` / `#d1d5db` | 7.03:1 / 9.96:1 |
| 中性边框 | `--neutral-border` | `#e5e7eb` | `#4b5563` | |
| 正文主色 `#111827` | `--text` | `#111827` | `#f9fafb` | |
| 正文辅色 gray-500 | `--text-2` | `#6b7280` | `#9ca3af` | 4.83:1 / 5.78:1 |
| 弱化 gray-400 | `--text-3` | `#9ca3af` | `#6b7280` | **仅 placeholder/禁用/装饰**（亮 2.54:1、暗 3.04:1，不承载信息，见裁决 R12） |
| 边框 `border-gray-200` | `--border` | `#e5e7eb` | `#374151` | 结构分隔：顶栏、表头行、侧栏、输入框 |
| 卡片边框 `border-gray-100` | `--border-card` | `#f3f4f6` | `#374151` | 见裁决 R9 |
| 模态遮罩 | `--overlay` | `rgba(17,24,39,0.5)` | `rgba(3,7,18,0.6)` | 不用毛玻璃 |
| 焦点环 | `--focus-ring` | `rgba(99,102,241,0.18)` | `rgba(99,102,241,0.28)` | 3px 扩散 |
| 信息提示（新增 info 档） | `--info-bg` / `--info-text` / `--info-border` | `#eef2ff` / `#3730a3` / `#c7d2fe` | `#312e81` / `#c7d2fe` / `#4338ca` | 8.88:1（亮） |

### 1.2 字号 Token（系统字体栈，禁 Inter/Roboto/Geist）

| 风格 Token | CSS 变量 | <768px | ≥768px | 字重/行高/字距 |
|---|---|---|---|---|
| Hero `text-2xl md:text-3xl` | `--fs-hero` | 24px | 30px | 600 / 1.25 / -0.02em |
| H1 `text-xl md:text-2xl` | `--fs-h1` | 20px | 24px | 600 / 1.3 / -0.02em |
| H2 `text-lg md:text-xl` | `--fs-h2` | 18px | 20px | 600 / 1.35 / -0.01em |
| H3 `text-sm md:text-base` | `--fs-h3` | 14px | 16px | 600 / 1.4 / 0 |
| 正文 `text-sm` | `--fs-body` | 14px | 14px | 400 / 1.6 / 0 |
| 小字 `text-xs` | `--fs-sm` | 12px | 12px | 400（标签可 500）/ 1.5 / 0 |
| 等宽 | `--fs-mono` | 13px | 13px | 400 / 1.5 / 0 |
| KPI 大数字 | `--fs-kpi` | 36px | 36px | 600 / 1.05 / -0.02em（text-4xl 档，见裁决 R3） |

字体栈（沿用现有，不引入外部字体）：
`--font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;`
`--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;`
标题统一 `font-semibold tracking-tight`；`font-black`/`font-extrabold`（800/900）全局禁用。

### 1.3 间距 Token（4 档）

| 风格 Token | CSS 变量 | <768px | ≥768px |
|---|---|---|---|
| Section 纵向 `py-4 md:py-6` | `--pad-section` | 16px | 24px |
| 容器横向 `px-4 md:px-6` | `--pad-container` | 16px | 24px |
| 卡片内边距 `p-4 md:p-6` | `--pad-card` | 16px | 24px |
| 小 gap `gap-2 md:gap-3` | `--gap-sm` | 8px | 12px |
| 中 gap `gap-3 md:gap-4` | `--gap-md` | 12px | 16px |
| 大 gap `gap-4 md:gap-6` | `--gap-lg` | 16px | 24px |

规则：卡片内部元素用 `--gap-sm`；网格/KPI 行用 `--gap-md`；页面区块之间用 `--gap-lg`。禁止出现 10/14/18/20px 等标尺外数值。

### 1.4 圆角 Token（3 档，rounded-full/3xl/none 禁用）

| 用途 | CSS 变量 | 值 | 对应风格类 |
|---|---|---|---|
| 卡片/面板/模态/notice | `--radius-card` | 12px | rounded-xl |
| 按钮/输入/select/textarea/tab 容器/侧栏导航项/头像 | `--radius-control` | 8px | rounded-lg |
| 徽章/开关/steps 圆点/骨架/meter 段/tab 内项 | `--radius-badge` | 6px | rounded-md |

开关旋钮、steps 圆点、头像本应圆形，因 `rounded-full` 在黑名单，统一按 6px 方圆形处理（见裁决 R1）。

### 1.5 阴影 Token（2 档，shadow-2xl 禁用）

| 用途 | CSS 变量 | 亮色 | 暗色 |
|---|---|---|---|
| 卡片/小部件 `shadow-sm` | `--shadow-sm` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | `0 1px 2px 0 rgb(0 0 0 / 0.4)` |
| 悬停/模态/大面 `shadow-md` | `--shadow-md` | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` | `0 4px 6px -1px rgb(0 0 0 / 0.45), 0 2px 4px -2px rgb(0 0 0 / 0.35)` |

聚焦时保持 `shadow-sm`（不加深阴影，用焦点环表达焦点）。暗色模式面板另加 1px 边框补偿阴影不可见。

### 1.6 交互 Token

| 用途 | CSS 变量 | 值 |
|---|---|---|
| 基准过渡 | `--dur` | `150ms`（裁决 R4） |
| 覆盖层/toast 入场 | `--dur-lg` | `200ms` |
| 缓动 | `--ease` | `cubic-bezier(0, 0, 0.2, 1)`（ease-out） |
| 按下缩放 | `--press-scale` | `0.97` |
| KPI 悬停位移 | `--lift` | `-2px` |
| 侧边栏宽 | `--sidebar-w` | `256px` |
| 顶栏高 | `--topbar-h` | `56px` |
| 骨架动画 | `--skeleton-dur` | `1.2s` |

### 1.7 可直接复制的 Token 代码块（Phase 3 替换 `:root` 用）

```css
:root {
  --bg:#f9fafb; --surface:#ffffff; --surface-2:#f9fafb; --surface-3:#f3f4f6;
  --hover-bg:#f9fafb;
  --sidebar-bg:#111827; --sidebar-text:#d1d5db; --sidebar-text-strong:#ffffff;
  --sidebar-hover:rgba(255,255,255,.05); --sidebar-active:rgba(255,255,255,.10);
  --sidebar-border:rgba(255,255,255,.08); --topbar-bg:#ffffff;
  --accent:#6366f1; --accent-strong:#4f46e5; --accent-strong-hover:#4338ca;
  --accent-border:transparent; --focus-ring:rgba(99,102,241,.18);
  --ok:#10b981; --ok-text:#047857; --ok-bg:#ecfdf5; --ok-border:#a7f3d0;
  --warn:#f59e0b; --warn-text:#a16207; --warn-bg:#fffbeb; --warn-border:#fde68a;
  --bad:#ef4444; --bad-text:#b91c1c; --bad-bg:#fef2f2; --bad-border:#fecaca;
  --danger-btn:#dc2626; --danger-btn-hover:#b91c1c;
  --neutral-bg:#f3f4f6; --neutral-text:#52525b; --neutral-border:#e5e7eb;
  --info-bg:#eef2ff; --info-text:#3730a3; --info-border:#c7d2fe;
  --text:#111827; --text-2:#6b7280; --text-3:#9ca3af;
  --border:#e5e7eb; --border-card:#f3f4f6; --overlay:rgba(17,24,39,.5);
  --radius-card:12px; --radius-control:8px; --radius-badge:6px;
  --shadow-sm:0 1px 2px 0 rgb(0 0 0/.05);
  --shadow-md:0 4px 6px -1px rgb(0 0 0/.1),0 2px 4px -2px rgb(0 0 0/.1);
  --gap-sm:8px; --gap-md:12px; --gap-lg:16px;
  --pad-section:16px; --pad-container:16px; --pad-card:16px;
  --fs-hero:24px; --fs-h1:20px; --fs-h2:18px; --fs-h3:14px;
  --fs-body:14px; --fs-sm:12px; --fs-mono:13px; --fs-kpi:36px;
  --dur:150ms; --dur-lg:200ms; --ease:cubic-bezier(0,0,.2,1);
  --press-scale:.97; --lift:-2px; --sidebar-w:256px; --topbar-h:56px; --skeleton-dur:1.2s;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (min-width:768px){
  :root{ --gap-sm:12px; --gap-md:16px; --gap-lg:24px;
    --pad-section:24px; --pad-container:24px; --pad-card:24px;
    --fs-hero:30px; --fs-h1:24px; --fs-h2:20px; --fs-h3:16px; }
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#030712; --surface:#1f2937; --surface-2:#111827; --surface-3:#374151;
    --hover-bg:rgba(255,255,255,.04);
    --sidebar-bg:#111827; --topbar-bg:#1f2937;
    --accent-strong-hover:#6366f1; --accent-border:#6366f1; --focus-ring:rgba(99,102,241,.28);
    --ok-text:#4ade80; --ok-bg:#064e3b; --ok-border:#065f46;
    --warn-text:#fbbf24; --warn-bg:#422006; --warn-border:#78350f;
    --bad-text:#f87171; --bad-bg:#450a0a; --bad-border:#7f1d1d;
    --danger-btn-hover:#ef4444;
    --neutral-bg:#374151; --neutral-text:#d1d5db; --neutral-border:#4b5563;
    --info-bg:#312e81; --info-text:#c7d2fe; --info-border:#4338ca;
    --text:#f9fafb; --text-2:#9ca3af; --text-3:#6b7280;
    --border:#374151; --border-card:#374151; --overlay:rgba(3,7,18,.6);
    --shadow-sm:0 1px 2px 0 rgb(0 0 0/.4);
    --shadow-md:0 4px 6px -1px rgb(0 0 0/.45),0 2px 4px -2px rgb(0 0 0/.35);
  }
}
```

---

## 2. 配色系统与对比度验算

### 2.1 三区结构（签名特征）

- **侧边栏**：`--sidebar-bg` `#111827`（亮/暗同值），宽 256px 固定。与亮色内容区形成强对比；暗色模式下页面底用更深的 `#030712`，侧栏仍是唯一的深色竖区（见裁决 R11）。
- **内容区**：页面底 `--bg`，面板 `--surface` 白色（亮色）。
- **顶栏**：`--topbar-bg` 白色（亮色），底部 1px `--border` 分隔，不加阴影。

### 2.2 对比度表（已验算，全部达标）

亮色模式（对白底/徽章浅底）：

| 前景 | 背景 | 比值 | 用途 |
|---|---|---|---|
| `#111827` | `#ffffff` | 17.4:1 | 正文/标题 |
| `#6b7280` | `#ffffff` | 4.83:1 | 辅助文字 |
| `#6b7280` | `#f9fafb`（行 hover） | 4.62:1 | 辅助文字 |
| `#047857` | `#ecfdf5` | 5.20:1 | ok 徽章 |
| `#b91c1c` | `#fef2f2` | 5.91:1 | bad 徽章 |
| `#a16207` | `#fffbeb` | 4.75:1 | warn 徽章 |
| `#52525b` | `#f3f4f6` | 7.03:1 | neutral 徽章 |
| `#3730a3` | `#eef2ff` | 8.88:1 | info 提示 |
| `#ffffff` | `#4f46e5` | 6.29:1 | 主按钮 |
| `#ffffff` | `#dc2626` | 4.83:1 | 危险按钮 |
| `#374151` | `#f3f4f6` | 9.36:1 | 次按钮 |
| `#d1d5db` | `#111827` | 12.15:1 | 侧栏文字 |
| `#ffffff` | `rgba(255,255,255,.10)+#111827` | 13.64:1 | 侧栏激活项 |
| `#9ca3af` | `#ffffff` | 2.54:1 | **仅 placeholder/禁用/装饰** |
| `#6366f1` | `#ffffff` | 4.47:1 | 仅焦点框/边框/图表（非文本场景 ≥3:1 达标） |

暗色模式：

| 前景 | 背景 | 比值 | 用途 |
|---|---|---|---|
| `#f9fafb` | `#1f2937` | 14.05:1 | 正文/标题 |
| `#9ca3af` | `#1f2937` | 5.78:1 | 辅助文字 |
| `#4ade80` | `#064e3b` | 5.58:1 | ok 徽章 |
| `#f87171` | `#450a0a` | 5.84:1 | bad 徽章 |
| `#fbbf24` | `#422006` | 8.73:1 | warn 徽章 |
| `#d1d5db` | `#374151` | 6.99:1 | neutral 徽章 |
| `#c7d2fe` | `#312e81` | ≈7.4:1 | info 提示 |
| `#ffffff` | `#4f46e5` | 6.29:1 | 主按钮（加 `#6366f1` 1px 边框使边界 3.29:1） |
| `#6b7280` | `#111827` | 3.70:1 | **仅 placeholder/禁用/装饰** |

### 2.3 语义色使用规则

- `--ok/--warn/--bad`（`#10b981/#f59e0b/#ef4444`）**只用于图表、实心色块、通知圆点、meter 段**；任何落在白/浅底上的文字一律换 `--ok-text/--warn-text/--bad-text`（见裁决 R7）。
- 徽章 = 浅底（`*-bg`）+ 深字（`*-text`）+ 1px 同色系边框（`*-border`），禁止在彩色底上放灰字。
- KPI 趋势：涨 `--ok-text`、跌 `--bad-text`、平 `--warn-text`，且必须带 `▲/▼/●` 字形 + 文字说明（如 `▲ 3 较昨日`），不得只用颜色（WCAG 1.4.1）。

---

## 3. 字体层级落到本项目

| 层级 | 类名 | 规格 | 用在哪 |
|---|---|---|---|
| Hero | `.hero` | `var(--fs-hero)` / 600 / -0.02em | 预留（登录页大标题可用；常规页面不用） |
| H1 | `.page-title` / `.h1` | `var(--fs-h1)` / 600 / -0.02em | 顶栏当前页名（仪表盘/任务/账户/日志/设置）、登录卡标题 |
| H2 | `.h2` | `var(--fs-h2)` / 600 / -0.01em | 模态框标题（`.modal__title`）、面板主标题（`.panel__title` 在 ≥768px 即 H2 档） |
| H3 | `.h3` | `var(--fs-h3)` / 600 | 面板标题（<768px）、分组小标题 |
| 正文 | 默认（body 14px） | `var(--fs-body)` / 400 / 1.6 | `.panel__body`、`.row__title`、表格 td |
| 小字 | `.text-sm-2`（沿用 `--fs-sm`） | 12px | `.panel__sub`、`.row__meta`、表头 th、`.field__label`、`.field__hint`、徽章、KPI label/trend |
| 等宽 | `.mono` | `var(--fs-mono)` / `--font-mono` | 指令（/checkin）、session、api_hash、代码 |
| KPI 大数字 | `.kpi__value` | 36px / 600 / 1.05 / -0.02em | 仪表盘 4 张 KPI 卡、任务/账户/日志页计数（text-4xl 档，禁 text-5xl+，见裁决 R3） |

- 行宽：`.prose { max-width: 68ch }`（保留现有），正文不出现超宽段落。
- 禁止：`font-black`/`font-extrabold`、渐变文字、每 section 标题上的 tiny uppercase eyebrow、全大写中文标签。

---

## 4. 间距 / 圆角 / 阴影落地规则

- **卡片**：`padding: var(--pad-card)`；`border-radius: var(--radius-card)`；`border: 1px solid var(--border-card)`；`box-shadow: var(--shadow-sm)`。
- **按钮/输入/select/textarea/开关/tab 容器/侧栏项/头像**：`border-radius: var(--radius-control)`（8px）。
- **徽章/steps 圆点/开关旋钮/meter 段/骨架块/tab 内项**：`border-radius: var(--radius-badge)`（6px）。
- **网格 gap**：KPI 行/面板网格 = `var(--gap-md)`；页面区块（KPI 行 → 表面板 → 表格面板）= `var(--gap-lg)`；卡片内部元素 = `var(--gap-sm)`。
- **容器**：`.content { padding: var(--pad-container); max-width: 1400px; margin: 0 auto; }`；section 纵向 `padding-block: var(--pad-section)`。
- **阴影**：默认 `--shadow-sm`；hover 升档 `--shadow-md`（仅 KPI 卡与可交互面板）；模态 `--shadow-md`；禁用 `shadow-2xl`。
- 暗色模式：阴影加深 + 面板 1px `--border` 描边，不依赖阴影分层。

---

## 5. 布局骨架（给 Phase 3 的 DOM 约定）

```html
<body>
  <div class="layout">
    <aside class="sidebar" id="sidebar">…</aside>
    <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
    <div class="main">
      <header class="topbar">…</header>
      <main class="content" id="app">…hash 路由渲染目标…</main>
    </div>
  </div>
</body>
```

- `.layout { display:flex; min-height:100vh; }`
- `.sidebar { width: var(--sidebar-w); flex: none; position: sticky; top: 0; height: 100vh; }`（≥768px 常驻）
- `.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }`
- `.topbar { height: var(--topbar-h); position: sticky; top: 0; z-index: 30; }`
- `.content { flex: 1; padding: var(--pad-container); }`
- **登录页**（`#/login`）不套 `.layout`：直接用 `.auth` 全屏 `--bg` + 居中卡（`max-width: 400px`），保留现有 `.center-col` 语义。
- **响应式三档**（与风格 §7 一致）：
  - ≥1024px：侧栏常驻 + KPI 4 列 + 面板 3 列网格（主 col-span-2 + 辅 col-span-1）；
  - 768–1023px：侧栏常驻 + KPI 2 列 + 面板 1 列堆叠；
  - <768px：侧栏收成抽屉（`transform: translateX(-100%)`，`.is-open` 滑出，配 `.sidebar-backdrop`），顶栏显汉堡按钮，KPI 1 列，面板 1 列。
- **仪表盘建议排布**（视觉主次示例，最终 IA 归 Phase 2）：
  1. KPI 行 4 卡：今日成功 / 今日失败 / 签到任务 / Telegram 账户（等宽，KPI 非面板）；
  2. 表面板行：主面板（col-span-2，`今日执行`：成功/失败/跳过三数值 + 说明）+ 辅面板（col-span-1，`默认账户` + 徽章）；
  3. 辅面板行：`快捷操作`（col-span-1）、`告警说明`（col-span-1）、`密码`（col-span-1）；
  4. 全宽数据面板：`即将执行`（rows 列表，未来 24h）。
- **图表区**：本项目无图表库（零构建），`主 2/3 + 辅 1/3` 用面板网格实现；如需趋势可视化，用 CSS-only 迷你条 `.spark`（flex 行、条高按百分比、`--accent` 纯色、`--radius-badge`、hover `opacity:.8` + `title` 提示，**不用渐变**），容器 `aspect-ratio: 16/9` 预留。

---

## 6. 组件视觉规范（逐个属性值）

> 所有组件共用：`transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);`
> 所有可交互元素 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`（输入框用 §6.6 的 ring 方案）。

### 6.1 侧边栏 `.sidebar`

- 结构：品牌区（高 56px，`🤖` + `TG Checkin`，白字 600 15px，底部 1px `--sidebar-border`）→ 导航区（`padding: var(--gap-sm)`）→ 底部用户区（`margin-top:auto`，顶部 1px `--sidebar-border`，`padding: var(--gap-sm)`）。
- 背景 `--sidebar-bg`；右侧 1px `--sidebar-border`（暗色模式下与页面底区分）。
- 导航项 `.sidebar__link`：`display:flex; align-items:center; gap:12px; padding:8px 12px; border-radius: var(--radius-control); color: var(--sidebar-text); font-size: var(--fs-body); text-decoration:none;`
- 图标：emoji 18px（📊 仪表盘 / 🗓️ 任务 / 👥 账户 / 📜 日志 / ⚙️ 设置），`flex:none`。
- 状态：
  - hover：`background: var(--sidebar-hover); color: var(--sidebar-text-strong);`
  - active（当前页，`aria-current="page"`）：`background: var(--sidebar-active); color: #ffffff; font-weight:500;`（**不加左侧粗边框条**，风格红线）
  - focus-visible：`outline: 2px solid var(--accent); outline-offset: 2px;`（`#6366f1` on `#111827` = 4.01:1 ≥3:1）
- 底部用户区 `.sidebar__user`：头像 `.avatar`（32×32，`--radius-control`，`--accent-strong` 底白字 600 13px，内容 `A`）+ 两行文字（`管理员` 13px/500 白；`admin` 12px `--sidebar-text`）+ 退出 `.btn--ghost-invert`（透明底、`--sidebar-text`、hover `--sidebar-hover` + 白字、`🚪 退出`，`data-action="logout"` 不变）。
- <768px：抽屉化（§5），打开时 `.sidebar__link` 触摸目标 ≥40px 高。

### 6.2 顶部工具栏 `.topbar`

- `height: var(--topbar-h); background: var(--topbar-bg); border-bottom: 1px solid var(--border); display:flex; align-items:center; gap: var(--gap-sm); padding: 0 var(--pad-container); position: sticky; top:0; z-index:30;`
- 左：汉堡 `.icon-btn`（仅 <768px 显示，`☰`，`aria-label="打开导航"`，`aria-expanded` 同步）+ 页面标题 `.topbar__title`（H1：`var(--fs-h1)`/600/-0.02em，`--text`）。
- 右（`margin-left:auto`，gap `--gap-sm`）：
  - 搜索 `.topbar__search`：`input`，`width: 240px`（<1024px 隐藏或缩为 160px），`🔍` 前缀用 placeholder 文字 `搜索任务 / 日志…`。**裁决 R8：实现为当前页客户端过滤（纯视觉层，不过接口）；若裁剪范围则整槽移除，不留假控件。**
  - 通知 `.icon-btn`（`🔔`，`aria-label="查看执行日志"`，`href="#/logs"` 的 `<a>`）；当日失败 >0 时可选 6px 通知点（`--bad`，`.dot`，`--radius-badge`，绝对定位右上角）。
  - 用户区 `.topbar__user`：`.avatar` 28×28 + `管理员` 13px（<640px 只留头像）。
- `.icon-btn`：`width:40px; height:40px; border-radius: var(--radius-control); display:inline-flex; align-items:center; justify-content:center; color: var(--text-2); background:transparent; border:none; cursor:pointer; font-size:18px;` hover：`background: var(--surface-3); color: var(--text);` active：`transform: scale(var(--press-scale));`

### 6.3 KPI 卡片 `.kpi`

- 容器：`background: var(--surface); border:1px solid var(--border-card); border-radius: var(--radius-card); box-shadow: var(--shadow-sm); padding: var(--pad-card); display:flex; flex-direction:column; gap:4px;`
- 结构：`.kpi__label`（12px `--text-2`，可 500）→ `.kpi__value`（36px/600/1.05/-0.02em，`--text`，`font-variant-numeric: tabular-nums`）→ `.kpi__trend`（12px，含字形+文字）。
- 趋势变体：`.kpi__trend--up { color: var(--ok-text) }`（`▲ 3 较昨日`）、`--down { color: var(--bad-text) }`（`▼ 1 较昨日`）、`--flat { color: var(--warn-text) }`（`● 持平`）。
- hover（风格特许的唯一上浮元素）：`transform: translateY(var(--lift)); box-shadow: var(--shadow-md);` 且 `.kpi:hover .kpi__value { color: var(--accent-strong); transform: scale(1.02); }`（`transform-origin: left center`）。
- 网格 `.kpi-grid`：`display:grid; gap: var(--gap-md); grid-template-columns: repeat(4, minmax(0,1fr));` <1024px → 2 列；<768px → 1 列（断点修正见附录 A.2）。
- KPI 卡不可点击时仍是 `div`，不加 `cursor:pointer`、无 `role`。

### 6.4 数据面板卡片 `.panel`

- 基础（= 风格 §4 卡片）：`background: var(--surface); border:1px solid var(--border-card); border-radius: var(--radius-card); box-shadow: var(--shadow-sm); padding: var(--pad-card); display:flex; flex-direction:column; gap: var(--gap-sm); min-width:0;`
- `.panel__head`：`display:flex; align-items:flex-start; justify-content:space-between; gap: var(--gap-sm);`
- `.panel__title`：`font-size: var(--fs-h3); font-weight:600; color: var(--text);`（≥768px 自动升到 16px）
- `.panel__sub`：`font-size: var(--fs-sm); color: var(--text-2); margin-top:2px;`
- `.panel__icon`：`width:36px; height:36px; border-radius: var(--radius-control); background: var(--surface-3); color: var(--text-2); display:inline-flex; align-items:center; justify-content:center; font-size:18px; flex:none;`（emoji 图标）
- `.panel__body`：`font-size: var(--fs-body); color: var(--text-2);` 内多行用 `display:flex; flex-direction:column; gap:6px;`
- `.panel__foot`：`margin-top:auto; padding-top: var(--gap-sm); display:flex; align-items:center; gap: var(--gap-sm); flex-wrap:wrap;`
- 变体：
  - `.panel--interactive`（可点击面板，如快捷入口）：hover `background: var(--hover-bg);` **无位移**；active `transform: scale(0.99);`
  - `.panel--dashed`（添加占位）：`border:1px dashed var(--border); background:transparent; box-shadow:none; align-items:center; justify-content:center; text-align:center; min-height:120px; color: var(--text-2); cursor:pointer;` hover：`border-color: var(--text-3); background: var(--surface-2); color: var(--text);`
  - `.panel--flat`：`box-shadow:none;`（表格面板用，靠边框分隔）
- **禁止嵌套卡片**：面板内不再放 `.panel`；列表行/表单/徽章不是卡片，可以放。
- 网格工具类：`.grid { display:grid; gap: var(--gap-md); }` `.grid--panels { grid-template-columns: repeat(3, minmax(0,1fr)); }` `.col-2 { grid-column: span 2; }` `.col-3 { grid-column: span 3; }` `.col-4 { grid-column: span 4; }`；<1024px 全部 1 列（`.grid--panels` 与 `.col-*` 一起塌陷）；<640px gap 降为 `--gap-sm`。

### 6.5 表格 `.table` 与列表行 `.rows/.row`

- `.table-wrap { overflow-x:auto; }`（横向滚动，不撑破面板）
- `.table { width:100%; border-collapse:collapse; font-size: var(--fs-body); }`
- `th`：`font-size: var(--fs-sm); font-weight:500; color: var(--text-2); text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); white-space:nowrap;`
- `td`：`padding:10px 12px; border-bottom:1px solid var(--border); color: var(--text); vertical-align:top;`
- 行 hover：`tbody tr:hover { background: var(--hover-bg); }`；最后一行去下边框；无斑马纹。
- 列表行（日志页现状，视觉同表格）：
  - `.rows { display:flex; flex-direction:column; }`
  - `.row { display:flex; align-items:center; gap: var(--gap-sm); padding:12px 16px; border-bottom:1px solid var(--border); font-size: var(--fs-body); flex-wrap:wrap; }` 最后一行无边框；hover `background: var(--hover-bg);`
  - `.row__main { flex:1 1 220px; min-width:0; }` `.row__title { font-weight:500; color: var(--text); overflow-wrap:anywhere; }` `.row__meta { font-size: var(--fs-sm); color: var(--text-2); }` `.row__actions { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }` `.row__mono { font-family: var(--font-mono); font-size: var(--fs-mono); }`
- 数字列 `font-variant-numeric: tabular-nums`。

### 6.6 表单：输入框 / select / textarea / switch / meter

- `.input, .select, .textarea`：`width:100%; font-family:inherit; font-size: var(--fs-body); color: var(--text); background: var(--surface-2); border:1px solid var(--border); border-radius: var(--radius-control); padding:8px 12px;`（高度 36px）
- focus：`outline:none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring);`（边框 4.47:1 ≥3:1，环 20% 不抢焦点）
- placeholder：`color: var(--text-3);`
- 错误态：`.input.is-error, .select.is-error { border-color: var(--bad-text); box-shadow: 0 0 0 3px rgba(185,28,28,.12); }` + `.field__error` 文字（12px `--bad-text`，必带文字说明，不得只标红）。
- disabled：`opacity:.55; cursor:not-allowed; background: var(--surface-3);`
- `.textarea`：`min-height:88px; resize:vertical; font-family: var(--font-mono); font-size: var(--fs-mono); line-height:1.5;`
- `.select`：保留原生箭头外观（裁决 R10，零资源、CSP 安全），仅统一盒模型与 focus 态。
- `.field { display:flex; flex-direction:column; gap:6px; }` `.field__label { font-size: var(--fs-sm); color: var(--text-2); }`（与控件用 `for/id` 关联）`.field__hint { font-size: var(--fs-sm); color: var(--text-3); }`（hint 属补充说明，可用弱化色；关键提示用 `--text-2`）。
- `.switch`：轨道 `40×22`、`--radius-badge`、`background: #d1d5db`（暗色 `#4b5563`）；on：`background: var(--accent-strong);`；旋钮 `16×16`、`--radius-badge`、白底、`left:2px; top:2px`、`transition: transform var(--dur) var(--ease)`；checked 时 `translateX(18px)`；`input:focus-visible + .slider { outline:2px solid var(--accent); outline-offset:2px; }`；`input` 本身 `opacity:0` 保留（键盘可达）。
- `.meter`（密码强度）：`display:flex; gap:4px;` `.meter__seg { height:4px; flex:1; border-radius: var(--radius-badge); background: var(--surface-3); transition: background-color var(--dur) var(--ease); }` `.is-on { background: var(--ok); }` `.is-warn { background: var(--warn); }`（配 `.field__hint` 文字说明强度）。

### 6.7 按钮 `.btn`（含 primary/secondary/danger/ghost/sm/loading/disabled）

- 基类：`display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 14px; border-radius: var(--radius-control); font-family:inherit; font-size: var(--fs-body); font-weight:500; line-height:20px; border:1px solid transparent; cursor:pointer; text-decoration:none; white-space:nowrap;`
- 变体：
  - `.btn--primary`：`background: var(--accent-strong); color:#fff; border-color: var(--accent-border);` hover `background: var(--accent-strong-hover);`（**不用 opacity-90**，避免文字对比度波动，裁决见 R2/R6）
  - `.btn`（默认=secondary）：`background: var(--surface-3); color: #374151;`（暗色 `color: var(--text)`）hover `background: #e5e7eb;`（暗色 `#4b5563`）
  - `.btn--danger`：`background: var(--danger-btn); color:#fff;` hover `background: var(--danger-btn-hover);`
  - `.btn--ghost`：`background:transparent; color: var(--text-2);` hover `background: var(--surface-3); color: var(--text);`
- 尺寸：`.btn--sm { padding:4px 10px; font-size:13px; line-height:18px; }`（圆角仍 8px）；`.btn--block { width:100%; }`
- 状态：
  - hover：只换底色/边框（上面的变体表）；**无位移**。
  - active：`transform: scale(var(--press-scale));`（0.97）
  - focus-visible：`outline:2px solid var(--accent); outline-offset:2px;`
  - `[disabled]`：`opacity:.55; cursor:not-allowed; pointer-events:none;`（保留 `disabled` 属性语义，屏幕阅读器可读）
  - `.is-loading`：`opacity:.65; pointer-events:none; cursor:progress;`（沿用 app.js 现有「文字变 …」模式，不加 spinner 资源；如 Phase 3 想加 CSS spinner：`::after` 12px 圆、2px 边框、`border-top-color:transparent`、`animation: spin .6s linear infinite`，`prefers-reduced-motion` 下停）
- `<a class="btn">` 同规则，`text-decoration:none`。

### 6.8 徽章 `.badge`

- 基类：`display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius: var(--radius-badge); font-size: var(--fs-sm); font-weight:500; border:1px solid transparent; white-space:nowrap; line-height:18px;`
- 变体（浅底深字，全部验算过 ≥4.5:1）：
  - `.badge--ok`：`background: var(--ok-bg); color: var(--ok-text); border-color: var(--ok-border);`
  - `.badge--bad`：`background: var(--bad-bg); color: var(--bad-text); border-color: var(--bad-border);`
  - `.badge--warn`：`background: var(--warn-bg); color: var(--warn-text); border-color: var(--warn-border);`
  - `.badge--neutral`：`background: var(--neutral-bg); color: var(--neutral-text); border-color: var(--neutral-border);`
- 圆角由 999px 改 6px（裁决 R1）。状态文字保留中文标签（成功/失败/跳过/可用/已失效/未验证/未执行/未配置），**禁止只靠颜色**。
- 可选 `.badge--dot`：前置 6px 圆点（`--radius-badge`，当前色），用于表格密集列。

### 6.9 Tabs `.tabs/.tab`

- `.tabs { display:flex; gap:4px; padding:4px; background: var(--surface-3); border-radius: var(--radius-control); }`
- `.tab { flex:1; padding:8px 12px; border:none; border-radius: var(--radius-badge); background:transparent; color: var(--text-2); font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; }`
- hover：`color: var(--text);`
- `.is-active`：`background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm);`（暗色 `background: var(--surface-3); color: var(--text);`）
- focus-visible：`outline:2px solid var(--accent); outline-offset:2px;`；`role="tablist"/"tab"` + `aria-selected` 不变。

### 6.10 步骤指示 `.steps/.step`

- `.steps { display:flex; align-items:center; flex-wrap:wrap; gap: var(--gap-sm); font-size: var(--fs-sm); color: var(--text-3); }`
- `.step { display:inline-flex; align-items:center; gap:6px; }`
- `.step__dot { width:20px; height:20px; border-radius: var(--radius-badge); display:inline-flex; align-items:center; justify-content:center; background: var(--surface-3); color: var(--text-3); font-size:11px; font-weight:600; }`（圆点改方圆，裁决 R1）
- `.step.is-active { color: var(--text); }` `.step.is-active .step__dot { background: var(--accent-strong); color:#fff; }`
- `.step.is-done .step__dot { background: var(--ok-bg); color: var(--ok-text); }`（已完成步骤可把数字换 `✓`）
- `.step__sep { color: var(--text-3); }`（`→`）

### 6.11 提示条 `.notice`

- 基类（默认 warn 档，与现状一致）：`display:flex; gap: var(--gap-sm); align-items:flex-start; padding:12px 16px; border-radius: var(--radius-card); border:1px solid var(--warn-border); background: var(--warn-bg); color: var(--warn-text); font-size: var(--fs-body);`（前缀图标 `⚠️`）
- 变体：`.notice--ok`（ok 三件套）、`.notice--bad`（bad 三件套）、`.notice--info`（info 三件套，新增）。
- `.notice a { color: inherit; font-weight:500; }`（链接用同色+下划线 hover，不用蓝色外链色）。
- 不得放在另一个 `.panel` 内部造成嵌套卡片（放页面级或模态内直接子级）。

### 6.12 Toast `.toast`

- 定位：`position:fixed; top:16px; right:16px; z-index:300; max-width: calc(100vw - 32px); padding:10px 16px; border-radius: var(--radius-control); font-size: var(--fs-body); box-shadow: var(--shadow-md);`
- 默认：`background: var(--text); color: var(--bg);`（暗色下自动反色为浅底深字，14:1）
- `.toast--ok { background: var(--ok-text); color:#fff; }`（5.02:1）`.toast--bad { background: var(--bad-text); color:#fff; }`（6.47:1）
- 入场：`animation: toast-in var(--dur-lg) var(--ease);`（`from { opacity:0; transform: translateY(-8px) }`）；离场由 JS 控制（现状直接 remove，可接受；若要淡出加 150ms opacity 过渡后 remove）。

### 6.13 模态框 `.overlay/.modal`

- `.overlay { position:fixed; inset:0; z-index:200; background: var(--overlay); display:flex; align-items:center; justify-content:center; padding:16px; overflow-y:auto; }`（无 backdrop-blur，反玻璃态）
- `.modal { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-md); padding:24px; width:100%; max-width:520px; display:flex; flex-direction:column; gap: var(--gap-md); }`（任务模态字段多用 `.modal--wide { max-width:560px; }`）
- `.modal__title { font-size: var(--fs-h2); font-weight:600; color: var(--text); }`
- `.modal__actions { display:flex; gap: var(--gap-sm); justify-content:flex-end; }`
- 入场：`animation: modal-in var(--dur) var(--ease);`（opacity 0→1 + `translateY(4px) scale(0.98)` → 1/0）；`role="dialog" aria-modal="true"` 与 ESC/点遮罩关闭保持现状。
- `<640px`：模态接近全宽（`max-width:none`），actions 换行仍右对齐。

### 6.14 空状态 `.empty` 与加载骨架 `.skeleton`

- `.empty { text-align:center; color: var(--text-2); padding:32px 16px; display:flex; flex-direction:column; align-items:center; gap:8px; }`
  - `.empty__icon { font-size:28px; opacity:.6; }`（📭 无数据 / 🗒️ 无日志）
  - `.empty__title { font-size: var(--fs-body); font-weight:500; color: var(--text); }`
  - `.empty__hint { font-size: var(--fs-sm); color: var(--text-2); }` + 可选 `.btn--sm` 行动作（如「+ 新建任务」）。
- 页面级加载：`.panel` 内 `.empty` + 「加载中…」文案（现状 `<p class="muted">加载中...</p>` 升级为带图标的空状态样式）。
- `.skeleton`：`background: var(--surface-3); border-radius: var(--radius-badge); animation: skeleton-pulse var(--skeleton-dur) var(--ease) infinite;`（`@keyframes skeleton-pulse { 50% { opacity:.5 } }`，**不用渐变 shimmer**）；`.skeleton--text { height:12px; }` `.skeleton--title { height:16px; width:40%; }` `.skeleton--kpi { height:36px; width:60%; }`；列表骨架 = 3–4 行 `skeleton--text`。
- 按钮/行的局部加载沿用 `.is-loading`（§6.7）。

---

## 7. 交互状态规范（统一矩阵）

| 状态 | 规则 | 适用元素 |
|---|---|---|
| hover（可操作行/面板） | 只换底色：`background: var(--hover-bg)`，150ms ease-out；**无位移无缩放** | `.row`、`.panel--interactive`、表格行 |
| hover（KPI 卡） | `translateY(-2px)` + `shadow-md` + 数字 `scale(1.02)` + 数字色 `--accent-strong` | `.kpi`（风格特许的唯一上浮） |
| hover（按钮/图标钮/侧栏项） | 按 §6.1/6.2/6.7 变体表换底色；侧栏项换 `bg-white/5→/10` | 全部可点元素 |
| active（按下） | `transform: scale(0.97)`，150ms ease-out | 按钮、`.icon-btn`、`.tab`、`.sidebar__link`；大面积面板用 `scale(0.99)` |
| focus-visible | `outline: 2px solid var(--accent); outline-offset: 2px;`（输入框用 border+ring 方案）；`:focus` 不画环（鼠标点击不暴露） | 全部可交互元素 |
| selected（导航当前页） | 侧栏 `bg-white/10` + 白字 + 500 字重；tab `.is-active` 白底阴影 | `.sidebar__link`、`.tab` |
| 加载中 | `.is-loading`：opacity .65 + `pointer-events:none` + `cursor:progress`；区块级用 `.skeleton`/「加载中…」空态 | 按钮、页面 |
| 空状态 | `.empty`（图标+标题+提示+可选动作），不得只显示空白 | 列表、表格、搜索无结果 |
| 禁用 | `opacity:.55; cursor:not-allowed;` + 保留原生 `disabled` 语义 | 按钮、输入 |
| 错误 | 边框 `--bad-text` + ring 12% + `.field__error` 文字（12px `--bad-text`） | 表单、notice--bad |

**动效降级（`prefers-reduced-motion: reduce`）**：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .kpi:hover, .panel--interactive:active, .btn:active, .icon-btn:active, .tab:active { transform: none; }
  .kpi:hover .kpi__value { transform: none; }
  .panel--dashed:hover { transform: none; }
}
```

（保留颜色过渡降至瞬时即可，不删 hover 底色反馈——底色是可达性信息，不是装饰。）

---

## 8. 新旧类名对照表（Phase 3 改 `app.js` 用）

| 现有类（public/style.css + app.js 用法） | 新类 | 变化要点 |
|---|---|---|
| `.shell` | `.layout` + `.main` + `.content` | 顶部导航壳 → 侧栏+顶栏+内容三件套；`max-width:1080px` 改 `.content` 1400px |
| `.nav` / `.brand` / `.links` / `.nav-link` | `.sidebar` / `.sidebar__brand` / `.sidebar__nav` / `.sidebar__link` | 横导航 → 256px 深色竖导航；active 类名 `active`→`is-active`（或保留 `active`，二选一后全局统一） |
| （无） | `.topbar` / `.topbar__title` / `.topbar__search` / `.topbar__user` / `.icon-btn` / `.avatar` | 新增顶部工具栏 |
| `.bento` / `.col-1/2/4` / `.row-2` | `.grid` / `.grid--kpi` / `.grid--panels` / `.col-1/2/3/4` | Bento 自由跨列 → KPI 4 等宽 + 面板 3 列主次（2/3+1/3）；删 `.row-2` |
| `.card` | `.panel` | 值全面更新（12px 圆角/灰-100 边/shadow-sm） |
| `.card--lift` | `.kpi`（KPI 场景）或 `.panel--interactive` | 通用卡不再上浮；上浮仅 KPI |
| `.card--dashed` | `.panel--dashed` | 圆角 12px，hover 换底色 |
| `.card--head/__title/__sub/__body/__foot/__icon` | `.panel__head/__title/__sub/__body/__foot/__icon` | 命名对齐；标题升 H2/H3 档 |
| `.stat` / `.stat__num` / `.stat__label` / `.stat--ok/bad/neutral` | **保留旧类名**（面板内嵌数值，规格 `--fs-h2`/600）；KPI 行另用 `.kpi__value` / `.kpi__label` / `.kpi__trend--up/down/flat` | 30px→20px 档（stat）/36px（kpi）、700→600；KPI 趋势行有真实数据才渲染；分工见附录 A.1（02-C2） |
| `.badge` / `.badge--ok/bad/warn/neutral` | 同名 | 圆角 999px→6px；浅底深字值更新 |
| `.btn` / `.btn--primary/secondary→默认` / `.btn--danger` / `.btn--ghost` / `.btn--sm` / `.btn--block` | 同名 | primary 换 `#4f46e5`；默认钮=secondary 语义（`--surface-3` 底）；sm 圆角 10→8px |
| `.field` / `.field__label/__hint/__error` | 同名 | 输入底色 `--surface-2`、focus ring 换 indigo |
| `.input` / `.select` / `.textarea` | 同名 | 值更新；select 保留原生箭头 |
| `.switch` / `.slider` | 同名 | 轨道/旋钮 999px→6px |
| `.meter` / `.meter__seg` / `.is-on` / `.is-warn` | 同名 | 圆角 6px；色板换语义 token |
| `.tabs` / `.tab` / `.is-active` | 同名 | 容器 8px、内项 6px 圆角 |
| `.steps` / `.step` / `.step__dot` / `.step__sep` / `.is-active` / `.is-done` | 同名 | 圆点 50%→6px |
| `.notice` / `.notice--ok/bad` | 同名 + 新增 `.notice--info` | 圆角 16→12px；色板换语义 token |
| `.toast` / `.toast--ok/bad` | 同名 | 圆角 12→8px；反色方案不变 |
| `.overlay` / `.modal` / `.modal__title` / `.modal__actions` | 同名 + `.modal--wide` | 圆角 16→12px；遮罩去半透明黑保留 |
| `.rows` / `.row` / `.row__main/__title/__meta/__actions/__mono` | 同名 | 行 padding 12px 4px→12px 16px；新增 hover 底色 |
| `.table` / `.table th/td` / `.table-scroll` | 同名（`.table-scroll`→`.table-wrap` 可选） | 表头 12px/500 灰；行 hover 底色 |
| `.empty` | `.empty` + `.empty__icon/__title/__hint` | 升级为图标+标题+提示结构 |
| `.page-title` / `.prose` / `.mono` / `.muted` / `.dim` | 同名 | 字号按 §3 对齐；`.dim` 仅装饰 |
| `.mt-8/.mt-16/.mb-16/.flex/.flex-between/.hidden/.center-col` | 同名 | 保留工具类；新增 `.stack`（`display:flex; flex-direction:column; gap: var(--gap-lg)`） |
| `.adv`（details 折叠） | 同名 | 圆角 8px、底色 `--surface-2` |
| （无） | `.skeleton` / `.skeleton--text/title/kpi` | 新增骨架屏 |
| （无） | `.sidebar-backdrop` / `.sidebar.is-open` | 新增移动端抽屉 |
| `updateNav()` 里 `nav a.nav-link` 选择器 | 改 `.sidebar__link`（`data-route` 机制不变） | DOM 类名替换即可，逻辑不动 |

> `data-action` 事件委托、`esc()`、hash 路由表、全部 API 调用**零改动**；仅替换类名与 DOM 结构。

---

## 9. 矛盾消解记录（裁决 + 理由）

| # | 冲突 | 裁决 | 理由 |
|---|---|---|---|
| R1 | 风格禁用 `rounded-full`，但开关/steps 圆点/头像/徽章常规是圆形 | 一律改 `--radius-badge`（6px）方圆形；头像 8px；徽章 6px | 黑名单是 class 级 `^rounded-full`；在自定义 CSS 里写 `border-radius:50%` 属变相规避，按「禁止」精神执行 |
| R2 | 风格要求主按钮 `bg-[#6366f1] text-white`，同时自检要求正文对比 AA ≥4.5:1；实测 `#6366f1` 白字仅 **4.47:1** | `#6366f1` 保留为品牌/焦点环/KPI hover 数字/图表色（非文本或 ≥3:1 场景）；**主按钮底用 `#4f46e5`（6.29:1），hover `#4338ca`**；暗色按钮加 1px `#6366f1` 边框保证边界 3:1 | 两条都来自同一文档，取「可访问性硬指标」优先，同时不丢品牌色 |
| R3 | KPI 需要「大字号数值」，但 `text-5xl~text-8xl` 被禁 | KPI 数字 = **36px（text-4xl 档）+ 600 字重 + tracking-tight + tabular-nums** | text-4xl 不在黑名单；36px 对 0–999 计数已足够「大」 |
| R4 | §2 同时写 `transition-colors duration-200` 与「微交互节奏 duration-150 ease-out」 | 全局 **150ms ease-out**；仅覆盖层/toast 入场用 200ms | 「Crisp SaaS Feel」是更具体的微交互定义，200ms 留给大面积出现动画 |
| R5 | §2 同时写 `active:scale-95` 与 `active:scale-[0.97]` | 统一 **0.97**（大面积面板 0.99） | 0.97 出现在组件细则与 a11y 自检里，是最终意图；0.95 过冲 |
| R6 | §2 写「悬停位移：无；悬停缩放：无」，又写「KPI hover 上浮 + 数字放大」+「hover:opacity-90」 | 通用面板/行：**只换底色**；**仅 KPI** 允许 -2px 上浮 + 数字 scale(1.02)+变色；按钮 hover 不用 opacity-90（对比度会波动），换深一档底色 | 例外条款（KPI）是风格签名，opacity-90 与 AA 冲突故弃 |
| R7 | 语义色 `#10b981/#f59e0b/#ef4444` 作文字在白底仅 2.5–3:1 | 原色只做图表/实心块/圆点；**文字场景用深色变体**（亮 `#047857/#a16207/#b91c1c`，暗 `#4ade80/#fbbf24/#f87171`） | 满足「正文 AA」红线 |
| R8 | 风格要求顶栏含「搜索」，但项目要求接口/业务不变、不做假控件 | 顶栏搜索实现为**当前页客户端过滤**（纯视觉层，过滤 `.panel__title`/`.row__title` 文本，不发请求）；若 Phase 2/3 裁剪范围则**整槽移除**，不留不可用控件；通知铃 = 跳 `#/logs` 的链接；用户区 = 管理员 + 退出（复用现有 logout） | 虚假控件违背可用性；客户端过滤零接口风险 |
| R9 | §2 边框色 `border-gray-200` vs §4 卡片 `border-gray-100` | 结构分隔（顶栏/表头/侧栏/输入框）用 `--border #e5e7eb`；卡片/面板边框用 `--border-card #f3f4f6`（暗色两者都 `#374151`） | 按原文语境分别落地，暗色统一保证可见性 |
| R10 | 统一样式 vs select 原生箭头 | **保留原生 select 外观**，只统一盒模型/focus 态；不引 data-URI/SVG 资源 | 零构建+CSP 安全优先；原生控件在各平台可预期 |
| R11 | 暗色模式侧栏也要「深色签名 `bg-gray-900`」，但暗色页面底通常也是深色，会糊成一片 | 暗色页面底用更深的 **`#030712`**（gray-950），侧栏仍 **`#111827`**（gray-900 原值），面板 `#1f2937` | 侧栏值不动（满足约束），用页面底加深拉出层次 |
| R12 | `gray-400`（亮 2.54:1）/ `gray-500`（暗 3.04:1）作辅助字不达 AA | `--text-3` 仅限 **placeholder/禁用/装饰/step 未到状态**；信息性辅助文字一律 `--text-2` | AA 红线只约束「承载信息的文字」 |
| R13 | 风格 §6 图表区要求 aspect-ratio/图表，但项目无图表库且零构建 | 图表区用面板网格 + CSS-only `.spark` 迷你条（纯色、无渐变）承载；容器按 `aspect-ratio:16/9` 预留；不引图表库 | 保留「主 2/3+辅 1/3」签名，不破坏零构建 |
| R14 | 现有暗色用 zinc 系，风格用 gray 系 | 全量换 gray 系 token（§1.1），zinc 值全部退役 | 风格文档是唯一依据 |

---

## 10. 交付自检（对齐风格 §3 附加项）

- [x] 无紫→蓝渐变（全文档零 `linear-gradient`；骨架屏用 opacity 脉冲）
- [x] 不用 Inter/Roboto/Geist，系统字体栈；无外部字体/CDN
- [x] 无嵌套卡片（§6.4 明令禁止）
- [x] 不在彩色背景上放灰字（徽章/notice 全部浅底深字，§2.3）
- [x] 正文对比度 ≥4.5:1（§2.2 逐项验算；`--text-3` 仅装饰）
- [x] 无 bounce/elastic 缓动（仅 `cubic-bezier(0,0,.2,1)`）
- [x] `prefers-reduced-motion` 降级（§7）
- [x] 正文行宽 ≤75 字符（`.prose` 68ch）
- [x] 无单侧粗边框装饰条（侧栏 active 仅底色）
- [x] 无渐变文字；不把玻璃态当默认（遮罩纯色）；无 tiny uppercase eyebrow
- [x] 面板大小有主次（§5 建议排布 + `.col-*` 工具类）
- [x] 加载态/空状态/禁用态全覆盖（§6.14、§7）
- [x] 类黑名单自查：`rounded-none/3xl/full`、`shadow-2xl`、`font-black/extrabold`、`text-5xl~8xl` 在本规范中零出现（KPI=36px=text-4xl 档）

## 11. 给 Phase 2 / Phase 3 的备注

- Phase 2：布局 IA（KPI 取值、面板主次分配、移动端抽屉交互细节、搜索过滤范围）以 §5 建议排布为起点细化；顶栏标题与页面 H1 的层级关系统一按 §3。
- Phase 3：先替换 `:root`/暗色/md 三个 token 块（§1.7），再按 §8 对照表改 `app.js` 类名；`updateNav()` 选择器、登录页 `.center-col`、`data-action`/`esc()` 不动；若新增静态文件必须同步 `wrangler.toml` 的 `run_worker_first`（本规范不要求新增文件）。
- 图标：全部用 emoji（§6.1 列表），平台渲染差异可接受；如需替换为内联 SVG，必须内联进 HTML（不引外部资源）。

---

## 附录 A · Phase 2 增量回填（与 `02-ux-spec.md` 对齐，保持单一事实源）

> 来源：`docs/ui-redesign/02-ux-spec.md` §9 裁决表与 §11。以下内容已并入本规范，Phase 3 以 02 的 §8 类名清单为准落地；本附录与上文冲突时，以 02 的裁决（C2/C3/C6）为准，其余仍以本规范为准。

### A.1 `.stat` 家族保留（02-C2）

- `.stat / .stat__num / .stat__label / .stat--ok / .stat--bad / .stat--neutral / .stat-row` **保留旧类名**，用于**面板内嵌数值**（仪表盘「今日执行」三数值、任务/账户/日志页头部计数面板）。
- 与 `.kpi` 的分工：`.kpi` 仅用于仪表盘 KPI 行（36px）；`.stat__num` 为面板内嵌数值，规格 = `--fs-h2`（18px/<768px 20px）/ 600 / `tabular-nums`，色 `--ok-text` / `--bad-text` / `--text`。
- 视觉规格不同（36px vs 20px），不合并、不改名——减少 Phase 3 触点，两处语义清晰。

### A.2 KPI 行断点修正（02-C3，覆盖 §6.3）

- `.grid--kpi`：≥1024px 4 列；768–1023px 2 列；**<768px 1 列**（原 <640px 作废，按 1024/768 两档边界统一）。

### A.3 新增骨架修饰类（02 §6.3，并入 §6.14）

- `.skeleton--badge { height:18px; width:56px; }`
- `.skeleton--narrow { max-width:120px; }`
- `.row--skeleton { align-items:center; }`（日志筛选切换时的 3 行局部骨架行；每行 `row__main` 内 `.skeleton--title` + `.skeleton--text`，右侧 `.skeleton--badge` + `.skeleton--narrow`，骨架块 `aria-hidden="true"`）
- 页面级初始加载占位必须含字面「加载中」文案（`tests/frontend.test.ts` 探针顺序断言依赖，见 02 §6.2）。

### A.4 新增状态类与容器类（02 §5 / §8）

- `.is-filtered { display:none !important; }`：顶栏搜索命中过滤（含 `.panel--dashed` 添加卡在查询时隐藏）。
- `.is-busy`：任务卡 `.switch` 请求在飞时 `opacity:.55; pointer-events:none;`（外层 `.switch` 加类，`input` 同时 `disabled`）。
- `.is-error`（输入框错误态，与 §6.6 一致，ring 用 `--bad-ring: rgba(185,28,28,.12)`，需补进 token 块）：边框 `--bad-text` + `box-shadow: 0 0 0 3px var(--bad-ring)` + `aria-invalid="true"`。
- `body.is-auth`（登录态）：隐藏 `.sidebar / .sidebar-backdrop / .topbar`，`.content` 全屏居中；由 `updateNav()` 一行 `classList.toggle` 驱动。
- `body.drawer-open`：抽屉打开态，`overflow:hidden` 锁滚动 + `.sidebar-backdrop` 显示（`--overlay` 纯色，无模糊）。
- `.grid--cards`（2 列，<768px 1 列）：任务/账户卡片网格容器。
- `.panel--upcoming`：仪表盘「即将执行」全宽面板（`.panel--flat`，`padding:0` 内嵌 `.rows`），同时是搜索作用域容器。
- `.topbar__search`：`input type="search"`，≥1024px 宽 240px、768–1023px 宽 160px、**<768px 整槽隐藏**（`hidden` 类，不留假控件）；实现为当前页客户端过滤（范围/匹配字段/无结果提示见 02 §2.1，`esc()` 处理查询词）。
- `.sidebar__ico`：侧栏导航项图标包裹（`aria-hidden="true"`）。
- 导航当前页类名统一为 **`is-active` + `aria-current="page"` 双写**（02-C6，替换旧 `active` 类）。

### A.5 z-index 分工（02 §8.1）

`.sidebar-backdrop` 35 / `.topbar` 45 / `.sidebar` 50 / `.overlay` 200 / `.toast` 300（与本规范 §6.12/§6.13 现有值一致，此处集中备查）。抽屉媒体查询 CSS 块见 A.7。

### A.6 需补入 §1.7 token 块的变量

`--bad-ring: rgba(185,28,28,.12);`（亮色）/ 暗色 `rgba(248,113,113,.18)`——供 `.is-error` 与输入框错误态共用。

### A.7 抽屉媒体查询 CSS 块（归档自 02 §8.3，含 <768px 全部壳层规则）

> 来源：`02-ux-spec.md` §8.3 配套 CSS。z-index 与本附录 A.5 分工一致（sidebar 50 > topbar 45 > backdrop 35，保证抽屉打开时汉堡仍在 backdrop 之上可点击关闭）。遮罩用 `var(--overlay)` 纯色（**禁 `backdrop-filter`**，反玻璃态）——02 正文中 `rgba(17,24,39,.4)` 的写法以本 token 为准（P1 §1.1 定义亮色 `rgba(17,24,39,.5)`、暗色 `rgba(3,7,18,.6)`），全文档只保留一处数值。

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

配套约定（02 §4.3，视觉相关部分）：
- 关闭路径：backdrop 点击 / ESC / 点导航链接后 / resize 跨过 768px 强制关闭 / 汉堡 toggle。
- 焦点管理：打开焦点移入第一个 `.sidebar__link`；关闭焦点还给汉堡；打开期间 `body.drawer-open` 锁滚动。
- <768px 顶栏：标题 H1 20px、搜索整槽隐藏（`.hidden`）、铃铛保留、用户区只留头像。
- `@media (hover: hover)` 包裹全部 hover 底色规则（防触屏粘滞）；触屏下降级为 active 底色，可达性信息不丢。






