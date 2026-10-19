# T02 · Codex adapter测试用例

版本：1.0；日期：2026-10-10。用例初稿，未评审；自动化未实现；全部未执行。  
依据：对应 [PRD](../../prds/T02-codex-adapter.md) v1.0 · [交接记录](../../handoffs/T02.md) · [填写规则](README.md)

以下为可实施的步骤和预期，不是已运行测试或自动化覆盖。真实外部写入仅在明确授权的试验仓库执行，凭据由操作者自行配置，不写入证据。

## 用例清单

| ID / 需求 | 场景 / 方式 | 前置条件 | 执行步骤 | 预期结果 | 当前结果 |
|---|---|---|---|---|---|
| T02-TC01；T02-FR01 | Profile 与调度；服务集成 | 两个 Profile/Runtime | 派任务后编辑配置；提交保留参数和不匹配能力 | 在途快照不变；保留参数拒绝；能力不符不认领；不回退 Kimi | 未执行 |
| T02-TC02；T02-FR02 | 无 Kimi 上手与探测；进程/UI | 无 Kimi 环境；模拟缺失/旧版本/未登录 | 启动 Runner；探测 Codex；由用户显式运行探针 | 无 Kimi 可启动；版本与登录可用性分开；探针不冒充真实业务样本 | 未执行 |
| T02-TC03；T02-FR03 | JSONL 分帧；单元/契约 | 真实格式 fixtures | 逐字节/分块/CRLF/末行无换行输入，加入长行/未知事件/坏 JSON | 事件顺序和字段正确；限额/诊断有效；损坏或未知终态不假成功 | 未执行 |
| T02-TC04；T02-FR03 | Windows 程序与参数；Windows 真实进程 | 含中文/空格路径及 .cmd 包装器 | 启动真实子进程，传入含引号提示；再模拟 spawn 失败 | 参数完整无 shell 注入；错误归该 Task；daemon 后续可用 | 未执行 |
| T02-TC05；T02-FR04 | 双仓库会话隔离；契约/真实恢复 | 两仓库两真实或协议替身会话 | 分别续作；交换 session；删除 workdir；传失效 ID | 明确 ID 恢复；错 Provider/仓库/目录拒绝；不调用 --last 或偷偷新会话 | 未执行 |
| T02-TC06；T02-FR04 | 显式重开与排队；服务/E2E | 运行中 Task 和一次反馈 | 提交续作后等待当前结束；无法恢复时显式新执行 | 反馈不假装实时注入；不丢 pending；新 Task/上下文变更可追溯 | 未执行 |
| T02-TC07；T02-FR05 | Report 通路与追问；契约/E2E | v2 Task，含旧/缺/超长 Report | 提交旧 SHA、错误身份；耗尽追问；末轮改 HEAD | 校验拒绝错误报告；最多现有上限；最后仍复核；不把 Agent 输出当 Verification | 未执行 |
| T02-TC08；T02-FR05 | Runner 独立终检；真实进程/Git | Agent 声称通过但真实检查失败 | 执行基线策略；在 complete 前制造 HEAD/clean 变化 | 保存实际失败；完整性阻塞；无无限修复或误 delivered | 未执行 |
| T02-TC09；T02-FR05 | 完成回执未知；故障注入 | complete 成功后丢失响应 | 同载荷重试；检查写库与广播；提交冲突载荷 | 幂等、不重复证据；未知回执不改发 fail；冲突拒绝 | 未执行 |
| T02-TC10；T02-FR06 | 取消与超时竞争；真实进程 | Agent 和终检各可启动子进程 | 在执行/终检两阶段取消，模拟 idle timeout 与 PID 过期 | 作用于当前进程树；不误杀旧 PID；终态一致，后续任务可跑 | 未执行 |
| T02-TC11；T02-FR06 | 权限与环境隔离；权限/进程 | 可观察子进程 env、审批失败替身 | 触发审批/回调失败；检查环境、日志和错误 UI | daemon token 不进入 Agent；敏感值不输出；不自动关闭 sandbox 或无限等待 | 未执行 |
| T02-TC12；T02-FR01、T02-FR02、T02-FR03、T02-FR04、T02-FR05、T02-FR06 | 真实 Codex 验收；真实本机验收 | 人自行配置可用 Codex；本地 Git 试验仓库 | 执行至少 3 个不同真实 v2 Task，其中至少一个为真实反馈续作 | 保存版本/session/Task/base/head/Report/Verification/策略hash/退出码；缺登录或额度记未完成 | 未执行 |

