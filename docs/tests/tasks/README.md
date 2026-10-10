# 六项任务的测试用例与执行记录

日期：2026-10-10。各文件已生成 v1.0 测试用例初稿，所有用例均为“未执行”；这不是自动化代码，也不是通过报告。认领后按实现设计补 fixture、命令与精确输入，评审用例，再实施并执行。

每条用例保留 ID、对应 FR、前置条件、步骤、预期结果、执行状态；可补自动化测试位置。运行记录追加代码 SHA、PRD/用例版本、环境、CLI 版本（如适用）、日期、执行人、真实命令/步骤、结果和脱敏证据链接。

允许状态：未执行、通过、失败、阻塞、不适用（须理由及验收人认可）。修改需求后受影响用例重新待测，不删除旧失败与修复记录。没有工具调用或真人操作证据，不填写“已测”。

真实推理、GitHub 写入、手机远程访问均须在对应明确环境/授权范围内进行；本次文档任务没有执行它们。fake、故障注入、真实 CLI、真人验收分开记录。

| 文件 | 对应 PRD | 当前状态 |
|---|---|---|
| [T01](T01-testcases.md) | [Git/GitHub](../../prds/T01-git-github.md) | 初稿，未执行 |
| [T02](T02-testcases.md) | [Codex](../../prds/T02-codex-adapter.md) | 初稿，未执行 |
| [T03](T03-testcases.md) | [Factory](../../prds/T03-factory-workflow.md) | 初稿，未执行 |
| [T04](T04-testcases.md) | [频道线程](../../prds/T04-channels-threads.md) | 初稿，未执行 |
| [T05](T05-testcases.md) | [手机](../../prds/T05-mobile-access.md) | 初稿，未执行 |
| [T06](T06-testcases.md) | [更多 Agent](../../prds/T06-agent-providers.md) | 初稿，未执行 |
