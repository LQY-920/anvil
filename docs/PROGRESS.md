# Anvil 进度文档

> 单一事实来源：当前状态、里程碑、backlog、协作约定。每次合并到 main 时更新。
> 新会话恢复上下文：先读本文件，再读 `docs/superpowers/specs/` 下的相关 spec。

**当前阶段**：一期 + 验收链路 + UI 重构（方向 C）+ 任务进展可解释性 均已完成，系统可用
**仓库**：https://github.com/LQY-920/anvil ｜ 主干：`main`

## 里程碑

### ✅ 2026-08-11 常驻指引+表单体验（guidance-and-forms 分支，已合并）
- runner 注入 <仓库根>/ANVIL.md 到任务 prompt（8192 字符截断、读失败静默；追问轮不受影响）；server 新增 GET /api/guidance 预览端点（本地/URL 缓存、2000 字符截断、空白文件按未命中与 runner 对齐）
- web：新建弹窗指引预览（400ms 防抖）；创建/发送/合入/打回四按钮 ref 在途守卫（修复同帧双击穿透双发）；评论 Enter 提交/Shift+Enter 换行；发送失败红字且草稿保留
- dogfood：仓库根新增 ANVIL.md（本仓库任务自此自带改动纪律）
- test-craft：8/8 执行通过（页面用例抓到双击穿透缺陷，修复后复跑通过）
- 187 测试全绿 + 四包 tsc 零错

### ✅ 2026-08-11 评论即指令（comment-driven-tasks 分支，已合并）
- member 评论按守卫自动入队（trigger=comment）：无活跃任务→续作入队；running→排队接力；已有 pending→合并去重；未指派/状态不活跃→原因码（assignee_not_agent/status_inactive）随响应回传
- 技术结论：kimi -p 一次性 headless、prompt 走命令行参数，无 stdin 注入通道，真·执行中注入不可行 → 采用排队接力（ROADMAP 迭代项 5 已修订措辞）
- web：评论发送后四态提示（入队/合并/未指派/状态不活跃）；打回重跑优先接续评论触发的任务（修复：评论路由抢先入队导致 rerun 稳定 409 的回归；merged_into_pending 视同接续不再 rerun）
- test-craft：8/8 执行通过（docs/tests/2026-08-11-comment-driven-tasks-testcases.md）
- 172 测试全绿 + 四包 tsc 零错

### ✅ 2026-08-11 任务进展可解释性（progress-observability 分支，已合并）
- server 状态自动流转：start→in_progress、complete+branch→in_review（system 评论+issue.updated 广播；delivered_at 语义不变，agent 回调仍是唯一交付信号写入方）
- web 语义时间线 presenter（七型分层渲染/长路径截断/未知类型保底）+ 面板顶部进度摘要行
- 浏览器通知（待验收/终态失败，10 分钟去重）+ 降级（标题 ● 前缀 + 卡片琥珀注意点，按 issue 键控）+ ?task=<id> 定位打开面板 + 卡片活信号角标（queued 灰点/running 绿脉冲）
- 修复：input_json 双重编码（core coerceInput 源头 + presenter 双解析容错，TDD）；评审修复：注意点按 issue 键控防泄漏、已知工具缺参数键时回退 JSON 摘要
- 流程更新：协作约定加入 test-craft 测试阶段（spec→plan→实现→测试用例执行→两段审查→合并）；本主题用例 10/10 执行通过（docs/tests/2026-08-11-progress-observability-testcases.md）
- 156 测试全绿 + 四包 tsc 零错

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

### ✅ 2026-08-05 第1波：体验清扫（wave-1-polish 分支，已合并）
- pnpm dev 一键拉起三端（scripts/dev.mjs 绕开本机 PATH 缺 System32 的问题）
- daemon token 列表/吊销（端点 + Agents 页 UI）；agent.status 接真实状态（claim→working，终态→idle，含 lease sweep 回写）
- claim/start/sweep 广播 task.updated，看板秒级刷新；创建 issue 表单补验收标准字段
- 94 测试全绿

