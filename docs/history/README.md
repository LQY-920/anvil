# 历史资料索引

2026-10-10 清理后，当前工作入口只有 [TASKS](../TASKS.md)、六份独立 PRD 和各自交接记录。本目录保存背景与已完成功能的规格，不给当前任务排序，也不意味着启用同名技能。

## 保留的依据

- [早期竞品调研](2026-08-research.md)：原 ROADMAP 的研究资料。文中的“当前”“下一步”、成本和排序均指当时，不是现在的指令。
- [历史规格](specs/)与[历史实现计划](plans/)：一期调度、评论接力、常驻指引、进展可解释性的原始设计，当前状态看 PROGRESS/源码。
- [Delivery Loop v0 锁定原文](<../../prd_outputs/Anvil Delivery Loop v0/anvil_delivery_loop_v0_PRD.md>)：保留证据与权限语义，SHA-256 为 E1BAA430ACB9ABEEFD24623A1FBF09981362722D0178FB14B3C852D877206E70。当前排期由 TASKS 替代，旧 R2 未通过。相邻 CSS 仅用于原文格式元数据。
- [历史测试记录](../tests/)：保留真实执行、失败/修复和未验收事实，不因清理重新标为通过。

## A01–A08 的实现证据

| 范围 | 保留的证据 |
|---|---|
| A01–A04 协议、迁移、事务、Git 锚点 | [PROGRESS](../PROGRESS.md)及[阶段清单](../tests/2026-08-28-delivery-evidence-p0a-testcases.md)，并以已提交源码/测试为准 |
| A05 报告与最后一轮追问 | [2026-10-05 追问测试](../tests/2026-10-05-delivery-followup-testcases.md) |
| A06 Runner 独立终检 | [2026-10-05 终检测试](../tests/2026-10-05-runner-verification-testcases.md) |
| A07 原子完成与证据落库 | [2026-10-05 完成测试](../tests/2026-10-05-verification-complete-testcases.md) |
| A08 旧 UI 计时 | [2026-10-06 计时测试](../tests/2026-10-06-review-timer-testcases.md) |
| R2 采集准备，未通过 | [2026-10-06 采集记录](../tests/2026-10-06-r2-runbook.md)；不是当前 Kimi 开工要求 |

## 本轮移除与收敛

移除总 PRD v0.2 残留 PDF、失效的 Delivery Loop 长实施计划、MiniMax 专用执行提示、已完成的 UIUX 重构提案、旧视觉原型/截图、旧 PDF 阅读副本与临时渲染图。新 PRD 的重复 Markdown 导出也删除，唯一编辑源仍在 docs/prds；六份新 PDF 阅读副本保留。

旧计划的迁移编号、实现者分工、停止点和具体锁方案不继续指挥新任务；T01/T02 在需求评审中冻结新契约。CLAUDE 缩为 AGENTS 入口，PRODUCT/DESIGN/GUIDE 收敛为当前原则、样式约定和 API 索引。

本机 .codex、tmp、手动验证 test 目录与既有运行数据留在本地并由 Git 忽略；没有清空数据库、凭据、个人会话或运行证据。历史源码和正式自动化测试未删除。
