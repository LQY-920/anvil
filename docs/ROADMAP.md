# Anvil 迭代路线图（2026-08-11）

> 主题：让编码工作台更好用，贴近程序员/普通用户的使用习惯。
> 生成方式：goal 模式探索产出；证据三源——① 项目现状（docs/PROGRESS.md backlog、源码、用户真实使用卡点记录）；② docs/tests/2026-08-11-anvil-testcases.md 暴露的问题；③ 2026-08-11 联网竞品调研（Linear / Cursor / Claude Code / Codex / Devin / Multica / Vibe Kanban / Conductor / OpenHands，来源链接随条目附注）。
> 本文档只规划，不实施。每个迭代项含五要素：用户场景、痛点证据、验收标准、优先级、预估成本（小 ≤ 半天 / 中 ≈ 1-2 天 / 大 ≥ 3 天）。

## 证据摘要

> 2026-10-05 本地实施更新：当前主题为「交付证据与反馈闭环 v0」，按锁定 PRD 和 `docs/superpowers/plans/2026-08-28-delivery-evidence-feedback-loop-v0.md` 推进。A05 已修复末次追问核对，A06 Runner 基线终检与 A07 服务端原子证据落库已实现；后续为 A08 前瞻验收计时和 R2 真实 dogfood。尚未合并或发布，多 CLI 接入排在可信交付 P0 之后。本页以下保留原路线图背景，最新实绩见 `docs/PROGRESS.md`。

**源 1 · 项目现状与用户卡点**（按发生时间）：
- 新建 issue 后"似乎没有反应"——创建/入队无任何即时反馈（2026-08-05 实测）
- "我在哪里看运行结果？"——执行过程入口不直观（已通过看板内面板部分缓解）
- 合入 409 报错信息丢失、重跑后"合入"按钮消失——状态与错误呈现不透明（错误透出已在 23e75e1 修复一半）
- 看板 `in_progress` 列永远为空——平台不推进 issue 状态，看板与真实进度脱节（PROGRESS.md backlog P2）
- 其余 backlog：daemon token 吊销不断连在途 WS（P1）、worktree 残留清理（P1）、merge 基准分支假设（P1）、agents blocked/error 无写入方（P2）、长 transcript 无虚拟化（P2）、评论无 Enter 提交/无错误反馈（P2）、cancelled 任务 token 仍可 POST messages（P3）

**源 2 · 测试用例文档暴露**：
- TC-Board_004：创建按钮无防重入，快速双击会产生两条 issue（代码已确认无兜底）
- TC-Board_013 级别的实时性已有 WS 基础，但"他人/他端操作可见性"未在产品层利用

**源 3 · 竞品调研收敛点**（14+14+15 条模式，文末附关键链接）：所有成熟产品收敛到同一条主线——**派单 → 离开 → 收通知 → 看摘要+diff → 接受/打回**。支撑这条主线的四根柱子：a) 执行过程语义化（不灌原始日志）；b) 状态全自动流转（手动拖卡被视为 busywork）；c) 注意力系统（通知/snooze/活信号）；d) 验收单页闭环（聚合 diff、键盘裁决、评论直接回喂）。

## P0 迭代项（三根主线柱子）

### 1. ✅ 语义时间线：日志流升级为分层 presenter + 步骤清单（2026-08-11 完成）

