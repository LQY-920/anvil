# Anvil Design System

> 视觉系统：双主题（浅色为主、深色配套）、OKLCH 色板、语义 token。所有界面代码只允许引用本文件的变量，禁止硬编码色值。
> 调研依据：Linear / Multica / Orca / GitHub Primer（见 docs/superpowers/research 调研笔记）。

## Color Strategy

**Restrained**：暖调中性色为主体 + 单一强调色（forge ember，锻造余烬）用量 ≤10%。颜色只表达状态与可操作项，不做装饰。

- 中性色全部带极微弱暖色倾向（hue 60，chroma 0.005–0.01），避免死灰。
- 深色主题不是反色，是独立设计：偏暖的深炭，表面逐级提亮。

## Surfaces（表面层级）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--app-shell` | `oklch(0.955 0.006 70)` ≈#f0efeb | `oklch(0.165 0.006 60)` ≈#161512 | 最外框 |
| `--page-canvas` | `oklch(0.982 0.004 70)` ≈#f8f7f4 | `oklch(0.185 0.006 60)` ≈#1a1916 | 看板/列表所在层 |
| `--surface` | `oklch(0.995 0.002 70)` ≈#fcfbfa | `oklch(0.215 0.007 60)` ≈#201f1b | 卡片 |
| `--surface-raised` | `oklch(1 0 0)` 纯白仅此处 | `oklch(0.245 0.008 60)` ≈#26251f | 浮层（modal/popover） |
| `--surface-hover` | `oklch(0.955 0.008 60)` | `oklch(0.26 0.008 60)` | hover 填充 |
| `--surface-border` | `oklch(0.905 0.006 60)` ≈#e3e1da | `oklch(1 0 0 / 7%)` | 卡片/面板边框（细边框优先，阴影只给浮层） |

## Text

| Token | Light | Dark | 对比度要求 |
|---|---|---|---|
| `--foreground` | `oklch(0.20 0.008 60)` ≈#24221e | `oklch(0.97 0.003 60)` | ≥12:1 |
| `--foreground-secondary` | `oklch(0.38 0.01 60)` | `oklch(0.82 0.006 60)` | ≥7:1 |
| `--muted-foreground` | `oklch(0.47 0.012 60)` ≈#6f6a5f（canvas 上 4.6:1，过 AA 下限，勿再调亮） | `oklch(0.70 0.008 60)` | ≥4.5:1 |
| `--faint-foreground` | `oklch(0.58 0.01 60)`（仅图标/装饰/禁用，3:1） | `oklch(0.60 0.008 60)` | ≥3:1，**禁用于正文** |

## Brand & Semantic

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--brand`（forge ember） | `oklch(0.47 0.10 45)` ≈#8f4f1f | `oklch(0.72 0.11 55)` ≈#d69a63 | 主按钮、链接、focus ring |
| `--brand-hover` | `oklch(0.42 0.10 45)` | `oklch(0.77 0.11 55)` | |
| `--brand-foreground` | `oklch(0.99 0.003 70)` | `oklch(0.20 0.01 60)` | 强调底上的文字 |
| `--info`（蓝） | `oklch(0.50 0.11 255)` | `oklch(0.72 0.10 255)` | running / 链接辅助 |
| `--review`（紫） | `oklch(0.48 0.12 295)` | `oklch(0.72 0.11 295)` | in_review |
| `--success`（绿） | `oklch(0.52 0.11 150)` | `oklch(0.72 0.11 150)` | done / completed |
| `--attention`（琥珀） | `oklch(0.55 0.12 80)` | `oklch(0.75 0.12 80)` | needs-you / blocked 待处理 |
| `--destructive`（红） | `oklch(0.50 0.16 25)` | `oklch(0.68 0.15 25)` | failed / 危险操作 |
| `--muted`（中性填充） | `oklch(0.93 0.006 60)` | `oklch(0.28 0.008 60)` | 灰徽章底、列底色基 |

**徽章公式**：`背景 = 语义色 12% alpha` + `文字 = 语义色实色` + `图标`。状态必须"图标+文字"双编码（色弱友好），禁止只用色点。

## 看板列底色（语义色 5% alpha，Multica 方案）

| 列 | 底色 |
|---|---|
| backlog / todo / cancelled | `--muted` 40% alpha |
| in_progress | `--info` 5% alpha |
| in_review | `--review` 5% alpha |
| done | `--success` 5% alpha |
| blocked | `--destructive` 5% alpha |

"📦 待验收"卡片：整卡 `--attention` 8% alpha 底 + 边框同色 30%——只有需要用户行动的卡片才染色（染色即"看我"原则）。

## Diff 配色（GitHub Primer 三层强调法 + 双编码）

| Token | Light | Dark |
|---|---|---|
| `--diff-add-line-bg` | `#dafbe1` | `oklch(0.60 0.12 150 / 15%)` |
| `--diff-add-word-bg` | `#aceebb` | `oklch(0.60 0.12 150 / 35%)` |
| `--diff-del-line-bg` | `#ffebe9` | `oklch(0.62 0.15 25 / 15%)` |
| `--diff-del-word-bg` | `#ffcecb` | `oklch(0.62 0.15 25 / 35%)` |
| `--diff-hunk-bg` | `#ddf4ff` | `oklch(0.65 0.10 240 / 15%)` |

行首 gutter 的 `+`/`-` 符号始终显示（红绿之外的第二编码），代码本体保留普通文字色。

