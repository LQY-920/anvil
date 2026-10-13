# Anvil 进度文档

> 本文件记录已有实现、历史里程碑、backlog 和协作约定。当前任务摘要看 [TASKS](TASKS.md)，认领及日常细节看对应交接记录；每次合并到 main 时更新本文件。
> 新会话先读总清单、对应 PRD/交接，再用本文件核对历史实绩。

**当前阶段（2026-10-13）**：共同开发基线在 `main`，包含 A01–A08、R2 采集准备、旧 v1 Git 任务启动兼容修复，以及 [六项独立任务](TASKS.md)的 PRD/交接/测试用例。T01 已经 PR #2 认领共享，S1 在实施分支验证，产品代码尚未合入；T02–T06 仍待认领。代码仍只有 Kimi adapter；T01/T02 可并行独立验收，J01 后再实施 Factory。历史 2026-10-10 基线回归为 862 用例；最新实施结果见 [T01 测试记录](tests/tasks/T01-testcases.md)。旧 R2/H01、完整六项专项及 J01 未验收。
**仓库**：https://github.com/LQY-920/anvil ｜ 主干：`main`

## 里程碑

### ✅ 2026-10-13 T01 认领共享（PR #2）

- 经仓库所有者明确授权，纯文档认领 [PR #2](https://github.com/LQY-920/anvil/pull/2) 已合入 `main@75dfde454f653376c3dac10224e44bc734ee75a0`；负责人 LQY-920。未改分支保护或协作者权限。
- 从该基线建立 `codex/t01-git-github`，S1 代码在实施分支验证；产品代码尚未合入/发布。完整进度见 [T01 交接](handoffs/T01.md)；T02 仍待认领。
- 认领 PR 不计作 Anvil 真实 GitHub 产品验收。原始 T01 PRD v1.0/hash 不变，完整 FR/12 场景、受控真实 PR、人工验收仍为完成条件。

### ✅ 2026-10-10 共同开发基线（本次基线 PR）

- 原 main `4323656` 与主题分支分离的 21 个基础代码提交、文档提交 `26b6249` 一同纳入 main；使用保留历史的总 PR 合并，旧测试绑定的 SHA 仍可追溯。
- 独立审查发现升级前排队的 v1 Git Task 被错发 v2 Start 锚点、返回 400；`144e69f` 按任务版本分流，保留旧回调与服务端校验。新增真实 Server/Git 回归先失败后通过。
- 修复后专项 4/4；全量 41 文件 / 862 用例、`pnpm build` 和四包 `tsc --noEmit` 通过。自审与两份独立 Agent 静态审查分开记录，详见[本轮验证记录](tests/2026-10-10-main-baseline-testcases.md)。
- 所有协作入口改为远端 main，认领人在自己的分支/worktree 填实际起点、需求版本和文件边界，通过认领 PR 共享。六份 PRD 内容/hash、70 条专项用例及 3 条 J01 用例状态不变；不代协作者认领。
- 2026-10-10 核对 main 所有者合入规则仍 active、管理员保留自主合入权限，协作者 yizhiyuanxs 为 write；没有改变保护或权限。旧的六个功能分支已经包含在原 main，不重复合并。
- 本次是协作基线合入；当前仍有 T01 的 Diff/Gate/旧 push 失败状态缺口，旧 R2 未通过，未发版或部署。

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
- 60+ 测试全绿，E2E happy path 通过；当时的 spec/plan 现归档在 `docs/history/` 下
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

### 交付证据与反馈闭环 v0（基础实现已纳入共同基线，历史 R2 未通过）

- 2026-10-05：本地 `delivery-evidence-loop-v0` 分支已实现 A05，本次修复末次追问遗漏交付核对；35 文件 / 712 用例、构建和四包 tsc 通过。
- A05 代码与契约自审完成；A06 Runner 独立终检已实现并完成自审：从基线读取策略、真实串行检查、超时/取消终止进程树、输出脱敏与大小限制、验证前后及 complete 前核对 HEAD/clean。
- 2026-10-05 A06 最终验证：36 文件 / 738 用例通过，`pnpm build` 和四包 `tsc --noEmit` 通过；测试记录见 `docs/tests/2026-10-05-runner-verification-testcases.md`。修复了旧脱敏测试对随机 UUID 的误判；Runner 测试并发限制为 2，保留全部断言与默认超时。
- 2026-10-05 A07 已实现并完成契约/代码自审：complete 在同一事务写入最终 Git facts、Verification Run/Checks、版本化 result_json、终态和幂等回执。服务端复核字段/大小/退出码/总状态；基线、分支或目录与 start 不符则拒绝。重复回执不重复写入或广播，五处 SQL 故障注入验证全部回滚。
- v2 只有 Report/delivered_at、完整 Git 锚点和终检记录齐全才推进 in_review；failed/not_configured 等真实证据仍可人工审查，缺报告为 incomplete，旧报告或 dirty/stale 为 integrity_blocked。完成快照不替代 B01 的实时 Git 核验与人类 Decision。
- A07 最终验证：37 文件 / 794 用例通过（新增 54 条服务端、2 条 Fake CLI E2E），`pnpm build` 和四包 `tsc --noEmit` 通过。旧 branch-only 测试显式设为 v1；Server 测试并发限制为 2，三条真实 URL Git 测试的超时调整为 15 秒，保留全部业务断言。测试记录：`docs/tests/2026-10-05-verification-complete-testcases.md`。
- 2026-10-06 A08 已实现并完成契约/代码自审：旧 UI 使用 Review Timer，隐藏/失焦/60 秒空闲暂停，刷新续计，提交等待暂停；合入/打回前保存累计测量。API 按 Task 幂等更新、拒绝未来时间/负数/非法字段；legacy UI 与 Task 版本分组正交。
- 计时失败保留原裁决、显示警告并排除样本；响应丢失由原裁决请求携带失败标记。测量表拒写时以 `result_json.review_measurement_excluded=true` 保存独立失效事实，后续基线查询同时排除该标记与 null 时间；不改原 Git/验证事实。补充 comments 路由接线与 Core DTO，无新迁移或依赖。
- A08 最终验证：40 文件 / 840 用例通过（新增 46 条），构建与四包 noEmit 通过；真实浏览器验证刷新、合入及计时 503 后的合入/打回。修复首帧点击先于计时初始化的竞态；一次测试/构建重叠导致既有 Git 超时，独立全量通过，未放宽超时或断言。记录见 `docs/tests/2026-10-06-review-timer-testcases.md`。
- 截至 2026-10-06 停在 R2：自动化与当次自审已完成，仍须收集/核对 3 个真实 v2 dogfood 和 10 个真实旧 UI 前瞻基线；清单见 `docs/tests/2026-08-28-delivery-evidence-p0a-testcases.md`。临时库浏览器测试与 Fake CLI 均不计入真实样本。R2 未放行，B01、可信合入 Gate 与多 CLI 接入尚未完成；现按 TASKS 将基础正确性与 H01 计时研究分别推进。
- 2026-10-06 R2 采集准备：增加 `pnpm --filter @anvil/server r2:inventory` 只读命令，限定采集起点和显式 Task，输出技术事实与候选计数；过滤失效/异常计时、禁止旧任务回填，始终保留人工门。21 条新增专项，全量 41 文件 / 861 用例、构建和四包 noEmit 通过。旧本地库仍为 16 条旧任务，未迁移；独立 `.anvil/r2/anvil.db` 已准备三个未指派草稿，真实 Task/测量均为 0。运行与采集说明见 `docs/tests/2026-10-06-r2-runbook.md`。R2 仍未放行。
- 上述为当时本地实施记录；基础代码已随 2026-10-10 共同基线纳入 main，仍不代表旧 R2 或完整 Delivery Loop 验收通过。

## 2026-10-10 文档清理（当时本地提交，随后纳入共同基线）

- 旧 v0.2 PDF 已删除；退役 Delivery 长计划、MiniMax 专用提示、旧 UIUX 提案、原型/截图与重复导出，清理 102 个旧文档/生成文件（不含此前移除的 v0.2 文件）。
- 8 份已完成功能的 spec/plan 与 1 份竞品调研移到 docs/history；旧锁定 Delivery 原文/hash、正式测试及失败记录保留。[历史索引](history/README.md)记录 A01–A08 的证据去向。
- CLAUDE 只引用 AGENTS；PRODUCT/DESIGN/GUIDE 精简为当前原则、样式来源与 API 参考；不再维护旧测试计数、色板和并行任务清单。
- .codex、tmp、手动验证 test 目录由 Git 忽略并留在本地；未清空运行库、认证配置、个人会话或旧测试日志。正式自动化测试和业务源码无改动。
- 按显式文件清单纳入新的任务/交接/测试文档并本地提交；不推送、创建 PR 或合入 main。校验范围为 Markdown 链接、PRD/hash/状态一致性、文件清单和 diff，未运行产品测试。

## Backlog（各轮审查接受的债务，按优先级）

### 2026-10-10 六项任务与交接文档（未实施）

- 用户要求移除总 PRD v0.2，改用 TASKS 长期维护全部方向；T01–T06 各一份 PRD、一份交接和一份测试用例。旧 v0.2 源文件、Markdown 导出及清单已移除；旧 PDF 在后续清理中成功删除，不再作为需求依据。锁定 Delivery Loop 原文保留。
- 所有任务待认领；此前所有者 T01、协作者 T02 是意向，未代填正式负责人。交接记录跟踪需求版本/hash、已做/未做、用例、实际测试、审查验收及下一步。
- 两项独立验收与 J01 联合验收分离；H01 计时研究单独跟踪，不阻止 Git/执行器基础正确性。旧 R2 未追认通过。
- 本轮仅文档整理及文档校验；新增用例是待执行初稿，不是已完成自动化。共享基线仍需后续确认，未操作远端。

### 2026-10-08 协作交接（历史检查点，排序已被 TASKS 替代）

- GitHub 已返回新协作者 write 权限，main 更新限制规则已启用；所有者仍负责审核和合入。本轮未修改远端权限。
- 远端 main 为 `4323656`，当前主题分支尚未推送；锁定 PRD、当前计划、AGENTS 等仍需逐项纳入共享清单，不能只共享代码。
- 本轮新增产品总览、贡献指南、文档地图，并修正已确认的旧文档冲突；锁定 PRD 原文/hash 和 R1–R5 门槛不变。多 CLI 提前到 P1 之前仍是待确认提案。
- 本轮仅核对文档、链接和事实，不重新宣称运行了 861 条测试；最近完整验证仍为 2026-10-06。
- R2 的 README 修正与 Backlog 核销草稿和本次文档改动重叠，派发前须复核/替换真实目标。本次直接整理不产生真实 Agent Task 或人工验收测量。

### 2026-10-08 新需求评估（历史记录；v0.2 于 10-10 移除）

- 当时用户确认不再使用 Kimi；先接 Codex，再接 Factory 真实任务、Anvil 内部频道/线程/@Agent、手机，最后 pi 与 DeepSeek Harness（dsh）。当时的 PRD v0.2 现已移除，当前范围入口改为 TASKS 与六份独立 PRD；本段仅保留历史。
- 静态核对 GitHub 当前仅 Git clone/fetch/worktree/push，无 Issue/PR/API 集成；Factory 提供流程契约，Console 提供只读聚合，不直接合并执行脚本或第二套面板。
- 本机仅执行 Codex 版本/帮助探测（0.147.0），未验证登录/额度，未运行真实 Agent；Factory 两项目只读，未执行脚本，未改运行库。
- 旧 R2 未放行。新 PRD 明确 Codex 前置及剩余真实样本/决策页门槛迁移，技术实施前细化，不把文档整理当作验收。
- 文档交付：PRD v0.2 共 15 节，附 14 页 PDF 阅读副本；交叉审阅修正旧布局计时接入、旧/新样本计数、base_advanced 与旧 FR 范围。文档链接、diff、旧 PRD hash 已检查，未运行产品测试或提交/推送。

**T01 前置缺口（2026-10-08 静态确认，原 M2；尚未修复）**

- `services/review.ts` 页面 Diff 用浮动分支/merge-base，未使用 v2 固定 base/head；仅 Runner Diff 统计已固定。此前“固定 Diff 已实现”的笼统表述已校正。
- URL 合入 push 失败仍 markDone 后返回 409，且旧路径未接 v2 Gate；GitHub 模式须封住旧直推目标分支入口，失败不能 done。
- repo cache 的 ff-only 失败只告警，需确认远端目标基线，不能默认缓存 HEAD 与远端一致。

**P1（影响可靠性/安全）**
- ~~daemon token 吊销端点 + UI~~（`routes/meta.ts` 与 `AgentsPage.tsx` 已实现；2026-10-08 核销旧描述）。吊销后已建立的 daemon WS 是否及时断连仍需单独验证。
- worktree/分支清理策略：取消或废弃的任务目前永久残留（merge 路径已会清理）
- 合入时目标分支/基线实时校验进入 T01；v2 start 锚点与 Runner Diff 统计已固定，页面 Diff 和实时 Gate 仍未完成。

**P2（体验）**
- ~~agents.status 字段从未更新~~（第1波已接真实状态；2026-08-11 核销）
- `runtime.updated` WS 事件已声明未实现
- 详情页长 transcript 无虚拟化；~~评论无 Enter 提交、无错误反馈~~（`TaskPanel.tsx` 已实现 Enter/Shift+Enter、错误提示与草稿保留；2026-10-08 核销）
- WS 断线重连后不补拉（ws.ts），断线窗口的事件丢失会致通知漏报（2026-08-11 评审记录）
- ~~in_progress 列永远空~~（2026-08-11 状态自动流转已修，核销）

**P3（打磨）**
- runner 日志结构化（server 已 pino，runner 还是 console.error）
- merge 成功提示文案用 target（"已合入 main"）而非源分支名
- ~~`pnpm dev` 一键同时拉起三端~~（第1波 scripts/dev.mjs 已实现；2026-08-11 核销）
- cancelled 任务的 token 仍可 POST /messages（认证面小洞）
- ?task=<id> 定位打开的是同 issue 的 active 任务而非指定任务本身（2026-08-11 评审记录）

## 协作约定

1. **一个主题一个分支和独立工作树**，先在对应交接记录认领；工作段结束同步交接与 TASKS，合并进 main 并推送后更新本文件
2. 大主题：认领独立 PRD → 需求评审 → 技术拆分（从交接记录链接）→ 实现 → 专项用例与产品验证 → 自审和独立审查；历史目录不作为新计划入口
3. 小改动（bugfix、单点优化）：直接实现 + 测试，commit 说清楚为什么
4. 合并门槛：`pnpm test` 全绿 + 四包 tsc 零错误 + 本主题 test-craft 用例已执行并回填
5. 审查中"接受不修"的问题统一记到 Backlog，不散落在对话里
6. 迭代主题取自 `docs/TASKS.md`，细节进度在交接记录；需求和用例变更按对应 PRD 版本记录，历史调研转至 `docs/history/`
