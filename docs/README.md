# 文档入口与维护规则

更新时间：2026-10-10。总 PRD v0.2 及其残留 PDF 已全部移除。现在使用总任务清单与六份独立 PRD；已退役执行方案和重复产物已清理。

## 先读哪里

| 文档 | 职责 |
|---|---|
| [TASKS](TASKS.md) | 唯一任务清单：六个方向、依赖、认领和状态摘要；未来方向也加这里 |
| [COMMON](prds/COMMON.md) | 共同接口、证据和工作边界，不是第七个产品方向 |
| [六份 PRD](prds/) | 每项独立范围、需求、接口、边界、测试与验收 |
| [交接说明](handoffs/README.md)和 [模板](handoffs/TEMPLATE.md) | 谁认领、需求变化、已做/未做、测试/验收、下一步 |
| [测试用例](tests/tasks/README.md) | 用例步骤、自动化映射、实际执行结果 |
| [贡献指南](../CONTRIBUTING.md) | 共享基线、分工、开发、审查与合入 |
| [PROGRESS](PROGRESS.md) | 已有实现、历史验证、里程碑与债务 |
| [历史资料](history/README.md) | 旧调研、已实现规格及证据映射；不决定当前排序 |
| [AGENTS](../AGENTS.md) / [ANVIL](../ANVIL.md) | 开发规则 / Runner 任务纪律 |

## 六项入口

| 任务 | PRD | 交接 | 测试 |
|---|---|---|---|
| Git/GitHub | [T01](prds/T01-git-github.md) | [T01](handoffs/T01.md) | [用例](tests/tasks/T01-testcases.md) |
| Codex | [T02](prds/T02-codex-adapter.md) | [T02](handoffs/T02.md) | [用例](tests/tasks/T02-testcases.md) |
| Factory | [T03](prds/T03-factory-workflow.md) | [T03](handoffs/T03.md) | [用例](tests/tasks/T03-testcases.md) |
| 频道线程 | [T04](prds/T04-channels-threads.md) | [T04](handoffs/T04.md) | [用例](tests/tasks/T04-testcases.md) |
| 手机 | [T05](prds/T05-mobile-access.md) | [T05](handoffs/T05.md) | [用例](tests/tasks/T05-testcases.md) |
| pi/dsh | [T06](prds/T06-agent-providers.md) | [T06](handoffs/T06.md) | [用例](tests/tasks/T06-testcases.md) |

[J01](handoffs/J01-integration.md)为 T01/T02 联合验收记录，不另增产品 PRD。两项独立通过且 J01 通过后，Factory 才实施。交接记录保存状态细节，清单同次更新摘要。

## 历史材料

- [Delivery Loop v0 锁定原文](<../prd_outputs/Anvil Delivery Loop v0/anvil_delivery_loop_v0_PRD.md>)保留，SHA-256：E1BAA430ACB9ABEEFD24623A1FBF09981362722D0178FB14B3C852D877206E70。证据/权限语义继续参考，整体旧排序由 TASKS 替代。
- [历史索引](history/README.md)保存 A01–A08 到真实测试/实现的映射；旧长实施计划、MiniMax 提示与 UIUX 提案已删除。[R2 清单](tests/2026-08-28-delivery-evidence-p0a-testcases.md)和 [采集记录](tests/2026-10-06-r2-runbook.md)保留，旧 R2 未通过；H01 见 TASKS。
- PRODUCT 仅保留长期原则，DESIGN 指向当前 CSS，GUIDE 是已有 API 参考。已完成 spec/plan 集中在 history，测试失败和修复记录继续保留。
- .codex/ 是忽略提交的本机恢复辅助，协作者不需要依赖私人聊天；数据库、认证材料与本机验证产物不进入协作提交。

## 编辑源与导出

docs/prds/Txx-*.md 是六项需求的唯一编辑源。[导出目录](<../prd_outputs/Anvil Task PRDs/README.md>)保留 PDF 阅读副本及来源 hash，不再维护重复 Markdown。修改源后重新生成，禁止独立编辑副本；认领记录固定所用 PRD 版本/hash。

## 共享与维护

共同基线使用远端 main；同步和认领步骤见[贡献指南](../CONTRIBUTING.md)，合入验证见 [PROGRESS](PROGRESS.md)。认领时冻结实际 SHA，逐项提交代码、需求、公共边界、用例、交接与入口；不要 git add . 或共享数据库/认证材料/个人日志。Markdown 阅读不依赖 PDF。

新方向在 TASKS 追加 T07 起的新编号并建 PRD/交接/用例。需求改 PRD，日常进度改交接，执行结果改测试，清单只做摘要；合并里程碑再写 PROGRESS。历史记录保留日期，不改写成新成果。
