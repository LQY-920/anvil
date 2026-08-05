# Anvil 进度文档

> 单一事实来源：当前状态、里程碑、backlog、协作约定。每次合并到 main 时更新。
> 新会话恢复上下文：先读本文件，再读 `docs/superpowers/specs/` 下的相关 spec。

**当前阶段**：一期 + 验收链路 + UI 重构（方向 C）均已完成，系统可用
**仓库**：https://github.com/LQY-920/anvil ｜ 主干：`main`

## 里程碑

### ✅ 2026-08-04 一期：编码任务调度（phase-1 分支，已合并）
- 四包 monorepo：core（协议类型）/ server（Fastify+SQLite）/ runner（daemon+Kimi adapter）/ web（React 看板）
- 60+ 测试全绿，E2E happy path 通过；spec/plan 在 `docs/superpowers/` 下
- 手动冒烟已通过：真实 Kimi CLI 完成任务并自行回调 issue → in_review

### ✅ 2026-08-04 验收链路 UX（ux-review-flow 分支，已合并）
- 看板分栏 + 页内任务面板；卡片状态带（执行中/失败/待验收）
- 交付区：diff 视图 + 合入 main（冲突自动 abort）+ 打回重跑（评论进 prompt）
- 修复：git 探测注入 PATH（server/runner 双侧）、merge 后仓库清理、面板切任务竞态

### ✅ 2026-08-05 UI/UX 重构：方向 C「工匠暖纸」（ui-redesign 分支，已合并）
- 三路调研（Linear 体系 / Multica 源码 / Agent 平台模式）→ 形成 Anvil 专属设计系统：`PRODUCT.md` + `DESIGN.md`（双主题 tokens，浅色为主）
- 原型三选一记录：`docs/ui-previews/`（A 灰阶 / B pastel / C 暖纸锻造台），选定 C + 左侧导航
- 实施：tokens.css + useTheme + 左侧导航骨架；看板（列短粗线/状态 chip/待验收淡染）；任务面板锻造台（深色常驻、类型徽章、tool 折叠）；Agents 页迁移；旧 styles.css 删除
- 修复：StrictMode 下 panel 加载死锁、视口高度链断裂、done 卡片语义

### ✅ 2026-08-05 第0波：目标契约 + 未交付追问（goal-contract 分支，已合并）
- issue 新增验收标准字段（acceptance），任务 prompt 按目标契约组装（目标/完成标准/边界/停止规则）
- 未交付信号：Agent 回调 issue-status 时写 tasks.delivered_at；任务完成未回调 → resume 追问（≤2 轮）→ 仍无交付则 complete 标 undelivered
- 新增 GET /api/daemon/tasks/:id/delivery；84 测试全绿

### 🔄 进行中：无（等下一主题）

## Backlog（各轮审查接受的债务，按优先级）

**P1（影响可靠性/安全）**
- daemon token 吊销端点 + UI（revoked_at 字段已有，无操作入口）
- worktree/分支清理策略：取消或废弃的任务目前永久残留（merge 路径已会清理）
- merge 基准分支假设"主工作区停在集成分支"：v2 在 dispatch 时把 base 存进 task 行

**P2（体验）**
- agents.status 字段从未更新（永远是 idle）——管理页该列是纯装饰，要么接真实状态要么去掉
- `runtime.updated` WS 事件已声明未实现；claim/start 不广播 task.updated（看板刷新有延迟）
- 详情页长 transcript 无虚拟化；评论无 Enter 提交、无错误反馈
- in_progress 列永远空（平台不推进 issue 状态）——考虑看板列语义调整或卡片内显式展示执行态

**P3（打磨）**
- runner 日志结构化（server 已 pino，runner 还是 console.error）
- merge 成功提示文案用 target（"已合入 main"）而非源分支名
- `pnpm dev` 一键同时拉起三端（目前要开三个终端）
- cancelled 任务的 token 仍可 POST /messages（认证面小洞）

## 协作约定

1. **一个主题一个分支**，合并进 main 并推送后更新本文件
2. 大主题：spec（`docs/superpowers/specs/`）→ plan（`docs/superpowers/plans/`）→ subagent 逐任务实现 + 两段审查
3. 小改动（bugfix、单点优化）：直接实现 + 测试，commit 说清楚为什么
4. 合并门槛：`pnpm test` 全绿 + 四包 tsc 零错误
5. 审查中"接受不修"的问题统一记到 Backlog，不散落在对话里