## Typography

- 字体栈：`Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`；等宽：`ui-monospace, "Cascadia Code", "JetBrains Mono", monospace`
- 字阶（工具型高密度）：

| Token | size/line-height | 用途 |
|---|---|---|
| `--text-micro` | 11/15 | 徽章、计数、时间戳 |
| `--text-caption` | 12/16 | 元数据、列标题 |
| `--text-label` | 13/18 | 表单标签、次要正文 |
| `--text-body` | 14/20 | 正文、卡片标题 |
| `--text-title-sm` | 16/24 | 面板标题 |
| `--text-title` | 18/26 | 页面标题 |

- 字重：400 正文 / 500 强调 / 600 标题；不用 700+
- 日志流/diff 用等宽 micro（12px）+ `tabular-nums`

## Spacing / Radius / Shadow / Motion

- 间距：4px 基网（4/8/12/16/20/24/32/48）
- 圆角：`--radius-sm: 6px`（按钮/输入框/chip）、`--radius-md: 8px`（卡片）、`--radius-lg: 10px`（面板/modal）、pill 只给状态徽章
- 阴影（只给浮层）：`--shadow-menu: 0 4px 16px oklch(0.2 0.01 60 / 8%)`、`--shadow-modal: 0 8px 32px oklch(0.2 0.01 60 / 12%)`；深色版 alpha 加倍
- 动效：120–180ms `cubic-bezier(0.25, 0.46, 0.45, 0.94)`（ease-out-quad），只用于状态变化；禁回弹/弹性；`prefers-reduced-motion` 全关

## 组件约定

- **日志流**：类型徽章（agent=success 绿 / thinking=review 紫 / tool_use=info 蓝 / tool_result=muted 灰 / error=destructive 红）+ 默认折叠 tool 输出 + 长输出渐隐"展开全部"；等宽区可深色常驻（`--console-bg`，浅色主题下也是深炭底）
- **focus ring**：`0 0 0 2px var(--page-canvas), 0 0 0 4px color-mix(in oklch, var(--brand) 40%, transparent)`
- **滚动条**：6px 细条，跟随 `color-scheme`
- **空状态**：虚线圆角容器 + 32px muted 图标 + 一句正文，不插画
- **身份标识**：Agent = 圆形头像底 + 锤子/机械图标 + presence 圆点（running 绿脉冲 / idle 灰）；人 = 姓名首字母

## 双主题工程

- `:root` 放 light，`[data-theme="dark"]` 覆盖；`color-scheme` 同步设置
- localStorage 持久化 + 默认跟随系统（`prefers-color-scheme`）
- 切换时 `disableTransitionOnChange` 防闪烁

## 最终方向（2026-08-05 用户选定：方向 C「工匠暖纸」+ 左侧导航）

基于方向 C 原型（`docs/ui-previews/direction-c-forge.html`），与方向 A/B 的差异：

- **暖纸画布**：浅色主题 `--page-canvas: oklch(0.975 0.010 75)`，比中性值更暖一档
- **"锻造台"面板**：任务面板（交付区 + 执行日志流）浅色主题下也常驻深炭底（`--console-bg` 系），形成"浅色办公区 + 深色工作台"的材质对比。锻造台内的文字/徽章/diff 色用一套专用 token（`--forge-*`，等于深色主题值）
- **列标题 2px 语义色短粗线**：列底色保持中性，状态色由列标题下的短粗线承担
- **ember 使用略多**：链接、导航选中下划线、列计数、选中卡片描边
- **左侧导航**（替代顶栏）：宽 220px，`--app-shell` 底；自上而下——品牌（⚒ Anvil）→ 主导航（看板）→ 管理（Agents & Runtimes）→ 底部主题切换按钮。导航选中态：ember 文字 + 左侧 2px ember 短条 + `--surface-hover` 底。顶栏只保留页面标题与页面级操作（如"+ 新建 issue"）

### 布局骨架

```
┌──────────┬────────────────────────────────────────┐
│ 左侧导航  │  页面顶栏（标题 + 页面级操作）            │
│ 220px    ├──────────────────────────┬─────────────┤
│          │  看板（横向滚动列）        │  任务面板    │
│          │                          │  42%，锻造台 │
└──────────┴──────────────────────────┴─────────────┘
窗口 <1100px 时面板转 fixed 抽屉；<800px 左侧导航收起为图标栏
```

### 锻造台专用 token

| Token | 值（两主题相同） | 用途 |
|---|---|---|
| `--forge-bg` | `oklch(0.19 0.007 60)` | 面板底色 |
| `--forge-surface` | `oklch(0.24 0.008 60)` | 面板内卡片/输入框 |
| `--forge-border` | `oklch(1 0 0 / 9%)` | 面板内边框 |
| `--forge-text` | `oklch(0.92 0.005 60)` | 面板正文 |
| `--forge-text-dim` | `oklch(0.65 0.008 60)` | 面板次要文字 |
| `--forge-title` | `oklch(0.75 0.12 70)`（琥珀） | "锻造台"小节标题 |

面板内的语义色与 diff 色两主题均取深色主题值（`--forge-brand` / `--forge-info` / `--forge-review` / `--forge-success` / `--forge-attention` / `--forge-destructive` / `--forge-diff-*`，tokens.css），panel.css 将其别名到通用变量，保证浅色主题下深底对比。