### ✅ 2026-08-05 远程仓库支持（repo-url-support 分支，已合并）
- issue 目标仓库支持本地路径或 git URL；runner repocache（~/.anvil/repos/<hash>，clone/fetch/ff/互斥/残骸自愈）
- 任务完成自动推 task/* 分支到远程；merge 合入后推目标分支并删远程任务分支；失败保留现场可重试
- 创建表单显示最近使用仓库快捷选择（settings_json.recent_repos，cap 8）
- 113 测试全绿。注意：该 feature commit 混入了用户并行做的 shadcn 风格 UI 重构（功能已核实保留）

### 🔄 进行中：交付证据与反馈闭环 v0

- 2026-10-05：本地 `delivery-evidence-loop-v0` 分支已实现 A05，本次修复末次追问遗漏交付核对；35 文件 / 712 用例、构建和四包 tsc 通过。
- A05 代码与契约自审完成；A06 Runner 独立终检已实现并完成自审：从基线读取策略、真实串行检查、超时/取消终止进程树、输出脱敏与大小限制、验证前后及 complete 前核对 HEAD/clean。
- 2026-10-05 A06 最终验证：36 文件 / 738 用例通过，`pnpm build` 和四包 `tsc --noEmit` 通过；测试记录见 `docs/tests/2026-10-05-runner-verification-testcases.md`。修复了旧脱敏测试对随机 UUID 的误判；Runner 测试并发限制为 2，保留全部断言与默认超时。
- 下一步 A07：服务端证据专表原子落库、内部一致性校验与 v2 状态派生。当前 evidence 仅随 complete 写入兼容 result_json；A08、R2 真实 dogfood 和可信合入 Gate 仍未完成。
- 尚未合并 main 或推送；本段仅记录本地进度，不代表里程碑已发布。

## Backlog（各轮审查接受的债务，按优先级）

**P1（影响可靠性/安全）**
- daemon token 吊销端点 + UI（revoked_at 字段已有，无操作入口）
- worktree/分支清理策略：取消或废弃的任务目前永久残留（merge 路径已会清理）
- merge 基准分支假设"主工作区停在集成分支"：v2 在 dispatch 时把 base 存进 task 行

**P2（体验）**
- ~~agents.status 字段从未更新~~（第1波已接真实状态；2026-08-11 核销）
- `runtime.updated` WS 事件已声明未实现
- 详情页长 transcript 无虚拟化；评论无 Enter 提交、无错误反馈
- WS 断线重连后不补拉（ws.ts），断线窗口的事件丢失会致通知漏报（2026-08-11 评审记录）
- ~~in_progress 列永远空~~（2026-08-11 状态自动流转已修，核销）

**P3（打磨）**
- runner 日志结构化（server 已 pino，runner 还是 console.error）
- merge 成功提示文案用 target（"已合入 main"）而非源分支名
- ~~`pnpm dev` 一键同时拉起三端~~（第1波 scripts/dev.mjs 已实现；2026-08-11 核销）
- cancelled 任务的 token 仍可 POST /messages（认证面小洞）
- ?task=<id> 定位打开的是同 issue 的 active 任务而非指定任务本身（2026-08-11 评审记录）

## 协作约定

1. **一个主题一个分支**，合并进 main 并推送后更新本文件
2. 大主题：spec（`docs/superpowers/specs/`）→ plan（`docs/superpowers/plans/`）→ subagent 逐任务实现 → test-craft 测试阶段（编写/更新 `docs/tests/` 用例并执行相关条目、回填结果）→ 两段审查
3. 小改动（bugfix、单点优化）：直接实现 + 测试，commit 说清楚为什么
4. 合并门槛：`pnpm test` 全绿 + 四包 tsc 零错误 + 本主题 test-craft 用例已执行并回填
5. 审查中"接受不修"的问题统一记到 Backlog，不散落在对话里
6. 迭代主题取自 `docs/ROADMAP.md`；`docs/tests/` 为用例库，需求变更走 test-craft 更新模式
