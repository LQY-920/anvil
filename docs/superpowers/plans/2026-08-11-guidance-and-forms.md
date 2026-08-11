# Plan：仓库常驻指引 + 表单体验（guidance-and-forms）

- 日期：2026-08-11 | Spec：`docs/superpowers/specs/2026-08-11-guidance-and-forms.md`
- 分支：`guidance-and-forms`

## 任务拆分（三个 subagent 并行，按包隔离）

### T1 · runner 指引注入（coder）

文件：`apps/runner/src/executor.ts`（或 prompt 组装所在文件，先找）、`apps/runner/test/`

- spawn 前读 `<workDir>/ANVIL.md`（>8KB 截断标注、读取失败静默跳过），非空则 prompt 末尾追加 `## 仓库常驻指引（ANVIL.md）\n\n<内容>`。
- 测试：fake CLI 捕获 prompt 断言含/不含指引节、截断标注、读失败不炸。沿用现有 fake CLI 测试（repocache/executor 相关）写法。

### T2 · server 指引预览端点（coder）

文件：`apps/server/src/routes/guidance.ts`（新增）、`apps/server/src/app.ts`（注册）、`apps/server/src/services/review.ts`（repoCachePath/isRepoUrl 复用，若未导出则补导出）、`apps/server/test/guidance.test.ts`

- `GET /api/guidance?repo=<urlencoded>`：缺参 400；本地路径读 `<repo>/ANVIL.md`；URL 走 repocache 路径（缓存不存在 → found:false）。命中 `{found:true, content: 前2000字符, truncated}`，未命中 `{found:false}`。
- 测试按 spec 范围 B 五条。

### T3 · web 预览 + 表单防重（coder）

文件：`apps/web/src/pages/BoardPage.tsx`（CreateIssueModal）、`apps/web/src/components/TaskPanel.tsx`、`apps/web/src/api.ts`、`apps/web/test/`

- api 新增 `getGuidance(repo)`。弹窗 repo 输入 400ms 防抖拉取，found 显示预览块（等宽 text-[11px] muted，前 200 字符 + "将随任务注入"，truncated 标注），repo 清空预览消失。
- 防重入：创建任务/发送/提交意见并重跑/合入 四按钮请求中 disabled。
- 评论框 Enter 提交、Shift+Enter 换行；发送失败红字且草稿保留。
- 组件测试按 spec 范围 C.5。
- 接口约定（T2 同步实现）：`GET /api/guidance?repo=...` → `{found:true, content, truncated}` | `{found:false}` | 400。

## 串行阶段

- T4 · test-craft：生成 `docs/tests/2026-08-11-guidance-forms-testcases.md` 并执行回填（我执行）
- T5 · 两段审查
- T6 · 合并推送 + PROGRESS/ROADMAP 更新（迭代项 6/7 勾掉）
- 附带：给 Anvil 仓库自身写一个 `ANVIL.md`（dogfood：改完跑 pnpm test、四包 tsc、diff 最小），随本主题入库
