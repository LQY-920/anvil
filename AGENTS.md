# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

协作者入门先读 `docs/TASKS.md`、`docs/prds/COMMON.md`、`CONTRIBUTING.md`。2026-10-10 按用户要求移除总 PRD v0.2，改为六项独立 PRD、测试用例和交接记录；认领与细节进度在 `docs/handoffs/`。T01 Git/GitHub 与 T02 Codex 可并行独立验收，J01 联合验收后再进入 T03 Factory；后续方向看总清单，不按旧 M1/M2 排序。2026-10-13 T01 已由 LQY-920 通过 PR #2 认领，S1 草稿 PR #3 验证通过但未合并，完整 T01 尚未完成；T02–T06 待认领。旧 Delivery Loop 的证据/权限语义保留，旧 R2 未通过；H01 计时研究单独跟踪。自审与独立审查分开记录，历史实绩在 `docs/PROGRESS.md`。

## 项目性质

Anvil 是自建的个人 AI Agent 工作台。目标定位是 GitHub 编码协作空间 + 本机 CLI 执行；当前实现仍是 web 看板建 issue → server task → 本机 runner/worktree → Kimi CLI → 消息流与旧版验收。Codex、GitHub Issue/PR 集成、频道/线程和手机访问尚未实现。当前单机单用户，server 绑 `127.0.0.1`，无用户认证（只有 daemon/task token）；不得将其直接暴露为移动服务。

代码注释、UI 文案、提交信息、文档均用中文。

## Codex 技能约束

- 本项目禁用所有 `superpowers:*` 技能，不自动读取或调用它们；即使技能自身声明为必用，也视为不适用于本项目。
- 只有用户在当前请求中明确点名某个 `superpowers:*` 技能时，才允许为该次请求启用。
- 历史规格与计划已集中在 `docs/history/`，只作追溯，不表示需要使用任何同名技能或旧工作流。

## 常用命令

```bash
pnpm install

pnpm dev              # scripts/dev.mjs 用 concurrently 同拉 server+web+runner
pnpm dev:server       # 127.0.0.1:3100，SQLite 文件 anvil.db（ANVIL_DB / ANVIL_PORT 可覆盖）
pnpm dev:web          # 127.0.0.1:5173，/api 与 /ws 代理到 3100
pnpm dev:runner       # 需先 export ANVIL_DAEMON_TOKEN=anv_xxx（web 的 Agents 页生成）

pnpm test             # 全量（pnpm -r test；数量和结果以实际执行及 PROGRESS 为准）
pnpm build            # 四包 tsc + Web 生产构建
```

单包 / 单文件 / 单条测试：

```bash
pnpm --filter @anvil/server test                          # 单包
pnpm --filter @anvil/server test test/claim.test.ts       # 单文件
pnpm --filter @anvil/web test -t "renders issue"          # 按用例名（web 需 jsdom，已在 script 里带上）
```

**合并门槛**（见 `ANVIL.md`，runner 会把它注入到本仓库任务的 prompt）：`pnpm test` 全绿 + 四包 tsc 零错，四包各自执行：

```bash
cd packages/core && pnpm exec tsc --noEmit -p tsconfig.json   # apps/server、apps/runner、apps/web 同样
```

`apps/web` 的 tsconfig 只 include `src`，web 测试文件不进 tsc 覆盖；server/runner 的 include 含 `test`。

DB 迁移改了 `apps/server/src/db/schema.ts` 后：`pnpm --filter @anvil/server db:generate`（drizzle-kit），迁移 SQL 落在 `apps/server/drizzle/`，`buildApp` 启动时自动 `migrate`。

## 架构

pnpm workspace，四包：

| 包 | 职责 |
|---|---|
| `packages/core` (`@anvil/core`) | 唯一协议来源：模型与状态枚举（`models.ts`）、CLI 输出行解析（`messages.ts`）、REST/WS 契约（`protocol.ts`）、仓库引用与缓存路径（`reporef.ts`） |
| `apps/server` (`@anvil/server`) | Fastify 5 + better-sqlite3 + drizzle。REST + WS 广播 + 调度决策（认领、租约、重试、状态流转） |
| `apps/runner` (`@anvil/runner`) | 本机 daemon：轮询认领 → 备工作区 → spawn Kimi CLI → 流式上报 → 回调结果 |
| `apps/web` (`@anvil/web`) | React 18 + Vite + Tailwind v4 + shadcn 风格组件，看板 + 任务面板 + Agents 页 |

### 派活到验收的数据流

