# 六项 PRD 的公共边界

版本：1.0.1；日期：2026-10-10（仅更新历史资料路径，行为契约未变）。本文是跨任务接口与证据约束，配合 [总任务清单](../TASKS.md)使用，不是第七份产品 PRD。

## 1. 已有基础与部署边界

Anvil 使用 pnpm workspace：Core 类型/协议、Fastify + SQLite Server、本机 Runner、React Web。当前只有 Kimi adapter；Codex、GitHub Issue/PR、Factory、频道线程、移动认证与 pi/dsh 均未完成。六份 PRD 的接口/数据模型均为拟议，不是可直接调用的现有 API。

现有 A01–A08 提供 v2 固定 Git 锚点、Agent Report、Runner 独立验证、原子完成与幂等回执。历史 v1 保持可读，不制造 v2 证据。当前单机单用户、loopback、人类 API/WS 未鉴权；T05 之前不将服务直接开放到局域网或公网。

## 2. 两条并行工作的接口边界

| 边界 | T01 Git/GitHub | T02 Codex adapter |
|---|---|---|
| 输入 | 仓库身份、任务 worktree、目标分支、base、执行上下文 | 消费准备好的目录、prompt、Profile/版本、会话引用、超时/取消信号 |
| 执行 | Runner 统一调度和生命周期；平台决定 Git/验证行为 | 启动 CLI、映射事件、恢复、终止、返回执行结果 |
| 输出 | Git facts、独立 Verification、Diff、PR 与远端状态 | 规范消息、真实退出/错误/取消状态、显式 session ID、Agent Report |
| 权威结果 | Server/Runner 确认 Git 与实测，人类裁决，GitHub 确认远端合入 | CLI 完成不能设置 done，Agent 自述不能写 Runner Verification |
| 文件范围建议 | worktree/repocache、server Git/review/GitHub、对应页面 | agents/probe/config/process、Provider 选择 UI、对应测试 |
| 共同修改 | Core、executor、迁移和公共 UI 类型：先接口补丁、后实现 | 不同时对同一文件大改；认领时填写一位整合人 |

Adapter 不自行创建/切换工作树、选择目标分支、push/merge 或降低验证策略。T01 不解析 Codex 私有输出。配置/会话契约由 T02 提案，Git/远端契约由 T01 提案，双方在交接记录确认版本后使用。

## 3. 最小共同契约

- 任务输入绑定 Issue/Task、Repository 或本地仓库身份、Profile 快照、work_dir、任务/目标分支、base_commit、prompt 和明确会话引用。
- session_ref 必须关联 Provider、Runtime、仓库身份和 Task/工作树；不能跨 Provider 使用，也不能调用全局 resume-last 替代明确 ID。
- Backend 结果保留成功退出、非零退出、协议错误、超时、取消等原始执行事实；持久化 Task 沿用现有状态枚举，以状态加原因码映射，具体映射在共享 Core 契约中冻结。不能把成功退出、交付、验证通过、人工批准、远端合入合并成一个 success。
- Report 绑定任务与最终提交，是 Agent 说明；Verification 由 Runner 在固定基线策略下执行并绑定 SHA。Report 转交通路改变必须显式记录身份与 schema，不扩大 Agent 权限。
- GitDiff/批准使用固定完整 SHA；目标前进记录 base_advanced/完整性阻塞，保留历史验证记录。任务 HEAD 变化需重新确认对应证据。
- daemon token 与 task token 分开，daemon token 不传给子 Agent。GitHub 高权限连接凭据不通过 Agent env/prompt 暴露；错误日志、PR、导出必须脱敏。
- 输出有大小上限，事件有 seq，命令有幂等键。未知结果先查询，不以重试制造第二次 PR/执行。

## 4. 公共测试与联合验收

T01 可以用 fake backend 与真实 Git 测试独立开发；T02 可以在本地测试仓库独立执行 Codex，不依赖 GitHub 产品集成。两项各自通过后在 [J01](../handoffs/J01-integration.md)组合验证真实 Issue、Codex、证据、PR、人工动作和远端同步。T03 才在这个可用闭环上增加 Factory 阶段。

各 PRD 的基础验收不要求先完成 H01 效率研究。仍必须保留已存在的测量数据与排除语义；未来更换完整决策布局和比较效率另立任务。不把旧 R2/R4 的未通过状态重写为通过。

## 5. 需求和进度的唯一落点

| 内容 | 维护位置 |
|---|---|
| 有哪些任务、当前排序、状态摘要 | docs/TASKS.md |
| 单项为什么做、范围/接口/验收 | docs/prds/Txx-*.md |
| 谁认领、当前进度、需求变化、已做/未做、风险与下一步 | docs/handoffs/Txx.md |
| 用例步骤、自动化覆盖、运行结果 | docs/tests/tasks/Txx-testcases.md |
| 已合并里程碑、历史审查债务 | docs/PROGRESS.md |
| 旧竞品调研和实现依据 | docs/history/README.md（历史参考，不另设任务清单） |

交接文件是细节状态的权威记录；清单是它的摘要，两者在同一次更新中保持一致。PRD 不复制日常完成百分比；测试文件保存运行事实，交接只链接并摘要。

## 6. 版本、认领和并行纪律

每项独立版本，从 1.0 初稿开始。新增或变更可观察行为/验收提升次版本；纯文字修正提升补丁版本。改版写变更项、影响用例、决策状态；初稿可先认领并进入需求评审，行为未定前不据此宣称验收完成。

每任务一个负责人、一条开发分支、独立 worktree；可以让 AI 执行，但需记录具体实施者。公共 Core、executor 与迁移同时只有一个整合负责人，接口更新先同步依赖方。开始先检查 git status，不批量提交用户资产，不复制 .env、运行库、token、CLI 登录配置。

独立审查由未承担该项实现的人完成；自审单列。认领、交接或内部验收不自动授权外部消息、推送、PR、合入、tag 或部署；实际操作沿用用户与仓库授权规则。

产品代码按项目门槛串行执行 pnpm test、pnpm build、四包 noEmit；专项检查先跑。文档变更检查链接、引用、状态一致性和 diff；不为本轮文档整理冒用历史 861 条测试。
