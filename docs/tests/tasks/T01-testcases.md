# T01 · Git/GitHub测试用例

版本：1.0；初稿日期：2026-10-10；实施补记：2026-10-13。S1 已有真实 Git、迁移、接口与 UI 自动化；完整 12 场景尚未验收。  
依据：对应 [PRD](../../prds/T01-git-github.md) v1.0 · [交接记录](../../handoffs/T01.md) · [填写规则](README.md)

下表保留完整场景要求，实际子场景覆盖与运行结果另列。真实外部写入仅在明确授权的试验仓库执行，凭据由操作者自行配置，不写入证据。分段与审查记录见 [技术拆分](../../plans/T01-git-github.md)；12 条场景目录和 PRD v1.0 的验收要求不变。

## 用例清单

| ID / 需求 | 场景 / 方式 | 前置条件 | 执行步骤 | 预期结果 | 当前结果 |
|---|---|---|---|---|---|
| T01-TC01；T01-FR01 | 仓库身份与绑定；服务集成 | 受控仓库，SSH/HTTPS 两种地址 | 分别绑定同一仓库；模拟重命名及不同 host 同名仓库 | 同仓唯一；跨 host 不误合并；重命名要求确认 | 未执行 |
| T01-TC02；T01-FR01 | 连接权限与脱敏；接口/进程 | 替身连接有/无写权限 | 查询连接；尝试受限写入；检查日志与 Agent 环境 | 权限不足阻塞；不输出连接凭据、不传给 Agent | 未执行 |
| T01-TC03；T01-FR02 | Issue 导入与来源变更；服务集成 | 选定外部 Issue | 重复导入；运行后修改上游正文、关闭 Issue | 唯一映射且不派活；保留运行快照并提示变更；外部关闭不代表本地通过 | 未执行 |
| T01-TC04；T01-FR03 | 固定 Diff 与对象缺失；真实 Git | 临时 Git 仓库，固定 base/head | 移动浮动分支后读取 Diff；移除可用对象/锚点后再读 | 仍比较固定 SHA；缺对象明确失败，不回退 merge-base | S1 部分通过；持久原始仓库身份仍待 S2 |
| T01-TC05；T01-FR03 | 完整性 Gate；真实 Git/并发 | 有 Report/Verification 的 Task | 分别制造 dirty、HEAD 改动、错误仓库/目标、base 前进、缺报告 | 普通及覆盖批准均拒绝完整性问题；历史验证保留；锁不会跨人工等待 | S1 部分通过；完整 Gate/覆盖/跨进程锁待实现 |
| T01-TC06；T01-FR03、T01-FR04 | 质量覆盖与裁决唯一；服务集成 | 分别为 failed/partial/not_configured 验证 | 普通批准；无理由覆盖；有理由二次确认覆盖；重放同请求与改换裁决 | 普通批准和无理由覆盖拒绝；明确覆盖留审计；一 Task 一权威 Decision；同请求返回原结果、不同裁决冲突 | 未执行 |
| T01-TC07；T01-FR04 | 阻止 GitHub 旧直推；API 回归 | github_pr 模式，含旧 v1 Task | 调用新/旧 merge 路由及相关历史入口 | 所有 GitHub 直推旁路拒绝；不会管理员绕过；历史数据仍可读 | 未执行 |
| T01-TC08；T01-FR04 | 纯本地合入；真实 Git | local_git 仓库且 Gate 满足 | 执行批准及本地合入；故意切错目标工作区；模拟并发 Git 操作 | 只在准确工作区安全操作；决定与 Attempt 分离；错目标阻塞；锁范围正确 | S1 部分通过；正式 Decision 与共享锁待实现 |
| T01-TC09；T01-FR05 | 远端失败与未知结果；故障注入 | push/PR 替身可丢响应 | 模拟 push 拒绝、PR 创建成功但响应丢失；重试操作 | 不误 done、不清现场；先查远端，关联同一 PR，不重跑 Agent | S1 部分通过；PR 查询恢复尚未实现 |
| T01-TC10；T01-FR05 | 返工/合入状态；API/真实 Git | 关联 PR 和批准 head | 改变 PR head；关闭未合入；分别模拟 squash/rebase merged | 新 head 旧批准无效；关闭不 done；核对批准 head/目标/merged/merge commit 可达，不强求 merge commit=head | 未执行 |
| T01-TC11；T01-FR06 | 同步与计时语义；UI/服务 | 旧事件、限流替身、现有计时数据 | 重复轮询、断网恢复、打开 PR、提交裁决 | 显示更新时间/过期并退避；重复无写副作用；只打开 PR 不产生有效裁决测量 | 未执行 |
| T01-TC12；T01-FR01、T01-FR02、T01-FR03、T01-FR04、T01-FR05、T01-FR06 | 真实 GitHub 闭环；真实外部验收 | 明确获授权的测试仓库；可用 fake backend | 导入一条选定 Issue，执行、查看证据、建 PR、人工审查/合入、刷新 Anvil | 记录实际 URL/Task/SHA/证据/远端结果；失败不造成功；fake 不算 Codex 真样本 | 未执行 |

## 自动化映射