1. web `POST /api/issues`（或 PATCH 改指派/状态、`/rerun`、评论）→ `services/issues.ts` 的 `enqueueForIssue` / `enqueueForComment` 判定守卫后插入 `queued` task。
2. server 通过 `Hub.hintDaemons` 发 `task.available` 轻提示；runner 收到就立刻多轮询一次（丢了无害，`pollMs` 10s 兜底）。
3. runner `POST /api/daemon/claim` → `claimTasks` 原子认领并下发 **TaskPackage**（task + issue + prior_work_dir + 一次性 task_token + 最近 10 条评论）。
4. runner `prepareWorkdir` 建 worktree → `startTask` → `backend.execute` spawn CLI → `MessageUploader` 每 500ms 批量上报消息 → `complete` / `fail`。
5. v2 Agent 提交绑定 HEAD 的 Delivery Report；Runner 终检后由 server 按材料完整性推进人工审查。v1 保留 `issue-status` 回调兼容；v2 Agent 不能自行写 `in_review` 或 `done`。
6. web 从 `/api/tasks/:id/diff` 看 diff，`POST /api/tasks/:id/merge` 合入（`services/review.ts`）。

### 必须知道的不变量

- **两种 token，两套 preHandler**（`lib/auth.ts`）：daemon token（`anv_`，库里存 sha256，可吊销）走 `makeDaemonAuth` 并给 request 挂 `workspaceId`；task token（`atk_`，认领时生成、终态清空）走 `makeTaskAuth`。runner 给子进程只注入 task token，`ANVIL_DAEMON_TOKEN` 被显式剔除，且 `redact()` 会把两者从消息流里抹掉。
- **同 issue 最多一个 pending task**：靠部分唯一索引 `tasks_one_pending_per_issue`（`status IN ('queued','dispatched')`）。`insertQueuedTask` 捕获这个 UNIQUE 错误返回 `null` 表示"已合并进排队任务"——不要把它当异常。running 不受索引限制，所以「评论即指令」是排队接力：当前任务跑完，下一个接上。
- **进程结束 ≠ 交付**：v1 的 `delivered_at` 来自 `issue-status`，v2 来自成功提交 Delivery Report。runner 对缺报告或报告与当前 HEAD 不一致最多追问 2 轮；最后一轮结束仍须核对，不能把进程成功当成交付成功。
- **状态自动流转**（`autoAdvanceIssue`）：`start` 且 issue 是 `todo` → `in_progress`；v1 complete 保留 branch 兜底，v2 complete 要求 Report/delivered、Git facts 与 Run 等材料齐全才进入 `in_review`。验证失败仍可人工审查；`in_review` 和完成时 Packet 快照都不等于安全合入，B 阶段实时 Gate 尚待实现。`blocked`/`done` 不抢。
- **租约**：认领即写 `lease_expires_at`（`LEASE_MS` 2 分钟），`app.ts` 里 30s 定时 sweep 过期租约（未满 attempt → 回 `queued`，已满 → `failed/lease_expired`）并同步 `agents.status`。runner 只在 start/complete/fail 时推进，不续租——所以任务执行期间靠的是 `status='running'` 不在 sweep 范围内。
- **认领是"逐个 UPDATE 判赢"**：`claimTasks` 用 `UPDATE ... WHERE id=? AND status='queued'` 的 `changes===1` 当锁，等价 `FOR UPDATE SKIP LOCKED`。这类需要精确 SQL 的地方（部分索引、原子更新、聚合）直接用 `db.$client.prepare()`；简单 CRUD 用 drizzle。两种写法在服务层共存是有意的。
- **Hub 两个池**：`broadcast` 给 web（`issue.updated` / `task.updated` / `task.message`），`hintDaemons` 给 runner。`runtime.updated` 在类型里声明了但没有发送方。
- **消息 seq 严格连续**：`appendTaskMessages` 要求 `items[0].seq === last_seq+1`，否则 409 带 `last_seq`；uploader 收到 409 按 `last_seq` 裁掉重发。

### runner 侧细节

