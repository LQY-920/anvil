# Spec：仓库常驻指引 + 表单体验（guidance-and-forms）

- 日期：2026-08-11
- 状态：已确认（来源 `docs/ROADMAP.md` 迭代项 6 + 7 打包）
- 分支：`guidance-and-forms`

## 目标

- 迭代项 6：同一仓库的规矩（"改完跑 pnpm test" 等）写一次、永久生效——目标仓库根的 `ANVIL.md` 在任务 prompt 组装时自动附加，减少返工轮次
- 迭代项 7：消灭双击双发与静默失败——按钮防重入、评论 Enter 提交、失败红字提示且不清空草稿

## 范围 A：runner 指引注入

现状：runner executor 组 prompt（目标契约：目标/完成标准/边界/停止规则 + 评论），无仓库级常驻指引。

改动（`apps/runner/src/executor.ts` 或其 helper，先看现状）：

1. 任务开工（prepareWorkdir 之后、spawn 之前）读取 `<workDir>/ANVIL.md`：存在且非空 → 追加一节 `## 仓库常驻指引（ANVIL.md）` 到 prompt 末尾；不存在 → 不加。文件超 8KB 截断并标注 `（已截断）`。
2. 读取失败（权限/编码）静默跳过，不影响任务。
3. 本地路径与远程 URL 仓库统一：workDir 即 worktree/缓存工作区，ANVIL.md 随仓库自带。
4. 测试：fake CLI 捕获 prompt，断言含/不含指引节；超 8KB 截断；读取失败不炸。沿用 apps/runner/test 现有风格。

## 范围 B：server 指引预览端点

改动（`apps/server/src/routes/` 新文件 + app.ts 注册）：

1. `GET /api/guidance?repo=<urlencoded>`：
   - repo 缺失 → 400 `{error:"repo required"}`
   - 本地路径：读 `<repo>/ANVIL.md`；远程 URL：经 repocache 路径（`services/review.ts` 的 repoCachePath，若缓存不存在 → found:false）
   - 命中 → `{found:true, content: 前 2000 字符, truncated: boolean}`；未命中 → `{found:false}`
2. 测试：本地临时目录造 ANVIL.md 断言 found/content/truncated；不存在 → found:false；缺参 → 400；URL 无缓存 → found:false。

## 范围 C：web 预览 + 表单防重

改动（`apps/web/src/pages/BoardPage.tsx` 的 CreateIssueModal、`apps/web/src/components/TaskPanel.tsx`、`apps/web/src/api.ts`）：

1. 新建弹窗：目标仓库输入后（400ms 防抖）调 `GET /api/guidance?repo=...`；found 时在输入框下方显示预览块（等宽小字：内容前 200 字符 + `将随任务注入`；truncated 标注）。repo 清空时预览消失。
2. 防重入：创建任务/发送/提交意见并重跑/合入 按钮在请求进行中 disabled（按钮文案或 spinner 沿用现有 Button 约定，不加新依赖）。
3. 评论框：Enter 提交、Shift+Enter 换行（Textarea onKeyDown）。
4. 评论发送失败：输入框下方红字 `发送失败：<错误信息>`，草稿保留（仅评论框；打回/合入已有各自错误展示，不扩大范围）。
5. 组件测试：双击创建只发一次请求；Enter 提交、Shift+Enter 不提交；发送失败草稿保留且红字出现；guidance 预览块 found/未found 两态。

## 非目标

- workspace 级指引（单源 ANVIL.md，后续需要再加）
- 打回/合入按钮的失败重设计（打回已有触发提示、合入已有 mergeError 红字）
- 其他表单的键盘流（迭代项 8 统一做）

## 验收对齐

对应 ROADMAP 迭代项 6/7 验收标准；合并门槛：pnpm test 全绿 + 四包 tsc 零错 + test-craft 用例执行回填（`docs/tests/2026-08-11-guidance-forms-testcases.md`）。
