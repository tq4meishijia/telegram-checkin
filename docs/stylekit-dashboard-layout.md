# StyleKit · Dashboard Layout（仪表盘布局）风格参考

> 来源：https://www.stylekit.top/zh/styles/dashboard-layout （用户提供全文，落盘供团队引用）
> 用途：telegram-checkin 管理前端重做的唯一风格依据。冲突时以「绝对禁止」为最高优先级。

## 1. 布局结构（签名特征）

- 左侧：深色侧边导航栏 `bg-gray-900 w-64`（固定，当前页高亮 `bg-white/10`，图标+文字，底部放用户信息）
- 顶部：白色工具栏（搜索、通知、用户信息）
- 主体：KPI 卡片行（grid-cols-4）+ 图表面板（主 2/3 + 辅 1/3）+ 数据表格
- 面板大小必须有主次（禁止所有面板完全相同）；间距全局一致

## 2. Token 字典

### 边框
- 宽度 `border`；颜色 `border-gray-200`；圆角 `rounded-xl`

### 阴影
- 小/中 `shadow-sm`；大 `shadow-md`；悬停 `hover:shadow-md`；聚焦 `focus:shadow-sm`

### 交互
- 悬停位移：无；悬停缩放：无；悬停透明度 `hover:opacity-90`
- 过渡 `transition-colors duration-200`；按下 `active:scale-95`
- 微交互节奏：`duration-150 ease-out`（Crisp SaaS Feel）
- KPI 卡片 hover 轻微上浮 + `group-hover` 核心数字微放大/变色
- 数据卡片/行/可操作面板 hover 必须给明确底色反馈（`hover:bg-gray-50`）
- 按钮 `active:scale-[0.97]` + 可见 focus ring（a11y）

### 字体
- 标题 `font-semibold tracking-tight`；正文 `font-sans`；等宽 `font-mono`

### 字号
- Hero `text-2xl md:text-3xl`；H1 `text-xl md:text-2xl`；H2 `text-lg md:text-xl`；H3 `text-sm md:text-base`；正文 `text-sm`；小字 `text-xs`

### 间距
- Section `py-4 md:py-6`；容器 `px-4 md:px-6`；卡片 `p-4 md:p-6`
- 小 `gap-2 md:gap-3`；中 `gap-3 md:gap-4`；大 `gap-4 md:gap-6`

### 颜色角色
- 背景主色 `bg-[#f9fafb]`；背景辅色 `bg-white`；侧边栏 `bg-gray-900`
- 强调色 `#6366f1`（主）、`#10b981`（成功/增）、`#f59e0b`（警示/平）、`#ef4444`（危险/减）
- 正文主色 `#111827`；辅色 gray-500；弱化 gray-400
- 主按钮 `bg-[#6366f1] text-white`；次按钮 `bg-gray-100 text-gray-700`

## 3. [FORBIDDEN] 绝对禁止（匹配即重写）

Class 黑名单：`rounded-none` / `shadow-2xl` / `font-black` / `font-extrabold` / `text-5xl`~`text-8xl` / `rounded-3xl` / `rounded-full`
模式：`^rounded-(?:none|3xl|full)`、`^shadow-2xl`、`^text-[5-8]xl`

风格漂移红线：
1. 侧边栏和内容区比例失调
2. 数据面板间距不一致
3. 忽略加载状态和空状态
4. 所有面板大小完全相同
5. 过多装饰性元素分散注意力

交付自检附加项：无紫→蓝渐变；不用 Inter/Roboto/Geist 等过度使用字体（用系统字体栈）；无嵌套卡片；不在彩色背景上放灰字；正文对比度 WCAG AA（≥4.5:1）；无 bounce/elastic 缓动；动效有 prefers-reduced-motion 备选；正文行宽 ≤65-75 字符；无单侧粗边框装饰条；无渐变文字；不把玻璃态当默认风格；无每 section 标题上的 tiny uppercase eyebrow。

## 4. [REQUIRED] 组件必须包含

- 按钮：`rounded-lg font-medium text-sm transition-colors`
- 卡片：`bg-white rounded-xl shadow-sm border border-gray-100`
- 输入框：`bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#6366f1]/20 focus:border-[#6366f1] transition-all`

## 5. KPI 卡片规则

- `grid grid-cols-4` 排列；每卡：标签、大字号数值、变化趋势
- 增长 `text-green-500`（本风格即 `#10b981` 语义）；下降 `text-red-500`（`#ef4444`）；平稳 `text-yellow-500`（`#f59e0b`）
- 状态不得只用颜色传达（配文字/图标，WCAG）

## 6. 图表区域规则

- 主图表占 2/3 宽（col-span-2）；辅助图表占 1/3；`aspect-ratio` 保持比例（aspect-video / aspect-square）

## 7. 响应式三档

- 大屏：侧边栏 + 4 列 KPI + 图表
- 中屏：侧边栏 + 2 列 KPI
- 小屏：隐藏侧边栏（汉堡/抽屉）+ 1 列 KPI

## 8. 与本项目的适配约束（红线，来自项目记忆）

- 零构建原生 SPA：`public/index.html` + `public/style.css` + `public/app.js`，**不引入构建、不引外部字体/CDN**（CSP `script-src 'self'`）
- hash 路由不变：`#/login` `#/` `#/tasks` `#/accounts` `#/logs` `#/settings`
- 全部 API 端点与业务逻辑不变，仅改视觉与布局
- 事件委托（`data-action`）不变；HTML 转义 `esc()` 不变
- 若新增静态文件，必须同步加进 `wrangler.toml` 的 `run_worker_first`
- 保留现有 `prefers-color-scheme` 暗色模式能力（项目既有特性，侧边栏两种模式下都保持深色签名）
- 交互状态必须统一处理：hover / active / focus-visible / selected(active 导航) / 加载中 / 空状态 / 禁用
- 动效 `prefers-reduced-motion` 降级
