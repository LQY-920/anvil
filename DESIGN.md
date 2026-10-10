# Anvil 界面实现约定

更新时间：2026-10-10。旧暖纸色板与三选一原型已退役，当前界面采用 Zinc 中性色及语义状态色。本文记录实现约定，不重复维护色值表或另一份 UI 迭代计划。

## 样式来源

| 文件 | 职责 |
|---|---|
| [globals.css](apps/web/src/styles/globals.css) | Tailwind v4、shadcn 基础变量与样式层 |
| [tokens.css](apps/web/src/styles/tokens.css) | Anvil 语义 token、Diff/日志区/排版变量 |
| [base.css](apps/web/src/styles/base.css) | legacy 层中的旧元素样式 |
| [useTheme.ts](apps/web/src/hooks/useTheme.ts) | html data-theme 的 light/dark 切换 |

以实际 CSS 为准，使用既有 token 和组件类，不硬编码新色值。保留 theme、base、legacy、components、utilities 的层次，避免旧选择器盖住工具类。日志区仍使用部分 forge 变量，不因为名字旧就删除。

## 交互和可访问性

- 先展示目标、执行状态、阻塞和交付摘要，原始日志折叠。
- 运行完成、提交报告、验证通过、人工批准、远端合入分别表达。
- 状态文字使用 labels.ts 的统一文案；消息呈现复用 trace-presenter。
- 危险/重复提交由 UI 在途状态和服务端幂等共同处理，失败保留可恢复输入。
- 浅色/深色、焦点、键盘、长文本、空态/加载/失败均需检查，颜色不是唯一状态信号。
- 手机适配与配对认证按 [T05](docs/prds/T05-mobile-access.md)验收，当前桌面页面不视为已支持手机。

## 验证与变更

按 [贡献指南](CONTRIBUTING.md)记录真实测试。改 token 后检查引用页面及双主题；布局与交互变化补相关用例。不要引用已退役原型中的尺寸、色值或截图作为当前验收基准。

