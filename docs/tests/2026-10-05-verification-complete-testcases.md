# complete 原子证据落库测试用例

> 来源：锁定 PRD FR-001/FR-002；实施计划 A07。
> 日期：2026-10-05。范围：服务端 complete、v2 Issue 流转、Runner Fake CLI 端到端；没有页面改动。
> 前置环境：Windows、Git、Node、pnpm 和项目依赖已安装。服务端使用内存 SQLite；端到端使用临时 Git 仓库、真实 CLI 子进程及真实验证命令，Agent 行为由 Fake CLI 模拟。凭据均为测试数据。

## 执行入口

```powershell
pnpm --filter @anvil/server test test/verification-complete.test.ts test/auto-advance.test.ts
pnpm --filter @anvil/runner test test/e2e.test.ts test/executor.test.ts
pnpm test
pnpm build
```

四包另外分别执行 `pnpm exec tsc --noEmit -p tsconfig.json`。

## 用例列表

### TC-Complete_001 完成任务_完整通过证据_原子保存全部事实
- 优先级：P0 | 类型：接口
- 测试数据：start 固化完整 base/branch/work_dir，Report HEAD 与最终 HEAD 相同，required 检查 exit_code=0。
- 测试步骤：运行 verification-complete 中“保存任务事实、Run、Checks”用例。
- 预期结果：Task completed；最终 HEAD/clean、Run、Checks 和 result_json 一致；兼容快照带 schema_version=2、run ID、ready；token 清空，Issue 进入 in_review，回执包含相同 Packet 状态。
- 执行结果：✅ 通过。

### TC-Complete_002 完成任务_非通过证据_保留真实状态
- 优先级：P0 | 类型：接口
- 测试数据：failed、partial、not_configured、dirty、stale、invalid_policy、verification_error。
- 测试步骤：运行“真实 %s 证据可完成并进入人工审查”矩阵及“验证前 dirty”用例。
- 预期结果：合法证据可以完成；失败或未配置为 verification_blocked，dirty/stale 为 integrity_blocked；不得保存 passed；Report 等交付材料齐全时仍可进入人工审查。
- 执行结果：✅ 通过；异常 error_code 保留在 result_json 的验证快照中，现有 verification_runs 表不增加该列。

### TC-Complete_003 核对交付_缺报告或 SHA 过期_不得伪造 ready
- 优先级：P0 | 类型：接口
- 测试数据：无报告、无 delivered_at、Report SHA 与最终 HEAD 不同。
- 测试步骤：运行“%s 不得产生 ready”三条用例。
- 预期结果：前两者 incomplete 且 Issue 不推进；旧报告 integrity_blocked，可进入人工审查；保留验证事实和 Task completed。
- 执行结果：✅ 通过。

### TC-Complete_004 重放请求_相同或不同有效载荷_保持幂等
- 优先级：P0 | 类型：接口
- 测试数据：相同 complete 重放；随后仅更改检查耗时。
- 测试步骤：运行“重放不增加 Run/Checks/评论/广播”用例。
- 预期结果：相同请求返回首次回执，数据库行、时间、评论、广播次数不变；改变业务载荷返回 409 idempotency_conflict。
- 执行结果：✅ 通过。

### TC-Complete_005 核对基线_锚点改变或缺失_拒绝不完整证据
- 优先级：P0 | 类型：接口
- 测试数据：base_commit、branch、work_dir 分别改变；分别缺失基线、分支、目录、HEAD 或 verification。
- 测试步骤：运行“拒绝与 start 不一致”矩阵及对应非法证据用例。
- 预期结果：改变锚点为 409 base_mismatch，必需事实缺失为 400 invalid_verification；无新 Run，Task 保持 running。
- 执行结果：✅ 通过。

### TC-Complete_006 校验载荷_版本结构或结论矛盾_零副作用拒绝
- 优先级：P0 | 类型：接口
- 测试数据：未知版本/枚举/字段、重复检查 ID、9 条检查、非法 bool、负耗时、非法时间、单条退出码矛盾、总状态矛盾、空检查谎报 passed、执行过却缺开始时间/SHA。
- 测试步骤：运行“拒绝非法证据”矩阵。
- 预期结果：400 稳定错误码，Task 行不变、Run 数为零、没有广播；verification_error 不能豁免已执行检查的必要证据。
- 执行结果：✅ 通过。

### TC-Complete_007 处理文本_超限或含测试凭据_有限且脱敏
- 优先级：P0 | 类型：接口
- 测试数据：中文摘录超过 8192 字节、8 条摘录导致总 JSON 超过 65536 字节、合成 atk_ 与 Bearer 字符串。
- 测试步骤：运行大小边界与“验证文本脱敏后写入所有快照”用例。
- 预期结果：超限拒绝且不截断后静默接受；合法文本在 Checks、result_json 中脱敏；再次提交原请求仍命中幂等回执。
- 执行结果：✅ 通过。

### TC-Complete_008 写入证据_事务任一步失败_全部回滚并可重试
- 优先级：P0 | 类型：接口/故障注入
- 测试数据：两个检查；分别在插入 Run、插入第二条 Check、关联 Task、写幂等 hash、写系统评论时触发 SQLite ABORT。
- 测试步骤：运行五条“SQL 强制失败时全部回滚”；移除 trigger 后重试同一载荷。
- 预期结果：失败后无残留 Run/Checks，Task/token/lease/Agent/Issue/评论保持原状，无广播；重试成功。
- 执行结果：✅ 通过；第二条 Check 故障验证已插入的第一条也被回滚。

