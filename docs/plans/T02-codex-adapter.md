# T02 Codex adapter 技术计划

日期：2026-10-17（Asia/Shanghai）。状态：申请认领阶段的实施准备。本文不是已认领、不是业务代码、不是真实 Codex 样本，也不是 J01 通过。

入口：[交接记录](../handoffs/T02.md) · [需求](../prds/T02-codex-adapter.md) · [用例](../tests/tasks/T02-testcases.md) · [总清单](../TASKS.md) · [公共边界](../prds/COMMON.md)

交接来源在另一工作树 `D:/anvil/tmp/worktrees/cursor-handoff-20261017`，分支 `codex/cursor-handoff-20261017`，SHA `73cc3fb9291fa5bfb511cecae3e438d5ee053e88`。该分支不进入本认领补丁，也不合并到 `main`。

## 1. 实际基线

| 项 | 事实 |
|---|---|
| 共享 main | `75dfde454f653376c3dac10224e44bc734ee75a0`。2026-10-17 `git fetch origin --prune` 后，本地 `origin/main` 与 `git ls-remote origin refs/heads/main` 一致 |
| 本认领分支 | `codex/claim-t02`，工作树 `D:/anvil/tmp/worktrees/t02-claim`，从上述 main 创建。已取消对 `origin/main` 的上游跟踪，避免误推 main |
| 主工作树 | `D:/anvil` 仍在 `codex/anvil-icon-refinement`，HEAD `73cc3fb9291fa5bfb511cecae3e438d5ee053e88`。本轮没有切换、重置或在其中写 T02 |
| PRD | T02 v1.0。Git blob SHA-256 `5B52E1D811E3C67CCFF2A00D407C875FC0DADAD7BA4B509FD227F4EBB79F16CF`，10699 字节，与交接记录一致。原文未改 |
| 认领冲突 | 远端没有 `codex/claim-t02` 或其他 `*t02*` 分支。开放 PR 搜索没有另一份 T02 认领。当前 GitHub 登录是 LQY-920 |
| 本轮代码 | 不修改 `apps/`、`packages/`、迁移或 UI |

`D:/anvil` 上的图标工作与本任务无关。交接文档分支基于尚未合并的 T01 文档提交，不能当作 T02 的共享起点。

## 2. 认领申请

| 字段 | 值 |
|---|---|
| 负责人 | LQY-920。这是申请，共享并经接收确认后才是已认领 |
| 实施工具 | Cursor。AI 不是负责人，也不是独立审查人 |
| 独立审查人 | 待确定 |
| 产品验收人 | LQY-920，尚未验收 |
| 整合负责人 | LQY-920。Core、executor、迁移由这一条线在实施时统一修改；T01 尚未对本文提案确认 |

没有发现已有负责人，因此没有覆盖别人的认领记录。

## 3. T01 与 J01

实时 GitHub：