## 自动化映射

2026-10-19 起有新增测试。产品用例的“当前结果”仍按人工验收口径保留，不因自动化存在改成通过。

| 用例 ID | 自动化文件 / 测试名 | 覆盖范围 / 剩余人工项 | 状态 |
|---|---|---|---|
| TC01 | `apps/server/test/agent-profile.test.ts` | 入队快照不被后续编辑改变；保留参数拒绝；未探测能力不认领 | 部分自动化；真机调度未验收 |
| TC02 | `apps/runner/src/probe.ts`、`apps/server/src/services/profiles.ts`、`apps/web/test/agents.test.tsx` | 版本成功不写满能力；缺失程序为 missing | 真实登录未验收 |
| TC03 | `packages/core/test/codex.test.ts`、`apps/runner/test/codex.test.ts` | 分帧、坏 JSON、超长行后仍有 turn.completed 不算成功；0.147.0 失败流 | 成功推理 fixture 未取得 |
| TC04 | `apps/runner/src/agents/codex-launch.ts`、`apps/runner/test/codex.test.ts`、`apps/server/test/agent-profile.test.ts` | Windows `.cmd` 有 node 入口才改走 node；没有入口时不启动并记为缺失。`.ps1` 走 powershell -File | 真实 spawn 失败仍待产品验收 |
| TC05 | `decideSessionResume`、`agent-profile.test.ts`、`executor.test.ts` | 双仓库/换 Runtime/丢目录/新工作树拒绝静默续作；追问保留已批准的 session id | 真实 CLI 恢复未验收 |
| TC06 | 同上，显式重开为 blocked | 不使用 `--last` | 真实续作未验收 |
| TC07 | `readBoundedUtf8`、executor 追问失败保留原因 | 超限先读上限；protocol_error 不进入 complete | 旧 SHA 仍依赖既有 A05 测试 |
| TC08 | 既有 `verification.test.ts` | Runner 终检不读 Agent 自述 | 未把本轮标成新的产品通过 |
| TC09 | 既有 complete 幂等测试 | 回执未知不改发 fail | 未单列新的 Codex 故障注入 |
| TC10 | 既有 `process.test.ts` 进程树 | 执行阶段取消 | 终检阶段取消沿用旧测试 |
| TC11 | `executor.test.ts` 虚构 GH_TOKEN / daemon token | 凭据键、嵌入值和带凭据的服务地址不进环境 | 真实批准未验收 |
| TC12 | 无 | 需要 3 个真实 v2 Task | 未执行；模型被账号拒绝 |

## 运行记录（每轮追加，不覆盖失败历史）

当前执行次数：0；通过：0；失败：0；未执行：12。未执行不是通过。

| 日期 / 执行人 | 代码 SHA / PRD 版本 | 环境 / CLI 版本 | 用例 / 命令或步骤 | 通过 / 失败 / 未测 | 证据 / 缺陷 |
|---|---|---|---|---|---|
| 尚无执行 | 未运行 / 1.0 | 未采集 | 未执行 | 0 / 0 / 12 | 无 |
| 2026-10-19 / Cursor | 实施分支 codex/t02-codex-adapter，检查点 49ca0f0 之后的工作区；PRD 1.0 | Windows，Node 22.18.0，Codex CLI 0.147.0 | 专项与随后的 pnpm test。真实探针只得到失败 JSONL | 产品用例仍 0/0/12。自动化另行记录 | 账号拒绝 gpt-6-luna 与一次显式 gpt-5.2-codex，未完成 3 个真实 Task |
| 2026-10-19 / Cursor | 同一实施分支，审查修复之后；PRD 1.0 | Windows，Node 22.18.0 | 修复后 `pnpm test`、`pnpm build`、四包 `tsc --noEmit` | 产品用例仍 0/0/12。自动化 Core 167、Server 419、Web 79、Runner 218，退出码 0 | 首轮全量因服务地址多了斜杠导致 3 条 Runner 端到端失败，已去掉多余斜杠后重跑通过 |

产品改动完成后还需项目全量 test、build、四包 noEmit；将真实结果追加此处。文档链接检查不计作这些产品用例通过。

## 验收记录

产品验收人：LQY-920，尚未验收。独立审查已于 2026-10-19 完成并指出缺陷，修复后的产品用例仍待验收。需求变化时注明新版本、受影响用例及重新执行范围；旧结果不能自动沿用。
