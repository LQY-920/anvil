# T06 · pi、dsh 等 Agent 扩展 PRD

版本：1.0；日期：2026-10-10（Asia/Shanghai）；状态：需求初稿，待评审、待认领。  
入口：[总清单](../TASKS.md) · [交接记录](../handoffs/T06.md) · [测试用例](../tests/tasks/T06-testcases.md) · [公共边界](COMMON.md)

## 1. 摘要

在 T02 稳定的 Provider 契约上分别接入本机 pi 和 DeepSeek Harness（dsh），允许用户选择已安装 CLI，并统一任务、消息、会话、取消和交付证据。可配置 executable 不等于任意 CLI 自动兼容；每个 Provider 必须完成协议适配与实测。

## 2. 现状与问题

当前 Anvil 仅有 Kimi adapter；Codex 由 T02 单独实现。用户明确 dsh 指 deepseek-ai/deepseek-harness，不能把它当普通 shell 工具。2026-10-08 的官方资料审查显示不同模式的事件、会话、取消和权限能力并不相同；这些是设计依据，不是本机适配成功证明。
本 PRD 不锁定未来上游版本。认领实施时重新核对所安装版本、帮助与协议，记录兼容矩阵。

## 3. 目标与指标

| 目标 | 验收标准 |
|---|---|
| 两个可用 Provider | pi 和 dsh 各完成至少 1 个真实成功任务和 1 个执行中受控取消任务；一般错误不能代替取消 |
| 明确能力 | 支持模式、版本、OS、resume/cancel/approval 能力可查；不支持项明确禁用 |
| 证据一致 | 每个 Provider 的 Agent Report 与 Runner 验证仍绑定任务/最终 SHA，无退出码假交付 |
| 可扩展且不回归 | 新 adapter 不污染调度/Git；Codex 契约及真实 smoke 回归通过 |

## 4. 用户、范围与非目标

面向已有 pi/dsh 的本机用户。技术上仅硬依赖 T02 契约与公共测试稳定，排期建议在 T05 后，可独立调整。
包含 pi、dsh 两个 adapter、配置探测、能力 UI、事件/会话/取消、Report、文档及测试。只有 pi 完成时本任务仍是部分完成。Claude Code、Cursor CLI 是后续候选，应另建任务或明确变更本 PRD，不自动计入首期。
不做自动安装/登录、复制凭据、远端 Agent 平台、模型供应商网关、所有 CLI 的任意命令万能适配。

## 5. 功能需求

### T06-FR01 复用 Profile 配置（P0）
- [ ] 扩展 T02 Provider 注册与配置，支持可执行路径、允许参数和 env 引用；不在数据库保存认证值。任务 cwd 由 Runner 固定，Profile/参数不得覆盖；如支持子目录，只能位于同一 worktree 并经平台验证。
- [ ] Profile 版本及非敏感快照固定在 Task，平台保留输出/会话/任务参数，不接受 shell 字符串拼接。
- [ ] UI 允许选择已配置 Provider，缺失能力/不兼容版本不静默回退 Kimi/Codex。

### T06-FR02 能力和兼容矩阵（P0）
- [ ] 各 Provider 声明适配模式、版本区间、OS、事件格式、明确会话恢复、取消、审批和并发能力。
- [ ] 不能根据 CLI 名称推断能力；协议未验证标 unverified，不支持项不提供假按钮。
- [ ] pi 的 JSON/RPC 与 dsh 的 headless/SDK/ACP 分别评估；首期选一种可验证模式，不要求把所有模式都实现。

### T06-FR03 探测与诊断（P0）
- [ ] 分别检测可执行文件、版本/协议、登录未验证和显式推理探针结果；版本帮助成功不宣称可执行任务。
- [ ] 诊断输出脱敏且有上限，错误说明缺程序、版本不兼容、认证/额度、权限或协议问题。
- [ ] Windows/Linux 支持情况按实际结果记录；没有真实验证的平台不列作已支持。