2026-10-13 需求/设计审查补充断言：TC04 区分 v1/v2，检查固定 SHA 与 commit 对象；TC05 覆盖核对后到操作前的竞态和跨进程锁；TC07 覆盖模式切换后的旧 v1 入口；TC09 检查实际本地 Git 状态、持久化未知结果、重启/并发重复请求；TC10 覆盖多个候选 PR 与旧 Decision 不可改写；TC03 确认外部正文/评论不派活。具体实现与结果以下表为准。

S1 覆盖 TC04、TC05、TC08、TC09 的部分子场景；持久原始仓库身份、正式裁决、共享 Git 锁、PR 响应丢失和自动恢复仍须后续阶段，不将部分通过写成整条通过。

S1 自动化映射如下；临时 file:// bare Git 不是 GitHub 验收样本。

| 用例 ID | 自动化文件 / 测试名 | 覆盖范围 / 剩余人工项 | 状态 |
|---|---|---|---|
| TC04 | [review-v2.test.ts](../../../apps/server/test/review-v2.test.ts)：固定 SHA、缺锚点/对象、错仓库、中文截断、refs/replace；[git-repository.test.ts](../../../apps/server/test/git-repository.test.ts) | 真实 Git/worktree + daemon start/report/complete；旧 v1 在 review.test.ts；整体替换的原始身份待 S2 | S1 子场景通过 |
| TC05、TC08 | review-v2.test.ts：成功合入父提交、目标/任务前进、旧 Report、真实失败 Verification；[review.test.ts](../../../apps/server/test/review.test.ts)：既有 Git 操作、并发请求 | 保留原始证据；没有 Decision、质量覆盖或 Runner 共用锁 | S1 子场景通过 |
| TC09 | review.test.ts：push 失败/重启/换键、Git 后 SQLite 失败；[integration-attempts.test.ts](../../../apps/server/test/integration-attempts.test.ts) | 真实 Git、两个 SQLite 连接和落盘重启；结果未知保守阻塞，不含 PR 查询恢复 | S1 子场景通过 |
| 跨用例迁移/界面回归 | [integration-attempts-migration.test.ts](../../../apps/server/test/integration-attempts-migration.test.ts)、[task-panel.test.tsx](../../../apps/web/test/task-panel.test.tsx)、[api-error.test.ts](../../../apps/web/test/api-error.test.ts) | 真实 0003 升级保留 v1/v2/Report/计时；固定 SHA、历史文案、恢复阻塞；连接/PR UI 仍待实现 | S1 子场景通过 |
| TC01–03、TC06–07、TC10–12 | 尚无完整覆盖 | Repository/权限、来源、Decision/PR、同步、真实 GitHub 验收 | 未执行 |

## 运行记录（每轮追加，不覆盖失败历史）

完整场景通过 0/12；S1 部分覆盖 4 条，其余 8 条未执行。下面的自动化条数不等于完整场景通过数，失败记录保留。

| 日期 / 执行人 | 代码 SHA / PRD 版本 | 环境 / CLI 版本 | 用例 / 命令或步骤 | 通过 / 失败 / 未测 | 证据 / 缺陷 |
|---|---|---|---|---|---|
| 2026-10-13 主 Codex，首轮 | b0244cb + 当时未提交 S1 / 1.0 | Windows；Node 22.18.0；Git 2.50.1.windows.1；pnpm 10.0.0 | server test：integration-attempts、integration-attempts-migration、db、review | 34 通过 / 3 失败 | 三个错误路径返回 500；后续 noEmit TS2305 定位错误导入，已修正 |
| 2026-10-13 主 Codex，修复复测 | 8ae0224 + 当时未提交 S1 / 1.0 | 同上 | server test：review、review-v2；web test：task-panel、api-error、review-measurement-api | 18/18 + 30/30 | 错误路径恢复 409，固定 Diff 与 UI 通过 |
| 2026-10-13 主 Codex，审查修复 | 8ae0224 + 当时未提交 S1 / 1.0 | 同上 | server test：review、integration-attempts | 26/26 | 保留未结束合并；Basic 在首次 HTTP、重放与 DB 均脱敏 |
| 2026-10-13 主 Codex，补充 v2 合入 | 12233fa + 当时未提交 S1 / 1.0 | 同上 | server test：review-v2 | 11/11 | v2 真实完成、固定提交合入/幂等、拒绝漂移与失败证据、refs/replace 防护 |
| 2026-10-13 主 Codex，S1 全量门槛 | bee982a / 1.0 | 同上 | 串行：pnpm test → pnpm build → 四包 pnpm exec tsc --noEmit -p tsconfig.json | 46 文件 / 903 用例全部通过；build / 四包 noEmit 通过 | Core 161、Server 441、Runner 211、Web 90；本机日志 tmp/t01-full-test.log、tmp/t01-build.log；无运行库或外部 GitHub 产品写入 |

S1 全量门槛已通过；Vite 仍提示 Core 的 node:crypto/node:path 浏览器 externalization（基线已有），构建退出码 0。后续代码改动须重新完成相应验证；文档链接检查不计作产品用例通过。

## 验收记录

产品验收人：仓库所有者，尚未执行。独立静态代码审查：implementation_audit；首轮问题修复后复核无新增 S1 必修项，未将静态审查冒充独立测试或完整产品验收。所有首期 FR 与真实场景仍待完整验收。
