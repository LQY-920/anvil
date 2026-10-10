# Runner 基线终检测试用例

> 来源：锁定 PRD FR-001 AC 3–12；实施计划 A06。
> 日期：2026-10-05。范围：Runner、真实临时 Git 仓库、真实验证子进程、内存 Server；没有页面改动。
> 前置环境：Windows、Git、Node、pnpm 与项目依赖已安装。所有凭据测试使用合成数据，未读取用户凭据文件。

## 用例列表

### TC-Verification_001 读取策略_任务修改策略_仍执行基线命令
- 优先级: P0 | 类型: 接口
- 测试数据: 基线命令 exit(7)，任务分支替换成 exit(0) 并提交。
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/verification.test.ts -t '从基线读取'`。
- 预期结果: failed，exit_code=7；policy_hash 等于包含原始换行的基线文件 SHA-256。
- 执行结果: ✅ 通过。

### TC-Verification_002 执行验证_全部必选通过_记录真实证据
- 优先级: P0 | 类型: 接口
- 测试数据: 两条输出不同文本的 required 命令。
- 测试步骤:
  1. 执行 verification 专项中“依次执行 required”用例。
- 预期结果: 两条均 exit_code=0，状态 passed；记录文本、非负耗时、合法开始/完成时间及完整验证 SHA。
- 执行结果: ✅ 通过。

### TC-Verification_003 执行验证_可选失败_继续必选命令
- 优先级: P1 | 类型: 接口
- 测试数据: optional exit(2)，后续 required exit(0)。
- 测试步骤:
  1. 执行 verification 专项中“optional 失败”用例。
- 预期结果: 后续检查执行并通过，整体 partial。
- 执行结果: ✅ 通过。

### TC-Verification_004 读取策略_缺失与损坏_明确区分状态
- 优先级: P0 | 类型: 接口
- 测试数据: 无文件、非法 JSON、version=2、9 条命令、不存在的基线 SHA。
- 测试步骤:
  1. 执行 verification 专项中“缺策略”“拒绝无效策略”“无效基线”用例。
- 预期结果: 无文件为 not_configured，started_at/verification_sha 为 null；非法策略 failed/invalid_policy 且不执行部分命令；Git 读取错误 failed/verification_error。
- 执行结果: ✅ 通过。

### TC-Verification_005 核对工作区_验证前后变脏_拒绝通过
- 优先级: P0 | 类型: 接口
- 测试数据: 验证前有未跟踪文件；或命令创建未跟踪文件。
- 测试步骤:
  1. 执行 verification 专项中“验证前 dirty”“验证产生未跟踪文件”用例。
- 预期结果: 均为 dirty；验证前 dirty 时所有检查 skipped，不创建命令中的目标文件。
- 执行结果: ✅ 通过。

### TC-Verification_006 核对版本_验证期间提交_证据过期
- 优先级: P0 | 类型: 接口
- 测试数据: 验证命令创建一个新 commit。
- 测试步骤:
  1. 执行 verification 专项中“验证提交新 HEAD”用例。
- 预期结果: stale，verification_sha 保留开始版本，最终 headCommit 为新版本，worktreeClean=true。
- 执行结果: ✅ 通过。

### TC-Verification_007 限制执行_超时或启动失败_失败收敛
- 优先级: P0 | 类型: 接口
- 测试数据: 1000ms 超时的常驻进程；不存在的 cwd。
- 测试步骤:
  1. 执行 verification 专项中“超时终止”“spawn 失败”用例。
- 预期结果: 超时检查 timed_out 且后续 skipped；spawn 失败为 failed/exit_code=null，包含 spawn_failed；不会外抛到 daemon。
- 执行结果: ✅ 通过。

### TC-Verification_008 终止进程_包含孙进程_整棵进程树退出
- 优先级: P0 | 类型: 接口
- 测试数据: Node 进程启动常驻子进程并输出 PID。
- 测试步骤:
  1. 执行 `pnpm --filter @anvil/runner test test/process.test.ts`。
- 预期结果: force kill 后父进程和子进程均不存在；既有 CLI watchdog/主动取消仍通过。
- 执行结果: ✅ Windows 真实进程通过；POSIX 进程运行尚未在本机验证。

### TC-Verification_009 取消验证_执行前与执行中_不继续上报终态
- 优先级: P0 | 类型: 接口
- 测试数据: 预先 abort；长命令执行中 abort；Server 任务取消。
- 测试步骤:
  1. 执行 verification 专项中两条“取消”用例及 executor 的“A06: 终检中取消”用例。
- 预期结果: 不启动后续检查；活跃验证进程被终止；executor 不发送 complete/fail，不再 kill 已退出 Agent 的旧 PID；Server 保持 cancelled。
- 执行结果: ✅ 通过。

### TC-Verification_010 处理输出_敏感值与编码边界_脱敏且有界
- 优先级: P0 | 类型: 接口
- 测试数据: 分块输出合成 secret；中文长文本；非法 UTF-8；8 条大量需要 JSON 转义的输出。
- 测试步骤:
  1. 执行 verification 专项中“脱敏跨块”“非法 UTF8”“总 JSON 载荷”用例。
- 预期结果: stdout/stderr/command 不含完整 secret；合法中文不截坏，非法字节替换；每条摘录 ≤8192 字节，整个 Verification JSON ≤65536 字节。
- 执行结果: ✅ 通过。

### TC-Verification_011 构造环境_凭据及普通别名_子进程拿不到秘密
- 优先级: P0 | 类型: 接口
- 测试数据: 合成 ANVIL_TOKEN、ANVIL_DAEMON_TOKEN、OPENAI_API_KEY、包含 secret 的普通变量及正常 KEEP。
- 测试步骤:
  1. 执行 verification 专项中“剔除凭据变量”和“真实子进程继承普通环境”用例。
- 预期结果: 普通变量保留；凭据变量及包含已知 secret 的别名剔除；真实子进程不能输出它们的原值。
- 执行结果: ✅ 通过。

### TC-Verification_012 选择执行器_平台及缓存策略_遵守调用契约
- 优先级: P1 | 类型: 单元与接口
- 测试数据: Windows 含空格/中文路径；POSIX 平台参数；预加载策略后修改当前策略文件。
- 测试步骤:
  1. 执行 verification 专项中“平台 shell”“预先加载的策略”用例。
- 预期结果: Windows 系统 cmd.exe /d /s /c 和 verbatim 参数正确，POSIX 为 /bin/sh -lc；预加载策略不受任务文件变更影响。
- 执行结果: ✅ 参数契约与 Windows 执行通过；未声称已执行 Linux/macOS 实机测试。

### TC-Verification_013 完成任务_报告已交付但验证失败_保留真实结论
- 优先级: P0 | 类型: 接口
- 测试数据: Agent commit 并提交有效 Report，基线验证 exit(7)。
- 测试步骤:
  1. 执行 executor 的“A06: Agent 已提交 Report”用例。
- 预期结果: 仅执行一次 Agent，不追加修复轮次；complete 带 failed 证据、真实 SHA/退出码；无 undelivered；Server result_json 保存失败，不把机器验证失败混为 Agent 运行失败。
- 执行结果: ✅ 通过。

### TC-Verification_014 完成任务_终检之后版本变化_上报最新事实
- 优先级: P0 | 类型: 接口
- 测试数据: 真终检 passed 后、complete 前追加一个 commit。
- 测试步骤:
  1. 执行 executor 的“A06: 终检后 HEAD 又推进”用例。
- 预期结果: 上报 stale，head_commit 与 verification_sha 不同；固定 diff 包含最后一次 commit 的文件。
- 执行结果: ✅ 通过。

## 需求覆盖矩阵

| 需求 | 用例 |
|---|---|
| 基线不可弱化、策略合法性 | 001、004、012 |
| 串行检查与状态派生 | 002、003、005、006、013、014 |
| 超时、进程树、取消、异常收敛 | 007、008、009 |
| UTF-8、脱敏、8KB/64KB、环境剥离 | 010、011 |

## 执行汇总与审查

- 上述 14 个场景均已由自动化测试执行通过。A06 初始红灯为 verification 模块缺失；模块完成后专项 94 条通过，随后新增的最终 Git 事实回归 3 条通过。
- 最终门槛：`pnpm test` 36 文件 / 738 用例通过（core 161、server 313、runner 208、web 56）；`pnpm build` 及四包 `tsc --noEmit` 通过；`git diff --check` 通过。
- 运行日志：`tmp/codex-20261005-a06-tests-final.log`、`tmp/codex-20261005-a06-build.log`。Vite 保留既有 node:crypto/node:path 浏览器 externalized 提示，本轮没有改动相关导出。
- 已修复验证中发现的问题：原有脱敏测试误判随机 UUID（101 条专项通过）；Runner 真 Git 并发超过默认 5 秒并污染后续 mock，因此仅将 runner 测试并发限制为 2，没有放宽断言或默认超时。
- 契约自审：检查 PRD FR-001 的策略来源、环境、状态、输出和取消边界；`VerificationRun.error_code` 为补齐 PRD 中 invalid_policy 的最小类型扩展。
- 代码自审：检查进程取消入口、旧 PID、最大输出、最终 HEAD 与 diff 绑定、v1 路径及 complete 回执不确定语义。两段均由本次 Codex 自审，不冒充独立复审。
- root 策略只表达已有合并门槛。新增的 package.json 测试并发设置属于稳定执行这些真实 Git 回归的必要配套；没有引入产品依赖。
- A07 的专表事务与服务端证据一致性校验、A08 计时、R2 真实 dogfood 尚未完成。临时仓库和 fake Agent 的自动化测试不计入真实 dogfood。