### TC-Complete_009 认证调用_task token 或其他 runtime_禁止写入
- 优先级：P0 | 类型：接口
- 测试数据：task token；相同 workspace 下不属于该 Task 的 daemon ID。
- 测试步骤：运行“task token 和其他 daemon 均不能写证据”。
- 预期结果：分别 401/403；Task running、没有证据行。
- 执行结果：✅ 通过；既有 daemon 权限及事务专项也包含在全量回归中。

### TC-Complete_010 保持兼容_v1 或无 Git 任务_不制造证据
- 优先级：P0 | 类型：接口
- 测试数据：显式 v1 branch-only complete；无 start Git 锚点的 v2 普通目录任务。
- 测试步骤：运行 auto-advance 的 7 条 v1 回归及“无 Git 锚点的 v2”用例。
- 预期结果：v1 原行为不变；无 Git 任务拒绝伪造 Git evidence，但无 Git facts 的完成保持可用、Packet incomplete、无验证记录且 Issue 不推进。
- 执行结果：✅ 通过。历史 branch-only fixture 显式标 v1；新 v2 矩阵单独覆盖严格契约。

### TC-Complete_011 状态流转_push 失败或人工已处理_保留事实和人工状态
- 优先级：P1 | 类型：接口
- 测试数据：complete pushed=false；Issue 已 blocked/done。
- 测试步骤：运行“URL task branch push 失败”和“不抢占 Issue”用例。
- 预期结果：保存 pushed=false，不自动标 done；blocked/done 不被推进逻辑覆盖。
- 执行结果：✅ 接口层通过。该用例验证 pushed=false 的保存语义，不冒充真实远程网络故障演练。

### TC-Complete_012 补齐状态边界_超时跳过或空策略_准确持久化
- 优先级：P1 | 类型：接口
- 测试数据：required 超时后检查 skipped；存在策略文件但 commands 为空。
- 测试步骤：运行“required 超时与后续 skipped”和“空策略 commands”用例。
- 预期结果：分别为 failed 与 not_configured；超时/跳过原样存储；空策略仍保留原文件 hash，不能变成 passed。
- 执行结果：✅ 通过。

### TC-Complete_013 完整执行_Fake CLI 声称通过_以真实验证退出码为准
- 优先级：P0 | 类型：端到端
- 测试数据：真实临时 Git 仓库及策略，真实 spawn 的 Fake CLI 写文件、commit 并提交 Report；两组基线命令分别 exit(0)/exit(7)，Agent 文案均声称测试通过。
- 测试步骤：运行 e2e 中两条 v2 证据闭环测试。
- 预期结果：Runner 认领到 complete 全链路完成；base 保持、HEAD 前进、worktree clean；Report SHA=最终 HEAD=验证 SHA；退出码分别形成 passed/ready 与 failed/verification_blocked；主仓库 HEAD 不变。
- 执行结果：✅ 通过。Fake CLI 自动化不计入 R2 的三个真实 Agent dogfood。

## 需求覆盖矩阵

| 需求 | 用例 |
|---|---|
| Task/Run/Checks/回执原子性与幂等 | 001、004、008 |
| 服务端重新校验事实及状态 | 002、005、006、012 |
| Report/HEAD/验证关系及 v2 Issue 流转 | 002、003、011、013 |
| 凭据权限、脱敏及大小上限 | 007、009 |
| v1/普通目录兼容及 URL pushed=false | 010、011 |
| 真实子进程、Git 与服务端完整链路 | 013 |

## 执行结果与两段自审

- 新增服务端专项最初 40 失败 / 4 通过；实现后转绿。扩展边界探针又发现五处缺字段/错误分类问题，修复后服务端专项 54 条及 v1 autoAdvance 7 条全部通过。
- Runner e2e/executor 专项 70 条通过，包括本次新增的两条 v2 Fake CLI 测试。A06 已完成执行顺序接线，本次无需再改 executor 生产代码。
- 严格 v2 校验使 23 条旧 branch-only fixture 测试失败，按其原测试目的显式标记为 v1，保留断言；无 Git agent-status 测试去掉虚构 branch，继续测试 v2。
- Server 默认并发及其后两 worker 下，三条真实 URL Git 用例仍出现 5 秒超时；测试 script 限制 maxWorkers=2，并仅将这三条 clone/push 场景的超时设为 15 秒。未修改业务断言或全局超时。
- 一次构建发现参数化测试状态推断为 string，使用 const 类型收窄后修正；最终构建与 noEmit 均通过。
- 最终门槛：`pnpm test` **37 文件 / 794 用例通过**（core 161、server 367、runner 210、web 56）；`pnpm build`、四包 `tsc --noEmit`、`git diff --check` 通过。
- 日志：`tmp/codex-a07-tests.log`、`tmp/codex-a07-build.log`、`tmp/codex-a07-evidence-final.log`、`tmp/codex-a07-runner.log`。构建保留既有 Node 内置模块浏览器 externalized 提示。
- 契约自审：核对 A07/FR-001/FR-002 的事务边界、base 不可替换、证据状态、Issue 流转、v1 与 URL 兼容；未新增 Task 状态或改锁定 PRD。
- 代码自审：核对原始及脱敏载荷双重校验、与 hash 一致的客户端业务快照、首次派生回执重放、五处回滚、未知字段/超限/异常证据边界。两段均为本次 Codex 自审，不声称有独立 reviewer。
- 当前 Packet 状态是完成时的证据快照。B01 的实时 Git 核验、Decision 与合入 Gate、A08 的计时、R2 的真实样本尚未完成。
