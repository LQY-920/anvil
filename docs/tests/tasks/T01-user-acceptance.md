# T01 用户测试步骤

需求：[T01 PRD](../../prds/T01-git-github.md)。此页用于整个板块交付后的真实账号验收；自动化使用真实临时 Git 和 GitHub 接口替身，尚未代替这次验收。

## 启动

1. 在本机终端确认 `git --version`、`gh --version`，使用 `gh auth login` 登录自己有推送权限的 GitHub 试验仓库账号。不需要把 token 填进 Anvil。
2. 按仓库 README 启动 Server、Web、Runner。Server 保持 127.0.0.1；当前人类入口没有远程认证。
3. 在“仓库”页选择 GitHub PR，填写 HTTPS/SSH 仓库地址，可指定已有本地 checkout 和目标分支；留空 checkout 时由 Server 建缓存。查看登录名、目标分支、连接与推送权限。

如升级已有数据，先停机备份 SQLite 及 WAL/SHM，再启动自动迁移。新功能在 `codex/t01-git-github` / PR #3；不要用仍未合入的 main 误测旧界面。

要测试正常批准，请在派发前把有效的 `ANVIL.verify.json` **提交到所选目标分支**，GitHub 模式还需推送该准备提交。例如已有 `pnpm test` 的试验项目可使用：

```json
{
  "version": 1,
  "commands": [
    { "id": "tests", "label": "项目测试", "command": "pnpm test", "required": true, "timeout_ms": 600000 }
  ]
}
```

命令须换成试验项目实际存在的测试命令，并确保 Runner 的任务工作树具备所需依赖。也可参考本仓库的 [完整配置](../../../ANVIL.verify.json)。Runner 只读取本次冻结基线中的策略，未提交或任务中新增的配置不会改变本次验证。没有配置会显示 `not_configured`，普通批准不可用；格式错误是 `invalid_policy` 完整性阻塞，不能质量覆盖。

## GitHub 主流程

1. 在试验仓库创建一条小 Issue，回 Anvil 填它的编号导入。应只进入收集箱，不自动运行。
2. 打开 Issue 配置，在“执行 Agent”选择已上线的执行器，点“保存并重新执行”。当前执行器仍是 Kimi；T02 Codex 接入另行开发，未配置可用执行器时可先测试绑定、导入与来源同步，执行至交付的产品验收需有可用 backend。
3. 完成后检查固定 base/head、交付报告、Runner 验证、来源版本。
4. 可先“创建或关联 PR”到 GitHub 审阅。该动作不等于批准，也不产生有效裁决计时；源代码/原始日志不会自动写入 PR 正文。
5. 回 Anvil 提交真实裁决。验证通过可批准；failed/partial/not_configured 只能填写理由并二次确认质量覆盖。SHA、仓库、目标、dirty、缺报告等完整性问题不能覆盖。
6. 到 GitHub 手动合入 PR，等待轮询或手动刷新。Anvil 核对批准 head、PR merged 与 merge commit 在目标分支可达后才标完成；支持 squash/rebase 的合并提交与任务 head 不相同。

## 返工和异常

- 拒绝并填写理由：产生新 Task，原 Decision 不变。开放 PR 的新 Task 使用新工作树承接原提交，以非强推更新同一 PR；旧 Task/SHA/裁决仍可追溯。
- 来源 Issue 内容变化：刷新只提示 accepted/latest 差异；点“接受最新来源用于新任务”后再明确新执行，旧 Task 输入保持不变。
- 目标分支前进：看到 base_advanced 后明确新执行；不会把旧验证变成新验证。
- prepared、失败、unknown：从最近一次操作的“查询并恢复操作”继续。平台先查事实，记录新 Attempt，不重复批准、不清理现场。已成功恢复的旧尝试只有历史记录。
- 关闭 PR 但未合入：Anvil 保持未完成。权限或网络问题会显示旧事实和退避时间；不要通过旧 merge 入口绕过。
- 纯本地仓库：交付模式选择“本地 Git”，绑定 checkout 事先切到目标分支且保持工作区干净，裁决后点“执行本地交付”；只合入明确目标工作区，不自动推送远端。

验收时记录真实仓库/Issue/PR URL、Task ID、base/head、Runner 验证与 Decision、同步结果到 [T01 测试记录](T01-testcases.md)；不要记录凭据。产品验收确认后再决定合并/发布。