- 用户场景：掌柜派活后离开，半小时后回来，面对几百行原始 CLI 输出，无法 10 秒内回答"进行到哪一步、卡没卡、该不该管"
- 痛点证据：Linear Agent 用语义 Activity 流（thought/action/elicitation/response/error + ephemeral + Plan checklist）替代原始日志（[linear.app/developers/agent-interaction](https://linear.app/developers/agent-interaction)）；Multica trace-event-presenter 五层渲染纪律（正文/错误不折叠、工具调用一行化、thinking 折叠、未知事件保底渲染不丢弃）；Devin Progress tab 可点击时间线；Codex/Claude Code 的 todo list 进度显性化。本地：PRODUCT.md 原则 3/4（可解释、折叠是信任基线）已立但只做到了"折叠"，没做到"分层语义"
- 验收标准：
  - TaskPanel 执行日志按四类渲染：agent 正文与 error 不折叠；tool_use 压缩为一行（工具名 + 关键参数 + 长路径截断 `.../parent/leaf`）；thinking/tool_result 默认折叠；未知消息类型保底渲染为通用条目
  - 面板顶部显示步骤进度（来自任务消息流统计或 agent 计划，如"工具调用 12 次 · 最近：Edit apps/web/..."）
  - presenter 为纯函数层，`apps/web` 含其 vitest 单测（7 型消息各一条 + 未知类型一条）
- 优先级: P0 | 预估成本: 中

### 2. ✅ 状态自动流转 + 看板活信号（2026-08-11 完成）

- 用户场景：任务已在跑，卡片还停在"待办"；跑完了停在原列；用户问出"重跑后合入按钮去哪了"——看板状态与真实进度脱节，且密集列表里看不出哪个任务有 agent 在跑
- 痛点证据：Linear "Git 事件驱动状态机，手动改状态是 busywork"（[github.com/marketplace/linear](https://github.com/marketplace/linear)）与 Agent Session 六态自动推导（10 秒无首条 activity 标 unresponsive）；Multica 固定位置"正在工作"chip + 卡片右上角被动活信号（hover 延迟调 900ms 的教训）。本地：`in_progress` 列永远空（backlog P2）；issue 状态完全依赖 agent 回调，agent 不回调就停尸
- 验收标准：
  - runner `start` 上报 → issue 自动进 `in_progress`；`complete` 且 result_json 含 branch → 自动进 `in_review`（agent 回调保留为补充而非唯一途径）；`failed` 终态 → 卡片显示失败（issue 状态不变，靠 chip 表达）
  - 看板卡片右上角有 agent 活动角标：running=绿点脉冲、queued=半透明灰点；无卡片处不出现
  - 状态迁移由 server 服务层函数完成，`apps/server/test` 含 start→in_progress、complete→in_review 两条集成测试；看板列语义在 UI 文案层不变
- 优先级: P0 | 预估成本: 中

### 3. ✅ 注意力闭环：三类事件的浏览器通知（2026-08-11 完成）

- 用户场景：任务进入待验收/失败/阻塞时人不在屏幕前；新建任务后"没有反应"的焦虑——需要"推"而不是"拉"
- 痛点证据：Multica Inbox severity 三级（action_required/attention/info）+ WS 定向推送；Linear Inbox Zero + snooze；Cursor cloud agent 完成推送附"Open in Cursor"。本地：用户实测"新建后似乎没有反应"、"看不到效果"；"染色即看我"原则已定义了三类需注意状态但无触达通道
- 验收标准：
  - 任务进 `in_review`（待验收）、`failed`、连续无消息超时（idle）三类事件时，web 端触发浏览器 Notification（首次使用请求授权，被拒绝则降级为看板内未读徽标）
  - 点击通知定位到对应任务面板；同一任务 10 分钟内同类事件只通知一次
  - 通知触发逻辑在 `apps/web` 有单测（mock Notification）
- 优先级: P0 | 预估成本: 小

## P1 迭代项（验收与对话通道）

### 4. 验收闭环：diff 内联评论直接回喂返工

- 用户场景：打回时要离开 diff、在输入框重写一段自然语言描述"哪个文件哪行不对"；信息在复制中损耗，agent 拿到的指令离现场远
- 痛点证据：Vibe Kanban diff 逐行评论直接回喂 agent（品类标杆）；Conductor 本地 inline review agent 会读并回应；Devin Review 页内评论/批准/合并闭环。本地：打回链路已有（评论进 prompt + session resume），只差"评论锚定到 diff 行"
- 验收标准：
  - 交付区 diff 每行可留评论（文件+行号+正文），"提交意见并重跑"时评论按 `文件:行号 内容` 格式拼进打回 prompt
  - 打回评论在 issue 时间线可见且与 rerun 任务关联可查
  - server 侧为 comments 表增加可选锚点字段（path/line），有迁移与单测
- 优先级: P1 | 预估成本: 大

### 5. ✅ 评论即指令：排队接力 + 完成后续作（2026-08-11 完成）

- 用户场景：agent 执行中，用户想起一个补充约束，只能干等或取消重跑；任务完成后想"顺便把 README 也更新了"，只能手动点重跑——原第2波计划项
- 痛点证据：Cursor 执行中排队消息 + steering（1.2/1.4 changelog）；Linear elicitation/prompt 多轮循环；Multica 评论 @agent 即派活且"为什么没触发"给精确原因码。本地：任务包已带最近 10 条 comments 进 prompt（链路半成品）
- 验收标准：
  - ~~有 running 任务则标记为"待注入"，runner 下一轮消息上报时携带~~ **技术结论（2026-08-11）**：kimi `-p` 一次性 headless、prompt 走命令行参数，无 stdin 注入通道，真·执行中注入不可行。改为**排队接力**（Cursor queue 语义）：member 评论且 assignee 为 agent 时——无活跃任务则自动入队（评论入 prompt）；有 running 任务则入队排队（同 issue 仅 queued/dispatched 受唯一索引限制，running 不挡），当前任务结束后接力执行；已有 queued/dispatched 则评论自然合并（claim 时带最近 10 条评论）
  - 触发结果被拦截时给出具体原因（assignee 非 agent / 状态不活跃 / 已合并进排队任务）
  - `apps/server/test` 含评论触发入队、原因码两条测试
- 优先级: P1 | 预估成本: 中

### 6. ✅ repo 级常驻指引（guidance）注入 prompt（2026-08-11 完成，落地为仓库根 ANVIL.md）

- 用户场景：同一仓库的规矩（"改完跑 pnpm test"、"diff 别超 500 行"）每个任务重述一遍；不说就返工
- 痛点证据：Linear workspace/team 级 guidance 自动注入 agent 上下文（[linear.app/developers/agent-best-practices](https://linear.app/developers/agent-best-practices)）。本地：第0波目标契约已有 prompt 组装点，注入成本极低
- 验收标准：
  - workspace settings 或仓库根 `ANVIL.md` 存放常驻指引，任务 prompt 组装时自动附加
  - 创建 issue 界面可预览最终注入的指引文本
  - 有单测覆盖"指引拼接进 prompt"
- 优先级: P1 | 预估成本: 小

### 7. ✅ 表单防重入与提交反馈（2026-08-11 完成）

- 用户场景：网络慢时连点"创建任务"，看板出现两条同名 issue；评论发送失败无任何提示
- 痛点证据：TC-Board_004 探针（代码确认无防重）；backlog"评论无 Enter 提交、无错误反馈"
- 验收标准：
  - 创建/发送按钮在请求进行中禁用并示 loading；Enter 提交评论（Shift+Enter 换行）；请求失败在输入框下方红字提示且不清空草稿
  - `apps/web` 组件测试覆盖双击只发一次请求
- 优先级: P1 | 预估成本: 小

## P2 迭代项（效率与可靠性打磨）

### 8. 键盘流最小集 + Cmd+K

- 用户场景：每天几十次"建任务/开任务/裁决待验收"，鼠标路径复利式浪费时间
- 痛点证据：Linear 三层键盘模型（单键编辑/双键导航/修饰键全局）+ 菜单标注快捷键即教学；Multica Cmd+K 覆盖搜索/导航/动作/最近访问
- 验收标准：`C` 新建、`Enter` 打开卡片、`Cmd/Ctrl+K` 命令面板（跳任务/新建/重跑失败任务三个动作起步）；待验收卡片数字键 1 合入 / 2 打回；快捷键在对应按钮 tooltip 标注
- 优先级: P2 | 预估成本: 中

### 9. 快速创建单行框

- 用户场景：脑子里冒出一个任务，完整弹窗六个字段太重，打断当前思路
- 痛点证据：Multica quick_create（创建即派发、完成进通知）；Linear `C` 键单行创建
- 验收标准：看板顶部单行输入"标题 + 回车"即建 issue（默认待办不指派），可 `@agent名` 语法直接指派；创建成功在收集箱/待办可见并有一次性 toast
- 优先级: P2 | 预估成本: 小

### 10. 失败文案纪律：原因码精确、拒绝可见

- 用户场景：merge 失败只知道"失败了"，不知道往哪个方向修；runner 离线被提示成别的原因
- 痛点证据：Multica blocked-trigger-copy 三码分立（invocation_not_allowed / runtime_offline / agent_runtime_required，文案刻意不互相误导）；本地 23e75e1 已透出 git stdout（做了一半）
- 验收标准：合入失败按冲突/分支丢失/推送失败/非 completed 四类文案分别指向修复动作；runner 侧六值 failure_reason 在 UI 各有中文文案与建议动作；无权操作不隐藏、点击解释原因
- 优先级: P2 | 预估成本: 小

### 11. 检查点后悔药：一键回到任务前状态

- 用户场景：合入后发现 agent 改坏了，要手工翻 git 历史找回任务前状态；对自主改动的恐惧压低委派意愿
- 痛点证据：Claude Code 检查点 rewind（[anthropic.com/news/enabling-claude-code-to-work-more-autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)）；Devin 实测"无法预知哪些任务会成功"强化可逆性价值。本地：任务分支/worktree 机制已存在，基线 ref 唾手可得
- 验收标准：任务派发时记录基线 commit 到 task 行；已合入任务的面板提供"回滚到任务前状态"按钮（生成 revert 提交或 reset 提示，二选一实现并注明）；有集成测试
- 优先级: P2 | 预估成本: 中

### 12. 可靠性清扫包（backlog 集中还债）

- 用户场景：长期无人值守运行，残留 worktree 撑爆磁盘；token 吊销后在途连接还活着
- 痛点证据：PROGRESS.md backlog P1/P3 全量（daemon token 断连、worktree 清理、merge 基准分支假设、cancelled token 小洞、agents blocked/error 无写入方、transcript 虚拟化）
- 验收标准：每子项一条：daemon token 吊销后在途 WS 断开；取消/废弃任务的 worktree 有清理策略并执行；merge 使用 task 行记录的 base；cancelled 任务 POST messages 返回 410/401；transcript 超 500 条虚拟化不卡。各配测试
- 优先级: P2 | 预估成本: 中

## 下一个迭代主题推荐（唯一）

**「任务进展可解释性」= 迭代项 1 + 2 + 3 打包。**

理由：
1. 三个证据源罕见地同指一处——你的每一次真实卡点（"没反应"、"在哪看结果"、"合入按钮消失"）都不是功能缺失，而是**进展不可见**；竞品侧 Linear/Multica/Devin/Cursor 全部把"语义化进度 + 自动状态 + 通知"作为 agent 交互的第一优先级，这是品类已验证的答案，不是猜测
2. 它是其他一切的地基：验收闭环（4）、评论转向（5）都依赖准确的状态机与可读的时间线；先做验收而状态还是错的，等于在流沙上盖楼
3. 成本可控（中+中+小 ≈ 2-3 天），且大量是纯函数 presenter 与服务层状态迁移，可测试性强，符合本项目"pnpm test 全绿才合并"的纪律

## 待用户输入

- **通知通道**：浏览器 Notification 是否够用？是否需要邮件/Server 酱等外部通道（单人场景默认不需要）？
  - 已定（2026-08-11）：先用浏览器通知，暂不需要邮件。移动端不做，手机收通知的自托管开源候选：ntfy / Gotify（仅记录候选，未深入调研，需要时单独立项）。

- **Autopilot 定时任务**：spec 划入二期。是否确认继续暂缓？（Multica 的 6 个一键模板可直接参考，若提前做需单独立项）
  - 已定（2026-08-11）：正常规划走。基础版（cron 触发自动建 issue 派 agent）可提前纳入一期后续主题；增强版（webhook/模板/并发策略）放二期。当前主题不含。

- **计划审批点**（Devin 式开工前 30 秒倒计时计划确认）：会打断"派活即走"的流畅度，是否需要作为可选项纳入迭代项 2？调研两方证据都有，倾向不做默认、只做开关——需要你拍板
  - 已定（2026-08-11，委托决定）：不做，连开关也不做。理由：任务已携带验收标准 + 常驻指引（迭代项 6）作为契约，审批点会打断"派活即走"；若真实使用中出现"方向性返工"痛点再单独立项。

- **移动场景**：是否需要手机浏览器可用的只读视图（收通知 + 批准/打回）？当前按桌面优先未排期
  - 已定（2026-08-11）：暂不考虑移动端；手机通知诉求并入上面的 ntfy / Gotify 候选。


## 明确暂缓

- Autopilot 定时调度、squads 小队、skill 注入（spec 二期，数据表已预留）
- 多 CLI provider 扩展（claude-code.ts / codex.ts adapter）：等 kimi 链路体验收敛后再加，避免同时调两条不稳定链路
- 全文搜索（Multica 有 `GET /api/issues/search`）：单用户任务量未到阈值，Cmd+K 先覆盖导航

## 关键调研来源

- Linear for Agents / Agent 交互协议：https://linear.app/agents ｜ https://linear.app/developers/agent-interaction ｜ https://linear.app/changelog/2025-05-20-linear-for-agents
- Linear 性能与键盘体系：https://performance.dev/how-is-linear-so-fast-a-technical-breakdown ｜ https://linear.app/docs/triage
- Cursor 2.0 / background agents：https://cursor.com/blog/2-0 ｜ https://cursor.com/docs/background-agent ｜ https://cursor.com/changelog/1-4
- Claude Code 自主性/检查点：https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously
- Codex 升级（to-do/review/权限三档）：https://openai.com/index/introducing-upgrades-to-codex/
- Devin 交互：https://docs.devin.ai/work-with-devin/interactive-planning ｜ .../devin-session-tools ｜ .../devin-review
- Multica 源码（本地 research/multica @ fe62be2）：trace-event-presenter、blocked-trigger-copy、issue-agent-header-chip、inbox-display
- Vibe Kanban / Conductor / OpenHands：https://github.com/BloopAI/vibe-kanban ｜ https://conductor.build/ ｜ https://docs.openhands.dev/openhands/usage/key-features
- 开源编排器九工具实测（验收自动化阶梯）：https://www.augmentcode.com/tools/open-source-agent-orchestrators
