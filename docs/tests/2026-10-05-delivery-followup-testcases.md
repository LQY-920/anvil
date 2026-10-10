# 交付追问最终核对测试用例

> 来源需求：`prd_outputs/Anvil Delivery Loop v0/anvil_delivery_loop_v0_PRD.md` FR-002；实施计划 A05。
> 生成日期：2026-10-05 | 产品形态：网站 | 用例数：6
> 范围：Runner 与真实内存 Server 的交付接口集成；不涉及页面改动，跳过页面布局与交互检查。

## 用例列表

### TC-DeliveryFollowup_001 核对报告_首轮交付_停止追问
- 优先级: P0 | 类型: 接口
- 前置条件: 已安装项目依赖和 Git；测试创建临时 Git 仓库和内存 Server。
- 测试数据: [deliveryRound: 1] [schema_version: 1]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t '第 1 轮绑定最终 HEAD'`。
- 预期结果:
  1. Report PUT 返回 200；任务为 completed；Report SHA 等于最终 HEAD；执行和交付查询各 1 次；result_json 无 undelivered；未调用 fail。
- 执行结果: ✅ 通过 (2026-10-05)

### TC-DeliveryFollowup_002 核对报告_首次追问交付_停止追问
- 优先级: P1 | 类型: 接口
- 前置条件: 同用例 001 的环境，测试独立建库。
- 测试数据: [deliveryRound: 2] [首轮 Report SHA: 40 个零]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t '第 2 轮绑定最终 HEAD'`。
- 预期结果:
  1. 执行和交付查询各 2 次；仅追问使用 resume；Report SHA 等于最终 HEAD；任务 completed 且无 undelivered。
- 执行结果: ✅ 通过 (2026-10-05)

### TC-DeliveryFollowup_003 核对报告_末次追问交付_清除未交付判定
- 优先级: P1 | 类型: 接口
- 前置条件: 同用例 001 的环境，测试独立建库。
- 测试数据: [deliveryRound: 3] [前两轮 Report SHA: 40 个零]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t '第 3 轮绑定最终 HEAD'`。
- 预期结果:
  1. 每轮 commit 推进 HEAD；执行和交付查询各 3 次；Report 绑定第三轮 HEAD；任务 completed 且 delivered_at 非空；result_json 无 undelivered；未调用 fail。
- 执行结果: ✅ 通过 (2026-10-05)

### TC-DeliveryFollowup_004 核对回调_v1末次交付_保留兼容语义
- 优先级: P2 | 类型: 接口
- 前置条件: 同用例 001 的环境；测试将任务协议设置为 v1。
- 测试数据: [deliveryRound: 3] [回调 status: in_review]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t 'v1 第 3 轮'`。
- 预期结果:
  1. v1 回调 HTTP 200；执行 3 次；任务 completed；result_json 无 undelivered。
- 执行结果: ✅ 通过 (2026-10-05)

### TC-DeliveryFollowup_005 限制追问_未提交报告_保留未交付判定
- 优先级: P2 | 类型: 接口
- 前置条件: 同用例 001 的环境，测试独立建库。
- 测试数据: [提交 Report: 否]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t 'v2 缺 Report'`。
- 预期结果:
  1. 总执行次数为 3；任务 completed；result_json.undelivered=true。
- 执行结果: ✅ 通过 (2026-10-05)

### TC-DeliveryFollowup_006 限制追问_报告版本不符_保留未交付判定
- 优先级: P2 | 类型: 接口
- 前置条件: 同用例 001 的环境，测试独立建库。
- 测试数据: [report_head_commit: 40 个零]
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/executor.test.ts -t '连续两轮仍 mismatch'`。
- 预期结果:
  1. 总执行次数为 3；任务 completed；result_json.undelivered=true；不以报告版本不符为由调用 fail。
- 执行结果: ✅ 通过 (2026-10-05)

## 需求覆盖矩阵
| 功能点 | 来源 | 用例 |
|---|---|---|
| 每轮结束核对 Report 与 HEAD | A05 / FR-002 | 001–003 |
| v1 回调兼容 | A05 | 004 |
| 最多两次追问与未交付 | A05 | 005–006 |

## 执行汇总
- 总数 6 | 通过 6 | 失败 0 | 阻塞 0 | 未执行 0 | 通过率 100%（已执行 6 条）。
- 实际执行方式：上述筛选用例均由 `pnpm test` 全量运行覆盖，35 文件、712 用例通过；Server Report/lifecycle 专项 50 用例通过。
- `pnpm build` 与四包 `tsc --noEmit` 通过；构建保留现有 node 内置模块 externalized 提示。
- 红灯证据：修复前第三轮交付用例得到 undelivered=true；修复后通过。缺陷已记录 `.codex/PITFALLS.md` P-015。
- 环境记录：专项测试与全量测试、构建重叠时，两个既有 Git 集成用例超过 5 秒；后续全量运行通过，未放宽超时或断言。
- 两段审查：契约核对确认仍最多执行 3 轮；代码审查确认终态上报幂等、token 边界和分支检查路径未改变。本次由 Codex 修复并自审，不冒充独立复审。
- 无外部 GitHub 写操作；本地缺陷闭环已完成。A06、A07、A08 和真实 dogfood 不在本记录的完成范围内。
