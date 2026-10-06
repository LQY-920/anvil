# P0-A 证据层 R2 审查与真实使用清单

> 计划指定的 R2 文档；本次检查日期为 2026-10-06。
> 来源：锁定 PRD FR-001/FR-002/FR-003 telemetry/FR-005 baseline；实施计划 A04–A08、R2。
> PRD SHA-256：E1BAA430ACB9ABEEFD24623A1FBF09981362722D0178FB14B3C852D877206E70。
> **当前结论：R2 尚未通过。** 自动化证据不能代替 3 个真实 v2 Task 与 10 条旧 UI 前瞻判断记录，禁止据此进入 B01。

## 自动化用例与证据

| 编号 | 检查点 | 自动化来源 | 结果 |
|---|---|---|---|
| TC-P0A_001 | task token 不可 complete，daemon 必须拥有绑定 runtime/workspace | server daemon-operations、verification-complete | 通过 |
| TC-P0A_002 | Git base/branch 不可漂移，Resume 仓库身份与非空锚点 | runner executor/worktree/repocache；server transaction-anchors | 通过 |
| TC-P0A_003 | Report 绑定最终 HEAD；末次追问结束仍核对交付 | server delivery-report；runner executor | 通过 |
| TC-P0A_004 | 基线读取策略，Agent 修改策略不弱化本次验证 | runner verification | 通过 |
| TC-P0A_005 | timeout/取消终止进程，dirty/stale 不显示通过 | runner verification/process/executor；server verification-complete | 通过 |
| TC-P0A_006 | v1 与无 Git v2 兼容，不制造证据 | server auto-advance、verification-complete；runner e2e | 通过 |
| TC-P0A_007 | 幂等重放无重复副作用，SQL 故障完整回滚 | server daemon-operations、transaction-anchors、verification-complete | 通过 |
| TC-P0A_008 | Fake CLI 提交 Report，真实命令 exit(0)/exit(7) 决定存储结论 | runner e2e | 通过；不计入真实 dogfood |
| TC-P0A_009 | Review Timer 暂停/恢复/刷新/首帧/重复点击，保存失败不吞原裁决 | web review-timer/task-panel/review-measurement-api；server review-measurements | 通过 |
| TC-P0A_010 | 真实浏览器刷新后合入、计时 503 后合入与打回 | 隔离 preview 与真实临时 Git；A08 测试文档 005–007 | 通过；不计入真实基线 |

自动化入口：`pnpm test`、`pnpm build`，四包分别运行 `pnpm exec tsc --noEmit -p tsconfig.json`。每项的独立 fixture、步骤和断言见对应测试源，以及：

- `docs/tests/2026-10-05-delivery-followup-testcases.md`
- `docs/tests/2026-10-05-runner-verification-testcases.md`
- `docs/tests/2026-10-05-verification-complete-testcases.md`
- `docs/tests/2026-10-06-review-timer-testcases.md`

最终执行：40 文件 / 840 用例通过（core 161、server 390、runner 210、web 79），构建、四包 noEmit 和 diff 检查通过。最终日志 `tmp/codex-a08-tests-isolated.log`；较早一轮与构建重叠出现两个既有 Git 超时，已记录在 A08 文档，未改超时掩盖。

## 证据链与代码自审

- daemon/task token 边界、runtime ownership、幂等回执路径保留；measurement 属于现有单机单用户的人工 API，不新增认证模型。
- Task 的 base 在 start 固化；Runner 读基线策略，Report 与最终 HEAD 分别验证，complete 的任务事实、Run/Checks 与回执同事务保存。测试失败不会被 Agent 文案覆盖。
- v2 delivered_at 仍由 Report 写入；in_review 只表示可以由人审查，当前 ready 为完成快照，B01 仍需实时 Git 和 Decision/合入 Gate。
- A08 计时使用 performance.now 累计、Date 表达开始时刻；未聚焦/隐藏/空闲暂停，提交等待暂停，刷新只恢复已保存的累计量。
- UI 只加计时失败警告，未实现新决策页或指标 UI。新 DTO 在 Core；comments 路由额外接收计时失败 Task 标记，以覆盖打回续作。
- null 测量与 result_json.review_measurement_excluded=true 都是失效依据；后者防止测量表故障阻断裁决或使旧行被误用。原 Task Git/verification 事实不变。
- 同一工作树继续既有主题分支，没有合并、推送或发布。以上为 Codex 自审，不能称为独立 reviewer 的复审。

## 真实 v2 dogfood 待执行

选择三个确实需要完成的工作任务，通过 Anvil 的真实已安装 Agent 完成，不用 Fake CLI 替代。逐项记录：

| 样本 | Task ID | 实际需求及产物 | base/head/report/verification SHA | 策略 hash、命令及退出码 | 结论 |
|---|---|---|---|---|---|
| 1 | 待采集 | 待采集 | 待核对 | 待核对 | 未执行 |
| 2 | 待采集 | 待采集 | 待核对 | 待核对 | 未执行 |
| 3 | 待采集 | 待采集 | 待核对 | 待核对 | 未执行 |

核对要求：基线未被任务改写；报告/最终 HEAD/验证 SHA 的关系与存储状态一致；检查退出码来自真实执行。错误 passed、token 越权、证据错绑或 daemon 退出均为 No-go，不可用增加样本数覆盖。

## 旧 UI 前瞻基线待采集

- 更新后的旧 TaskPanel 在交付区就绪时开始计时，执行日志算已打开；点击完整 Diff 才记 opened_full_diff。
- 用同一浏览器配置完成十个真实任务的判断；实际点击合入或提交打回意见前保存本次测量。样本按 ui_version=legacy 分组，与 Task v1/v2 正交。
- 不回填旧 Task 的历史页面活动；不把自动化点击、预览数据或 Fake CLI 测试当作真实用户判断。
- 计时保存失败的任务继续执行原裁决并显示警告，但不纳入十条有效样本；保持原记录可追溯，不补造时长。
- 当前真实有效样本：**尚未采集确认**。不要从 tmp 的三个浏览器测试任务推断样本完成。

后续基线查询的最低有效条件（不要只检查 measurement 行是否存在）：

```sql
SELECT m.*
FROM review_measurements m JOIN tasks t ON t.id=m.task_id
WHERE m.ui_version='legacy'
  AND m.review_started_at IS NOT NULL
  AND m.active_review_ms IS NOT NULL
  AND m.active_review_ms >= 0
  AND COALESCE(json_extract(
    CASE WHEN json_valid(t.result_json) THEN t.result_json ELSE '{}' END,
    '$.review_measurement_excluded'), 0) <> 1;
```

这条查询只筛有效测量；仍须人工核对它来自真实任务和实际判断，不能把返回行数直接作为 R2 通过证明。P1 Metrics 必须沿用失效过滤规则。

## 放行条件

- [ ] 3 个真实 v2 dogfood 记录完整且没有 No-go。
- [ ] 10 个真实旧 UI 前瞻基线已采集并核对。
- [ ] 结合真实记录完成 R2 证据链、安全与代码审查结论。
- [ ] 用户/Codex 确认 R2 放行后，才开始 B01。