- [PR #2](https://github.com/LQY-920/anvil/pull/2) 已于 2026-10-13 合入 main。它只共享 T01 认领和设计。
- [PR #3](https://github.com/LQY-920/anvil/pull/3) 仍是开放草稿，head `73cc3fb9291fa5bfb511cecae3e438d5ee053e88`，base 是本 main，`mergeable_state` 为 `blocked`，未合并。
- 本 main 的 [T01 交接](../handoffs/T01.md) 仍写“申请认领、代码未开始”。这是 PR #2 合入时的原文。PR #3 上的实现、1011 条用例和用户步骤不属于本 SHA。
- 本轮不改 T01 交接，不把 PR #3 整分支并入，不把 TC12 或 J01 标成完成。

相对本 main，PR #3 在执行链上的已见差异只有：

- `apps/runner/src/executor.ts`：绑定任务使用仓库快照；Agent 环境去掉 GitHub 连接凭据；绑定任务不再由 Runner push。
- `packages/core/src/models.ts` 与 `protocol.ts`：Issue/Task 增加仓库和来源快照字段，Diff 响应可带契约版本。
- `apps/runner/src/agents/`、`probe.ts`、`vite.config.ts`、Server 端口和 Runner 地址在这次对比中没有变化。Backend 仍只有 Kimi。

T02 认领合入后，从当时最新 main 开实施分支。若 T01 仍未合入，T02 按本 main 的公共契约开发，汇合时单独处理 executor 差异。Adapter 不创建工作树、不 push、不解析成 GitHub 操作。Git 服务不解析 Codex 私有 JSON。

[J01](../handoffs/J01-integration.md) 保持未开始。T02 可先用本地 Git 仓库独立验收。联合验收需要同一候选 SHA、受控 GitHub 仓库和所有者另行授权，不在本轮执行。

迁移编号：本 main 最新是 `0003_luxuriant_sinister_six`。PR #3 已使用 `0004` 和 `0005`。T02 实施时按当时 main 生成迁移，不预占这两个文件名。

## 4. 共享 main 上的执行事实

这些是阅读 `75dfde4` 的结论，不是新行为。

- `PROVIDERS` 只有 `kimi`。Agents 页创建按钮固定该 Provider。
- Runner 启动时只探测 `kimi --version`。一个都没有就退出，并提示安装 Kimi。
- `ExecOptions.resume` 是布尔值。Kimi 在为真时追加 `-c`，恢复的是当前工作目录的最近会话，不是显式 ID。
- `tasks.session_id` 和 complete 请求已有字段，但 executor 的 complete 调用没有填写它。
- 认领按在线 Runtime 的 `provider` 字符串匹配 Agent，没有 Profile 版本或能力表。
- 进程读取按 `\n` 分帧，末段在退出时再解析；stderr 每行变成 `log`。退出码 0 直接是 `completed`。没有独立的协议终态。
- 行解析认的是 Kimi 的 `role`。无法解析的行变成 `log`。没有行长上限。
- v2 交付仍由 Agent 用任务 token 调用 `PUT /api/daemon/tasks/:id/delivery-report`。Runner 最多追问 2 轮，最后一轮后仍核对 HEAD 和 Report。Verification 只来自基线策略。
- 取消轮询看到终态后，只杀当前阶段。Agent 退出后不再杀旧 PID；终检使用同一个取消信号。
- 子进程会去掉 `ANVIL_DAEMON_TOKEN`，但本 main 仍会把 `ANVIL_TOKEN` 和 Server 地址放进 Agent 环境。PR #3 另会去掉 GitHub 连接凭据；那部分还没进入本基线。

因此不能把现有 Kimi 路径改个命令名当作 Codex 已接通。

## 5. 本机 CLI：帮助级事实

2026-10-17 在本机执行，没有读取认证文件，没有运行 `doctor`，没有发送 prompt。

| 检查 | 结果 |
|---|---|
| 命令 | PATH 上的 `codex` 是 `D:\codingTools\NodeJS\node_global\codex.ps1`，同目录还有 `codex.cmd`。入口转到 `@openai/codex` 0.147.0，再启动其 Windows vendor 里的 `codex.exe` |
| 版本 | `codex-cli 0.147.0` |
| 顶层帮助 | 有 `exec`、交互式 `resume`、`login`、`logout` 等。交互式 `resume` 默认是选择器，`--last` 表示最近一条 |
| `codex exec --help` | 有 `--json`、`--output-schema`、`--output-last-message` / `-o`、`--sandbox`、`--ephemeral`、`--skip-git-repo-check`、`--approve-for-me`、`--dangerously-bypass-approvals-and-sandbox`。子命令有 `resume` |
| `codex exec resume --help` | 位置参数是 `[SESSION_ID] [PROMPT]`。另有 `--last`、`--all`、`--json`、`--output-schema`、`-o`。帮助写明省略 ID 时用 `--last` |
| 拒绝的写法 | `codex exec --ask-for-approval never -h` 退出码 2，提示 unexpected argument。`codex exec resume --sandbox workspace-write -h` 同样退出码 2 |
| 接受的父命令写法 | `codex exec --sandbox workspace-write resume -h` 和 `codex exec --json resume -h` 都退出码 0 并显示 resume 帮助。这只证明帮助解析接受父级 flag，不证明恢复执行时沙箱实际生效 |
| 二进制字符串 | 已安装的 `codex.exe` 含 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started`、`item.updated`、`item.completed`、`agent_message`、`assistant_message`、`command_execution`、`thread_id`、`session_id`。字符串存在不是一份已捕获的 JSONL fixture |

官方非交互说明（https://developers.openai.com/codex/noninteractive）描述了同名 JSONL 事件，但页面没有锁定 0.147.0。在捕获本版本的真实 stdout 之前，事件字段、分块、退出码和终态对应关系都不冻结。

以下结论明确不成立：

- `--version` 或 `--help` 成功不等于已登录、有额度或推理可用。
- 不把 0.147.0 写成已经批准的最低支持版本。它只是本机当前探测到的版本。
- 不使用 `--last`、`--all` 或交互式 `codex resume` 作为产品恢复。
- 不默认添加 `--approve-for-me` 或 `--dangerously-bypass-approvals-and-sandbox`。

## 6. 接口提案

标为“提案”的内容在认领共享后实施。标为“未冻结”的内容必须等第 7 节探针，不能提前写成已支持。

### 6.1 Profile 与调度

提案新增 Profile，而不是只把 Provider 字符串改成 `codex`：

- `provider`：`codex`。历史 `kimi` 记录保持可读，不自动改写。
- `executable`：解析后的原生可执行文件路径。产品启动使用参数数组和 `shell: false`，不拼接 shell 字符串，不直接启动 `.ps1`。
- `args`：只允许模型名，以及沙箱枚举 `read-only`、`workspace-write`。平台拒绝覆盖 prompt、`--json`、`-C`、`-o`、`--output-schema`、`--last`、`--all`、`--ephemeral`、绕过沙箱和本版本不存在的 `--ask-for-approval`。
- `config_version` 与非敏感 `capabilities`。配置正文不保存 token、API key 或登录文件。
- Task 入队时复制 Profile 版本、CLI 版本和非敏感快照。之后编辑 Profile 不影响在途任务。
- Runtime 只认领 Provider 和所需能力都匹配的任务。找不到 Codex 时保留任务并给出原因，不改派 Kimi。

`auth_state` 使用 PRD 的分开状态：`missing`、`unsupported_version`、`auth_not_checked`、`executable`、`run_failed`。帮助成功最多到 `executable`，默认新配置停在 `auth_not_checked`。

### 6.2 执行选项与结果

提案把 Backend 输入从单一 `resume: boolean` 扩成显式会话：

- Kimi 旧任务仍可用现有 `-c`，并且只在已证明是同一工作目录的旧接力中使用。
- Codex 只接受保存过的 session/thread ID。空 ID 表示新会话，不调用 `resume`。
- 新 Task 继续使用 Runner 准备好的独立工作树。恢复会话不能改仓库身份，也不能复用旧的 base 锚点。

`AgentResult.status` 继续区分 `completed`、`failed`、`aborted`、`timeout`、`cancelled`。提案增加原因，而不是新增一个笼统成功：

| 观察 | 提案映射 |
|---|---|
| 进程无法启动 | `failed` + `spawn_failed` |
| 空闲超时 | `timeout` + `idle_timeout` |
| 用户取消 | `cancelled` + `cancelled_by_user` |
| 非零退出 | `failed` + `non_zero_exit` |
| JSONL 损坏、缺少可识别终态，或退出码与协议终态冲突 | `failed` + 新原因 `protocol_error` |
| 需要批准但当前非交互策略不能完成 | `failed` + 新原因 `approval_blocked`；Task 错误面向用户写明阻塞，不无限等待 |

退出码 0、文本里出现“成功”、Report 已提交、Verification 通过、人工批准和远端合入继续是不同事实。`protocol_error` 与 `approval_blocked` 是否沿用 `failed` 状态，等探针确认 CLI 的真实退出和事件后再冻结；本轮只确定不能把它们记成交付成功。

### 6.3 会话归属

`tasks.session_id` 保存探针实际给出的 ID 字段。另外提案一张 ProviderSession：Provider、Profile、Runtime、Task、仓库身份、worktree、session ref。跨 Provider、跨仓库或工作树丢失时拒绝恢复。

T01 的绑定任务会为新 Task 建新工作树。Codex 会话目录如果绑死旧 cwd，显式 ID 仍可能失败。失败时界面提供明确的“新执行”，不自动换成 `--last`，也不加 `--all`。这条兼容行为未冻结，第 7 节专门探针。

### 6.4 Report

两条候选，探针前不取舍：

1. 继续让 Agent 用任务 token 调用现有 delivery-report。只在 `workspace-write` 能访问本次 Server 的 loopback 时采用。
2. 使用 `--output-schema` 与 `-o` 取得有界 JSON，由 Runner 转交现有 Report API。文件内容仍是 Agent Report，Runner 不把它写入 Verification。

两条都不扩大沙箱，都不把 Agent 自述写成实测。缺报告、旧 SHA 和最后一轮复核继续用现有追问上限。complete 响应丢失时重放同一载荷。

### 6.5 取消和权限

执行阶段杀当前 `codex.exe` 进程树；终检阶段只杀终检进程。Node 包装进程退出后不保留旧 PID。单任务错误仍由现有 daemon guard 吞掉。

子进程不接收 daemon token。回调或批准失败不改成 `danger-full-access`。GitHub 凭据剥离已经在 PR #3，汇合前 T02 不依赖那份未合并代码来保证自己的环境过滤；实施时在当前 executor 明确列出禁止进入 Agent 的变量。

## 7. 探针方案

模型、登录或可能消耗额度的命令都尚未运行。证据目录使用本工作树的 `tmp/probes/codex/`。`/tmp/` 已被忽略。保存前去掉 token、Authorization 和绝对登录路径；不提交原始 JSONL。

公共前置：在 `tmp/probes/codex/repo-a` 建立一次性 Git 仓库，不使用 Anvil 仓库，也不使用另一个项目的目录。产品命令使用参数数组启动解析出的 `codex.exe`。下面为了人工复核写成 `codex`，实施时记录实际 exe 和进程树。

### 7.1 JSONL 与完成语义

目的：事件顺序、分块、CRLF、无换行末行、坏 JSON、超长行、thread/session ID、退出码和协议终态。

尚未运行的首条真实命令：

```powershell
codex exec --json --color never --sandbox workspace-write --skip-git-repo-check -C tmp/probes/codex/repo-a -o tmp/probes/codex/jsonl-last.txt "只回复单词 pong。不要运行命令，不要读取配置或认证文件。"
```

输入是这一句固定 prompt。stdout 和 stderr 分开落盘，并记录退出码。期望只作为捕获清单：首个可识别事件提供会话 ID；存在明确的 turn 完成或失败事件；usage 可缺省。退出码 0 但没有可识别成功终态时，记为协议未确认，不能记交付。

同一份已捕获 stdout 再做成 fixture，用分块、CRLF 和末行无换行喂给解析器。未知事件保留有界诊断，不能因此成功。坏 JSON 和超限行产生 `protocol_error`。这一级 fixture 测试不调用模型。

### 7.2 显式恢复

目的：按第 7.1 条实际出现的 ID 恢复；新工作树是否被 cwd 过滤拒绝；失效 ID 的错误。

尚未运行：

```powershell
codex exec --json --color never --sandbox workspace-write -C tmp/probes/codex/repo-a-continue resume <第7.1条捕获的ID> "只回复单词 pong2。不要运行命令。"
```

`repo-a-continue` 是另一个工作树或另一个临时仓库，用来模拟 T01 的新 Task 工作树。期望：恢复的是该 ID；输出新的完成事件；不依赖 `--last`。若 CLI 因目录拒绝，记录原文并在产品中变成可解释的阻塞，再由用户选择新执行。

否定用例不调用模型，只断言产品参数：

- 不含 `--last`、`--all`、交互式 `codex resume`。
- 不把 Kimi 的 `-c` 发给 Codex。
- 失效 ID 使用保留的全零 UUID，只有所有者启动第 7 节后才运行。它可能在报错前接触服务，所以不纳入本轮。

### 7.3 Report

目的：受限回调是否可行；不可行时结构化输出如何转交。

尚未运行，且要分两次授权：

```powershell
codex exec --json --color never --sandbox workspace-write -C tmp/probes/codex/repo-a "不要修改文件。只说明你能否向 127.0.0.1 的指定端口发送一次 HTTP 请求；不要打印任何密钥。"
```

测试端口由本次 Anvil 或一个只监听 loopback 的临时接收端提供，不使用另一个项目的端口。能连通时，正式实现仍走现有 delivery-report，并核对任务 token 没有变成 daemon token。

不能连通时运行schema 探针：准备一份只含 `summary` 和 `head_commit` 的 JSON Schema，执行：

```powershell
codex exec --json --color never --sandbox workspace-write --output-schema tmp/probes/codex/report.schema.json -o tmp/probes/codex/report.json -C tmp/probes/codex/repo-a "按 schema 返回固定测试字段。不要运行命令。"
```

期望：`-o` 文件可解析、有大小上限，且 Runner 只把它当作 Report。Agent 写 `passed` 也不产生 Verification。

### 7.4 取消、超时和权限

尚未运行：

```powershell
codex exec --json --color never --sandbox workspace-write -C tmp/probes/codex/repo-a "运行一个超过 30 秒的本地命令，然后停止。"
```

启动后记录 Anvil 子进程 PID，只对这个 PID 执行进程树终止。期望当前 exe 和它的子进程退出，结果为取消；随后另一个假任务仍可被 daemon 执行。终检取消沿用现有 Verification 进程探针，不新造一套终止逻辑。

批准探针不添加绕过 flag：

```powershell
codex exec --json --color never --sandbox workspace-write -C tmp/probes/codex/repo-a "尝试执行一条通常需要批准的写入命令；如果不能批准，立即停止并说明原因。"
```

若进程挂起，探针自身 60 秒后只终止该进程树，并把结果记为待产品映射的阻塞，不改成自动批准。

权限检查可先用假后端和现有 executor 测试完成：子进程环境没有 daemon token，日志不含该值，失败不会把沙箱改成完全访问。真实 Codex 环境再在第 7.4 条的 stderr 中复核。

## 8. FR 实施顺序

认领进入共享 main 后按这个顺序做完，不在每个 FR 后等待是否继续。真实探针若未获启动授权，先完成不依赖模型输出的代码和自动化，TC12 保持未完成。

| 顺序 | FR | 实现 | 完成判据 |
|---|---|---|---|
| 1 | 契约与 FR03 的解析器 | Core 类型、原因码、JSONL fixture 解析、stderr 限额 | 分块、CRLF、坏行、未知事件和退出码冲突有测试。fixture 来自已授权探针；没有探针时使用临时形状并标明未冻结 |
| 2 | FR01、FR02 | Profile、快照、能力匹配、探测状态、无 Kimi 启动 | 改配置不影响在途任务；保留参数被拒绝；只有 Codex 时 Runner 能注册；缺程序时任务保留且不改派 |
| 3 | FR03、FR06 的进程 | Windows 参数数组、原生 exe、取消和超时 | 中文和空格路径不丢参数；一个任务失败后 daemon 继续；不杀已退出 PID |
| 4 | FR04 | 显式 ID、双仓库拒绝、新执行 | 参数不含 `--last`；错仓库和失效 ID 失败可解释 |
| 5 | FR05 | 选定的 Report 通路、现有追问和终检 | Agent 自述通过但检查失败时为 failed；complete 丢失响应不改发 fail |
| 6 | 最小 UI | 选择 Codex、显示探测状态、执行原因、续作和取消 | 用户不必读 raw JSON。不接管任意已打开的 CLI 会话，不增加远程批准或频道 |
| 7 | TC12 与 J01 准备 | 本地真实任务；联合验收只准备材料和门槛 | 至少 3 个真实 v2 Task、至少一次反馈续作。J01 另行授权 |

不实施 Factory、频道、手机、pi/dsh，也不监控 Anvil 之外已经打开的 CLI 会话。

## 9. 测试映射

用例原文和“未执行”状态仍以 [T02 用例](../tests/tasks/T02-testcases.md) 为准。下表是实施时要新增或扩展的位置。当前一行都还没有测试代码。

| 用例 | 计划位置 | 层级 | 仍须人工的部分 |
|---|---|---|---|
| TC01 | `apps/server/test/agent-profile.test.ts` | 服务集成 | 无。用两个 Profile 和 Runtime fixture |
| TC02 | `apps/runner/test/probe.test.ts`、`apps/web` 的 Agents 页测试 | 进程与 UI | 真实登录和额度只属于 TC12 |
| TC03 | `apps/runner/test/codex-jsonl.test.ts` | 单元 | fixture 必须来自本版本已捕获 stdout，临时形状要标明 |
| TC04 | `apps/runner/test/codex-spawn.test.ts` | Windows 真实进程 | 使用假 exe 或 `.cmd`，不调用模型 |
| TC05 | `apps/runner/test/codex-session.test.ts` | 契约；真实恢复另附 TC12 | 双仓库真实会话不由假 CLI 代替 |
| TC06 | `apps/runner/test/executor.test.ts` | 服务与假 Backend E2E | 无 |
| TC07 | `apps/runner/test/executor.test.ts` | 契约与 E2E | 沿用最多 2 次追问和末轮复核 |
| TC08 | `apps/runner/test/verification.test.ts` | 真实进程与 Git | Agent 文本不作为通过证据 |
| TC09 | `apps/server/test/transaction-anchors.test.ts` | 故障注入 | 无 |
| TC10 | `apps/runner/test/process.test.ts` | 真实进程 | 终检与执行两阶段各测一次 |
| TC11 | `apps/runner/test/executor.test.ts` | 环境与审批替身 | 真实 Codex 的批准事件由第 7.4 条补证据 |
| TC12 | 用例文件的运行记录 | 人工本机验收 | 全部。Kimi、fake CLI 和 help 都不算 |

产品代码完成后的门槛仍是串行 `pnpm test`、`pnpm build`、四包 `tsc --noEmit`。该门槛通过也不把 TC12 或 J01 改成通过。

## 10. 端口、进程和数据隔离

2026-10-17 23:29（UTC+8）前后检查监听：`3100`、`5173`、`43100`、`45173` 都没有 LISTEN。本轮不启动 Anvil，不改端口，不停止任何进程。

当前实现：

| 连接 | 代码 | 默认 |
|---|---|---|
| Server | `apps/server/src/index.ts` 读取 `ANVIL_PORT`，监听 `127.0.0.1` | 3100 |
| 数据库 | 同文件读取 `ANVIL_DB` | 相对路径 `anvil.db` |
| Web | `apps/web/vite.config.ts` 写死 `port: 5173`，没有 `strictPort`，也没有 `host` | 5173 |
| 代理 | 同文件 `/api` 指向 `http://127.0.0.1:3100`，`/ws` 指向 `ws://127.0.0.1:3100` | 3100 |
| Runner | `ANVIL_SERVER_URL` | `http://127.0.0.1:3100` |
| Runner 目录 | `ANVIL_RUNNER_ROOT` | 用户主目录 `.anvil` |

代码没有 `ANVIL_WEB_PORT`。Vite 不会因为只设置 `ANVIL_PORT` 就改变页面和两个代理。`scripts/dev.mjs` 也不注入这些变量。

实施或验收需要启动时：

- Server：`ANVIL_PORT` 若仍空闲就用 3100，否则用 43100。监听保持 `127.0.0.1`。
- Web：与 Server 配套。冲突时用 45173，并设置 `strictPort: true`、`host: "127.0.0.1"`。`/api` 与 `/ws` 同时指向实际 Server。配置直接读启动进程环境；不假设任意 `.env` 已加载。
- Runner：`ANVIL_SERVER_URL=http://127.0.0.1:<实际 Server 端口>`。
- 数据：`ANVIL_DB` 与 `ANVIL_RUNNER_ROOT` 使用本工作树 `tmp/anvil-t02/` 下的绝对路径。不使用仓库里的旧 `anvil.db`，不使用用户主目录 `.anvil`，不读取另一项目或旧实例的 token。
- daemon token 只留在操作者的进程环境，不写入文档、提交或截图。
- 记录本次 Server、Web、Runner 的 PID、端口和关闭命令。只终止这些 PID 的进程树。不结束全部 `node.exe`，不回收全部端口，不改另一个项目或系统代理。
- 验证时同时检查页面、一次 API 调用、一条 WS 更新和 Runner 注册落到同一 Server。只打开页面不够。

Codex 侧：自动化 fixture 使用本工作树 `tmp/probes/codex/home` 作为 `CODEX_HOME`，不复制登录材料。真实模型探针使用操作者已经登录的默认 `CODEX_HOME`，不读取会话文件，不用 `--last` 去连接既有会话。

同机测试：T02 专项可以先跑。完整 `pnpm test`、`pnpm build` 和四包 noEmit 串行，不与另一套 Anvil 全量测试或另一个项目的任务重叠。

## 11. 本轮已验证和未执行

已做：

- 阅读 AGENTS、本机 `.codex/STATUS.md` 与 PITFALLS、CONTRIBUTING、TASKS、COMMON、T02 PRD/交接/用例、T01 交接/用户步骤和 J01。没有使用 superpowers 技能。
- 核对分支、worktree、HEAD、远端 main、PR #2、PR #3 和 T02 认领冲突。
- 重算 T02 PRD blob hash。
- 执行第 5 节列出的版本、帮助和 flag 拒绝检查，并统计已安装 exe 的事件字符串。
- 检查四个候选端口没有监听。
- 建立独立认领工作树并写入本计划、交接和清单。

未做：

- 未运行第 7 节任何模型、登录、额度或真实恢复命令。
- 未启动 Server、Web、Runner，未改端口，未创建数据库。
- 未跑 `pnpm test`、`pnpm build` 或四包 noEmit。历史用例数不计入本轮。
- 未提交、推送、创建 PR 或合并。
- 未执行 T01 TC12 和 J01。

文档检查已在写入后执行：三个变更文件的本地 Markdown 链接 0 个缺失；T02 PRD blob SHA-256 仍是 `5B52E1D811E3C67CCFF2A00D407C875FC0DADAD7BA4B509FD227F4EBB79F16CF`；`git diff --check` 通过。这只证明文档闭合，不证明产品行为。

## 12. 进入完整 T02 开发还缺什么

1. 所有者授权：在本工作树提交这三个文档，推送 `codex/claim-t02`，基于 `main` 创建 PR。授权不包括合并。
2. PR 合入共享 main。合入前出现别人的 T02 认领时，停止并保留现场。
3. 从合入后的最新 main 新建实施分支。届时再看 T01 是否已合入，并重读 executor 差异。
4. 所有者明确启动第 7 节后，才能冻结 JSONL、恢复、Report 和批准行为。未启动时可以先写不依赖真实事件的代码，但不能宣称 TC12 完成。
5. 独立审查人仍待指定。实现完成前不把 Cursor 自审写成独立审查。

不需要恢复 Kimi，也不需要先完成 Factory、频道、手机或外部会话监控。

## 13. 待授权的提交和 PR

建议只暂存：

- `docs/TASKS.md`
- `docs/handoffs/T02.md`
- `docs/plans/T02-codex-adapter.md`

建议提交说明：

```text
docs: 申请认领 T02 并写明 Codex adapter 的实施边界

认领尚未共享，先固定基线、接口提案、探针和隔离方案，避免在未合并的 T01 或图标分支上开始适配。
```

PR 目标分支是 `main`，头分支是 `codex/claim-t02`。建议标题：

```text
docs: 申请认领 T02 Codex adapter
```

建议正文：

```text
仓库所有者开始推进 T02。本变更只登记认领申请、技术拆分、帮助级 CLI 核对和本机隔离方案。共享前不是已认领，合入后才从最新 main 开始写代码。

- 基线是 main@75dfde454f653376c3dac10224e44bc734ee75a0。T02 PRD v1.0 的 SHA-256 未变。
- 当前机器的 Codex CLI 为 0.147.0。版本和帮助不能当作登录、推理或任务可用。
- 不包含业务代码、运行库、token 或模型探针结果。T01 草稿 PR #3、真实 GitHub TC12 和 J01 都不由本 PR 完成。

文档链接、PRD hash 和 diff 检查见计划第 11 节的实际结果。本轮没有重跑产品测试。
```

获得授权后的操作只有这三项：在认领工作树按文件暂存并提交、`git push -u origin codex/claim-t02`、`gh pr create --base main --head codex/claim-t02`。不合并，不改分支保护，不推 main。