### T06-FR04 事件转换（P0）
- [ ] 将文本、工具、用量、会话、终止/错误映射为公共事件，保留必要 Provider 原始类型方便诊断。
- [ ] 正确处理分块、LF/CRLF、长行、异常 JSON 和未知事件；协议分帧不得把字符串内 Unicode 分隔符当换行。
- [ ] stderr 或未知事件不能单独伪造成功；解析失败收敛到单 Task，daemon 后续任务可继续。

### T06-FR05 明确会话恢复（P0）
- [ ] 会话引用绑定 Provider、Profile/版本、Runtime、仓库与工作树；禁止使用全局“最后会话”。
- [ ] 能力支持时用明确 ID 恢复并实测；不支持或会话失效时显示原因，不把新会话冒充续作。
- [ ] 允许用户显式选择新执行轮次作为替代，但保留此前失败和上下文变更记录。

### T06-FR06 取消、超时与审批（P0）
- [ ] 支持协议取消时先协议取消，再有限等待并终止整个进程树；不支持时明确使用进程终止后备。
- [ ] 权限请求按能力映射为等待/拒绝/人工处理，不自动 yes，不为获得成功默认关闭 sandbox。
- [ ] 取消/超时/协议错误映射到现有 Task 状态与原因码，不能提交为 delivered；资源可回收且 daemon 存活。

### T06-FR07 统一交付和验证（P0）
- [ ] Report 通过受限回调或明确的结构化转交提交，身份/Schema 校验与 T02 一致。
- [ ] 缺报告、报告 HEAD 不符、dirty、独立验证失败使用现有证据/追问规则，不因 Provider 差异降低标准。
- [ ] daemon/GitHub 高权限凭据不传给 Agent；检查提示、日志、Provider 会话文件可能的敏感信息外泄。

### T06-FR08 真实认证与回归（P0）
- [ ] pi/dsh 分别记录版本、模式、OS、配置（脱敏）和真实 Task/Report/验证，至少成功、执行中受控取消各一例；确认子进程停止且工作树不再变化，一般错误不能替代取消。
- [ ] 恢复/权限等能力只有经过真实验证才声明支持；限制清楚展示在矩阵和 UI。
- [ ] 公共 adapter 契约测试及 Codex 回归通过，添加 Provider 不改变既有任务/数据可读性。

以上为首期验收要求；新增第三个 Provider 应经过清单/需求变更流程。

## 6. 非功能需求

子进程参数不经 shell 拼接，事件/日志有上限，凭据脱敏。兼容矩阵绑定测试日期与版本；不将上游“developer preview”当稳定承诺。保持 Windows 进程树清理和 Git 路径处理。每个 adapter 的错误独立隔离，共用消息背压/上传机制。

## 7. 架构与边界

在 Runner agents 注册表新增 pi/dsh 实现，复用 T02 Backend 输入/结果、Probe、Profile 与会话引用。Core 只扩展公共能力/事件和必要 Provider 标识，不暴露大量私有协议到 Server/Web。
Runner 负责工作树、验证、生命周期；Adapter 只负责 CLI/protocol；服务端调度按能力匹配。不要建立第二套 Agent 平台或把所有 CLI 输出塞进同一个宽松解析器。

## 8. API、鉴权与错误（拟议，优先复用 T02）

| 操作 | 输入 | 输出 |
|---|---|---|
| GET /api/providers | Runtime/平台过滤 | Provider 描述、能力、已验证版本 |
| POST /api/agent-profiles/:id/probe | Profile 版本 | 程序/版本只读诊断，不返回凭据 |
| POST /api/agent-profiles/:id/test-run | 明确启动真实探针、Profile 版本 | probe_run_id、推理/能力诊断；复用 T02 |
| 创建任务 | profile_id/version、明确会话引用（如支持） | 固定配置的 Task |
| 取消任务（沿用既有入口） | task_id、命令幂等键 | cancelling/已终止/已有结果 |

