# Anvil 进度文档

> 单一事实来源：当前状态、里程碑、backlog、协作约定。每次合并到 main 时更新。
> 新会话恢复上下文：先读本文件，再读 `docs/superpowers/specs/` 下的相关 spec。

**当前阶段**：一期已完成并通过手动冒烟 → 即将进入 **UI/UX 迭代主题**
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

### 🔄 进行中：UI/UX 迭代
- 方向待定（等用户参考物或我出原型）
- 计划：design tokens + 基础组件 → 逐页换皮

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