- 工作区（`worktree.ts`）：`repo_path` 是本地路径 → 直接 `git worktree add -b task/<short8>`；是 URL（`isRepoUrl`：http(s)/file/git@）→ 先 `ensureRepoCache` 落到 `~/.anvil/repos/<sha1前12位>`（clone/fetch/ff、per-URL 互斥、残骸自愈）再从缓存建 worktree；无 repo_path → 普通空目录。`prior_work_dir` 存在则复用并 `resume`（`kimi -c`），此时会 `rev-parse` 读回分支名，否则 `result_json` 丢分支、验收区不显示。
- prompt 组装（`executor.ts`）：目标契约四段（目标 / 完成标准 / 平台回调 / 边界与停止规则）+ 最近评论 + 仓库根 `ANVIL.md` 常驻指引（8192 字符截断）。改 prompt 结构要同步 `apps/runner/test` 里的断言。
- Agent adapter 只有 kimi（`agents/kimi.ts`：`kimi -p <prompt> --output-format stream-json`，resume 加 `-c`）。加新 provider 就是实现 `AgentBackend`；测试用 `src/testing/fake-cli.mjs` 或直接注入假 backend。
- daemon 主循环纪律（`poller.ts`）：任何单任务/单轮异常都被 `withGuard` 吞掉并打日志，daemon 绝不退出；`executeTask` 内部把所有异常收敛成 `fail` 上报，绝不外抛。
- Windows 适配是刻意的，别"清理"掉：`ensureGitAvailable` 在 PATH 找不到 git 时探测已知安装路径并注入 `process.env.PATH`（server 侧 `lib/git.ts` 同样）；`killProcessTree` 用 `SystemRoot` 拼 taskkill 绝对路径；`scripts/dev.mjs` 进程内补 System32。

### web 侧约定

- 导入用显式 `.js` 后缀（`../api.js`），`@/` 别名指向 `src/`（vite + tsconfig paths 都配了）。
- `api.ts` 里无 body 的 POST **不能**带 `content-type: application/json`；server 侧也定制了容忍空 body 的 JSON parser（`app.ts`）。两处配对，改一边会 400。
- 状态中文文案唯一来源是 `labels.ts`；日志流渲染逻辑抽成纯函数 `lib/trace-presenter.ts`（有独立单测），组件只负责布局。
- 通知判定同样是纯函数 `lib/notify.ts`（`shouldNotify` + 10 分钟去重），降级路径是 `document.title` 加 `●` 前缀 + 卡片琥珀角标。
- 组件测试统一 `vi.mock("../src/api.js", ...)` + `vi.mock("../src/ws.js")`，用 MemoryRouter 包裹。
- 样式：`globals.css`（Tailwind v4 入口 + shadcn Zinc 变量 + `@layer theme, base, legacy, components, utilities`）→ `tokens.css`（Anvil 语义 token）→ `base.css`（旧元素选择器，置于 `legacy` 层，保证 Tailwind 工具类始终覆盖）。主题走 `<html data-theme="light|dark">`（`hooks/useTheme.ts`）。不硬编码色值。
- **样式依据**：当前使用 Zinc 中性色与语义 token；`DESIGN.md` 只记录当前样式来源和约定，不维护另一套色值。旧暖纸方案/UIUX 提案/原型已清理，改 UI 以实际 CSS 为准；仍使用的 `--forge-*` 变量不要因名字旧就删除。

## 协作流程（`docs/PROGRESS.md` 定义，请遵守）

1. **一个主题一个分支**，合并进 main 并推送后更新 `docs/PROGRESS.md`。
2. 大主题：认领独立 PRD → 需求评审 → 在对应交接记录链接技术拆分/设计 → 逐任务实现 → 在 `docs/tests/tasks/` 更新用例并执行、回填结果 → 自审与独立审查。历史目录不作为新计划落点。
3. 小改动（bugfix、单点优化）：直接实现 + 测试，commit 说清楚**为什么**。
4. 审查中"接受不修"的问题一律记进 `docs/PROGRESS.md` 的 Backlog，不散落在对话里。
5. 迭代主题及排序取自 `docs/TASKS.md`；按对应独立 PRD 实施，每个工作段同步 `docs/handoffs/Txx.md` 与清单摘要。历史调研和证据映射在 `docs/history/README.md`。

## 文档地图

- `ANVIL.md` — 仓库常驻指引，runner 自动注入本仓库任务的 prompt（改动纪律的单一来源）
- `docs/TASKS.md` — 唯一总任务清单：方向、依赖、认领与状态摘要
- `docs/prds/` — 六份独立需求及公共接口/证据边界
- `docs/handoffs/` — 负责人、需求变更、已做/未做、测试、验收、下一步
- `docs/tests/tasks/` — 每项用例、自动化映射和真实执行结果
- `docs/PROGRESS.md` — 已有实现 / 历史里程碑 / Backlog / 协作约定
- `docs/GUIDE.md` — 已实现功能清单 + API 一览
- `docs/history/README.md` — 已实现规格、早期调研、A01–A08 证据映射；不指挥当前排序
- `PRODUCT.md` / `DESIGN.md` — 长期产品原则 / 当前样式来源与交互约定
- `research/multica/` 是 gitignored 的竞品源码参考，**不可继承其代码**（Anvil 是 MIT 独立实现，商业授权是它存在的理由）