配置示例：`{"provider":"pi","executable":"<本机路径>","args":[],"protocol_mode":"<已验证模式>"}`。
探测响应例：`{"provider":"pi","executable_found":true,"version":"<实测版本>","auth_state":"not_checked","capabilities":{"resume":"unverified","cancel":"process_tree"}}`。
不支持模式/参数 422、Profile 漂移或会话错配 409、程序缺失/认证失败为诊断结果及明确 Task 原因；不能返回假成功。接口仍在人类/daemon/task 三个身份边界内，T05 后复用其人类鉴权，Adapter 不新增远程未认证端口。

## 9. 数据模型（扩展 T02，避免重复表）

| 类型 | 必要字段 |
|---|---|
| ProviderDescriptor | id、adapter_version、supported_modes:string[]、platforms:string[]、capabilities:CapabilityMap |
| ProfileSnapshot | provider、profile_version、executable_ref、protocol_mode、args、env_refs；不含认证值 |
| SessionRef | provider、runtime_id、repository_id、work_dir_identity、profile_version、external_session_id |
| CompatibilityEvidence | provider、cli_version、adapter_version、os、mode、tested_at、task_refs、capability_results |

能力值使用 supported/unsupported/unverified；Backend 原始结果映射现有 Task.status + 原因码，不随 Provider 随意增加状态。

## 10. 交互与状态

Agents 页添加配置 → 探测程序/版本 → 显式运行能力探针 → 选择任务执行器。用户能看到当前模式、真实验证范围与限制；不能恢复时说明并允许明确创建新轮次。任务结果沿用同一 Report/Verification/PR 界面，不建立 Provider 特殊“已完成”旁路。

## 11. 上游依据与接入策略

- pi：参考 [官方 coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)，在已安装版本核对 JSON/RPC、事件与会话协议。
- dsh：[官方仓库](https://github.com/deepseek-ai/deepseek-harness)已由用户明确指定；参考 [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)、[SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)、[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)。
- 此前资料显示 dsh headless 的最终文本不能假定有 JSONL/resume；SDK stdio、ACP 的取消/会话/权限能力不同。优先探测能覆盖本期要求的模式，记录取舍；进程取消可作为明示后备。
- 上述为 2026-10-08 研究依据，本轮未重新联网或运行 CLI；实施时重新核对官方资料和实际版本。

## 12. 边界情况

| 场景 | 必须行为 |
|---|---|
| 同名程序其实是其他工具 | 版本/协议探测拒绝，不盲跑任务 |
| 协议缺取消方法 | 明示进程终止后备并验证子进程清理 |
| session 来自其他 Provider/目录 | 拒绝恢复，不能静默 resume-last |
| 未知事件、乱码、长行 | 限额与诊断，单 Task 失败不退出 daemon |
| 权限请求或登录失败 | 等待/失败原因可见，不自动扩权 |
| CLI exit 0 但无 Report | 依规则追问/失败，不进入已交付 |

## 13. 测试与完成标准

[测试用例](../tests/tasks/T06-testcases.md)先用固定协议 fixtures 测解析、绑定和取消，再各跑真实任务。pi 与 dsh 各至少成功、执行中受控取消一例并确认停止写入；一般错误不替代取消。声称支持恢复时追加真实恢复证据。Codex 跑公共契约与真实 smoke 回归。
两个 Provider 所有首期 FR、产品测试/build/四包类型检查、自审/独立审查、产品验收及兼容矩阵通过方可完成。单 Provider 通过或只跑 --help 不算整体完成；受上游限制时记录未完项和需求变更决定。

## 14. 实施顺序与交接

先冻结 T02 公共契约和每个 CLI 版本/模式，再做 fixtures、pi adapter 和实测，再做 dsh adapter 和实测，最后公共回归与文档。pi/dsh 可以分内部子任务，但共用一位本 PRD 负责人避免接口漂移。
认领时确认本机安装版本、选用协议、可用测试凭据由人自行配置、支持 OS、审查者；不读取或搬运登录文件。每次上游升级更新兼容证据而非沿用旧通过记录。

## 15. 版本记录

| 版本 | 日期 | 变化 | 状态 |
|---|---|---|---|
| 1.0 | 2026-10-10 | 独立 pi/dsh 扩展 PRD，明确真实能力与 Codex 回归 | 初稿，未认领、未实施 |
