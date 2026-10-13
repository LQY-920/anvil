# T01 · Git/GitHub测试用例

版本：1.0；初稿日期：2026-10-10；实施补记：2026-10-13。S1–S4 已有真实 Git、迁移、GitHub 替身、接口与 UI 自动化；真实账号 TC12 与所有者产品验收尚未执行。  
依据：对应 [PRD](../../prds/T01-git-github.md) v1.0 · [交接记录](../../handoffs/T01.md) · [填写规则](README.md)

下表保留完整场景要求，实际子场景覆盖与运行结果另列。真实外部写入仅在明确授权的试验仓库执行，凭据由操作者自行配置，不写入证据。分段与审查记录见 [技术拆分](../../plans/T01-git-github.md)；12 条场景目录和 PRD v1.0 的验收要求不变。

## 用例清单

| ID / 需求 | 场景 / 方式 | 前置条件 | 执行步骤 | 预期结果 | 当前结果 |
|---|---|---|---|---|---|
| T01-TC01；T01-FR01 | 仓库身份与绑定；服务集成 | 受控仓库，SSH/HTTPS 两种地址 | 分别绑定同一仓库；模拟重命名及不同 host 同名仓库 | 同仓唯一；跨 host 不误合并；重命名要求确认 | 已自动化覆盖身份/改名/地址别名；真实账号见 TC12 |
| T01-TC02；T01-FR01 | 连接权限与脱敏；接口/进程 | 替身连接有/无写权限 | 查询连接；尝试受限写入；检查日志与 Agent 环境 | 权限不足阻塞；不输出连接凭据、不传给 Agent | 客户端/权限/环境回归已实现，最终全量通过 |
| T01-TC03；T01-FR02 | Issue 导入与来源变更；服务集成 | 选定外部 Issue | 重复导入；运行后修改上游正文、关闭 Issue | 唯一映射且不派活；保留运行快照并提示变更；外部关闭不代表本地通过 | 来源/快照/调度自动化已实现，最终全量通过 |
| T01-TC04；T01-FR03 | 固定 Diff 与对象缺失；真实 Git | 临时 Git 仓库，固定 base/head | 移动浮动分支后读取 Diff；移除可用对象/锚点后再读 | 仍比较固定 SHA；缺对象明确失败，不回退 merge-base | 固定 Diff 与原始仓库身份自动化已实现，最终全量通过 |
| T01-TC05；T01-FR03 | 完整性 Gate；真实 Git/并发 | 有 Report/Verification 的 Task | 分别制造 dirty、HEAD 改动、错误仓库/目标、base 前进、缺报告 | 普通及覆盖批准均拒绝完整性问题；历史验证保留；锁不会跨人工等待 | Gate/竞态/跨进程锁自动化已实现，最终全量通过 |
| T01-TC06；T01-FR03、T01-FR04 | 质量覆盖与裁决唯一；服务集成 | 分别为 failed/partial/not_configured 验证 | 普通批准；无理由覆盖；有理由二次确认覆盖；重放同请求与改换裁决 | 普通批准和无理由覆盖拒绝；明确覆盖留审计；一 Task 一权威 Decision；同请求返回原结果、不同裁决冲突 | 服务与 UI 自动化已实现，最终全量通过 |
| T01-TC07；T01-FR04 | 阻止 GitHub 旧直推；API 回归 | github_pr 模式，含旧 v1 Task | 调用新/旧 merge 路由及相关历史入口 | 所有 GitHub 直推旁路拒绝；不会管理员绕过；历史数据仍可读 | 历史 v1/v2、独立 clone 与改名旧地址自动化已实现 |
| T01-TC08；T01-FR04 | 纯本地合入；真实 Git | local_git 仓库且 Gate 满足 | 执行批准及本地合入；故意切错目标工作区；模拟并发 Git 操作 | 只在准确工作区安全操作；决定与 Attempt 分离；错目标阻塞；锁范围正确 | 实际父提交/独立裁决/故障恢复自动化已实现 |
| T01-TC09；T01-FR05 | 远端失败与未知结果；故障注入 | push/PR 替身可丢响应 | 模拟 push 拒绝、PR 创建成功但响应丢失；重试操作 | 不误 done、不清现场；先查远端，关联同一 PR，不重跑 Agent | PR 丢响应/多候选/终态恢复与 UI 自动化已实现 |
| T01-TC10；T01-FR05 | 返工/合入状态；API/真实 Git | 关联 PR 和批准 head | 改变 PR head；关闭未合入；分别模拟 squash/rebase merged | 新 head 旧批准无效；关闭不 done；核对批准 head/目标/merged/merge commit 可达，不强求 merge commit=head | 自动化覆盖返工、squash 与不可达；真实 rebase 操作待 TC12 |
| T01-TC11；T01-FR06 | 同步与计时语义；UI/服务 | 旧事件、限流替身、现有计时数据 | 重复轮询、断网恢复、打开 PR、提交裁决 | 显示更新时间/过期并退避；重复无写副作用；只打开 PR 不产生有效裁决测量 | 服务与 UI 自动化已实现，最终全量通过 |
| T01-TC12；T01-FR01、T01-FR02、T01-FR03、T01-FR04、T01-FR05、T01-FR06 | 真实 GitHub 闭环；真实外部验收 | 明确获授权的测试仓库；可用 fake backend | 导入一条选定 Issue，执行、查看证据、建 PR、人工审查/合入、刷新 Anvil | 记录实际 URL/Task/SHA/证据/远端结果；失败不造成功；fake 不算 Codex 真样本 | 未执行 |

## 自动化映射

2026-10-13 需求/设计审查补充断言：TC04 区分 v1/v2，检查固定 SHA 与 commit 对象；TC05 覆盖核对后到操作前的竞态和跨进程锁；TC07 覆盖模式切换后的旧 v1 入口；TC09 检查实际本地 Git 状态、持久化未知结果、重启/并发重复请求；TC10 覆盖多个候选 PR 与旧 Decision 不可改写；TC03 确认外部正文/评论不派活。具体实现与结果以下表为准。

以下为完整实现的自动化映射；临时 bare Git、注入 GitHubClient 的服务/HTTP 测试不是外部 GitHub 验收样本。场景目录还包含真实账号/人工操作，自动化条数不能直接换算为 12 条产品验收通过。

| 用例 ID | 自动化文件 / 测试名 | 覆盖范围 / 剩余人工项 | 状态 |
|---|---|---|---|
| TC01–03 | [github-client.test.ts](../../../apps/server/test/github-client.test.ts)、[github-integration.test.ts](../../../apps/server/test/github-integration.test.ts)、[repository-snapshots.test.ts](../../../apps/server/test/repository-snapshots.test.ts) | 地址/权限/限流/脱敏、导入幂等不派工、accepted/latest、排队及重试输入冻结 | 最终全量通过 |
| TC04–05 | [review-v2.test.ts](../../../apps/server/test/review-v2.test.ts)、[git-repository.test.ts](../../../apps/server/test/git-repository.test.ts)、[bound-worktree.test.ts](../../../apps/runner/test/bound-worktree.test.ts)、[git-lock.test.ts](../../../packages/core/test/git-lock.test.ts) | 真实固定 SHA/对象/身份/dirty/基线/Report；活进程锁不可抢、死进程恢复；改名与 URL 重写；临界操作竞态 | 最终全量通过 |
| TC06、TC08 | review-v2.test.ts、[integration-panel.test.tsx](../../../apps/web/test/integration-panel.test.tsx) | 独立 Decision、理由/二次确认、完整性不可覆盖、同键幂等、真实本地 merge/数据库失败恢复、不误完成新 Task | 最终全量通过 |
| TC07 | [review.test.ts](../../../apps/server/test/review.test.ts)、review-v2.test.ts | v1 绑定、v2、独立 clone、旧 GitHub 地址旁路；保留历史读能力 | 最终全量通过 |
| TC09–10 | github-integration.test.ts、review-v2.test.ts、[integration-attempts.test.ts](../../../apps/server/test/integration-attempts.test.ts) | bare Git + 替身 GitHub 的真实 HTTP/Gate；push/PR 响应丢失、多候选、终态/分支删除恢复、不同 Task 分支复用 PR、批准 head/merged/目标可达 | 真实 IO 预算修正后最终全量通过；真实 rebase 留用户验收 |
| TC11 / Web | integration-panel.test.tsx、[repositories.test.tsx](../../../apps/web/test/repositories.test.tsx)、[issue-settings.test.tsx](../../../apps/web/test/issue-settings.test.tsx)、[executor.test.ts](../../../apps/runner/test/executor.test.ts) | 轮询退避/状态，来源、裁决/PR 分离、测量语义、prepared 恢复、指派只派一次、连接环境不进入 Agent | 最终全量通过 |
| 迁移/历史回归 | [repository-migration.test.ts](../../../apps/server/test/repository-migration.test.ts)、[integration-attempts-migration.test.ts](../../../apps/server/test/integration-attempts-migration.test.ts)、[task-panel.test.tsx](../../../apps/web/test/task-panel.test.tsx) | 真实旧 schema 升级/重复 migrate、nullable 快照、唯一约束；不回填 v1 证据、报告或测量 | 自动化已实现，最终全量通过 |
| TC12 | [用户测试步骤](T01-user-acceptance.md) | 用户选定真实试验仓库后记录 Issue/PR/Task/SHA/人工裁决与同步；fake 不算 Codex 真样本 | 未执行 |

## 运行记录（每轮追加，不覆盖失败历史）

S1 部分覆盖 4 条是历史记录；当前 TC01–11 的自动化覆盖见上表，产品验收与 TC12 待所有者执行。下面保留每轮自动化的真实结果，不将静态审查或专项复测冒充全量通过。

| 日期 / 执行人 | 代码 SHA / PRD 版本 | 环境 / CLI 版本 | 用例 / 命令或步骤 | 通过 / 失败 / 未测 | 证据 / 缺陷 |
|---|---|---|---|---|---|
| 2026-10-13 主 Codex，首轮 | b0244cb + 当时未提交 S1 / 1.0 | Windows；Node 22.18.0；Git 2.50.1.windows.1；pnpm 10.0.0 | server test：integration-attempts、integration-attempts-migration、db、review | 34 通过 / 3 失败 | 三个错误路径返回 500；后续 noEmit TS2305 定位错误导入，已修正 |
| 2026-10-13 主 Codex，修复复测 | 8ae0224 + 当时未提交 S1 / 1.0 | 同上 | server test：review、review-v2；web test：task-panel、api-error、review-measurement-api | 18/18 + 30/30 | 错误路径恢复 409，固定 Diff 与 UI 通过 |
| 2026-10-13 主 Codex，审查修复 | 8ae0224 + 当时未提交 S1 / 1.0 | 同上 | server test：review、integration-attempts | 26/26 | 保留未结束合并；Basic 在首次 HTTP、重放与 DB 均脱敏 |
| 2026-10-13 主 Codex，补充 v2 合入 | 12233fa + 当时未提交 S1 / 1.0 | 同上 | server test：review-v2 | 11/11 | v2 真实完成、固定提交合入/幂等、拒绝漂移与失败证据、refs/replace 防护 |
| 2026-10-13 主 Codex，S1 全量门槛 | bee982a / 1.0 | 同上 | 串行：pnpm test → pnpm build → 四包 pnpm exec tsc --noEmit -p tsconfig.json | 46 文件 / 903 用例全部通过；build / 四包 noEmit 通过 | Core 161、Server 441、Runner 211、Web 90；本机日志 tmp/t01-full-test.log、tmp/t01-build.log；无运行库或外部 GitHub 产品写入 |
| 2026-10-13 主 Codex，完整实现首轮专项 | 9d9b1dc + 当时整合改动 / 1.0 | 同上 | Server 78 条 | 64 通过 / 14 失败 | 12 条为临时 remote 配置查询错误，1 条夹具误读 TaskPackage 字段，1 条真实 Git 超时；已逐项修复，见 PITFALLS P-037 |
| 2026-10-13 主 Codex，专项恢复 | 9d9b1dc + 当时整合改动 / 1.0 | 同上 | GitHub 服务、返工恢复、真实 HTTP/Gate、本地恢复、Runner、Web | GitHub 21/21；返工 2/2；HTTP 3/3；本地恢复 2/2；Runner 192/192；Web 面板 18/18 | 分别执行，后续新增回归仍须最终全量；没有外部产品写入 |
| 2026-10-13 主 Codex，完整实现首轮全量 | 9d9b1dc + 当时整合改动 / 1.0 | 同上 | pnpm test | Core 165、Web 121 通过；Server 497/498，Runner 未运行 | 新增返工恢复用例默认 5 秒超时，改独立 20 秒；日志 tmp/t01-complete-test.log |
| 2026-10-13 主 Codex，最终复核首轮 | fcbf53c / 1.0 | 同上 | pnpm test | Core 165、Web 121 通过；Server 497/499，Runner 未运行 | 两条真实 Git 多阶段用例默认 5 秒超时；统一该文件真实 IO 场景为 20 秒，保留断言与全局配置；日志 tmp/t01-final-test.log |
| 2026-10-13 主 Codex，最终复核第二轮 | 5536fec / 1.0 | 同上 | pnpm test | Core 165 通过；Web 119/121；Server 未结束即被递归失败中止，Runner 未运行 | Board 与原导航测试超过 5 秒，Web 默认并发的 collect 累计 156 秒；将 Web worker 限为 2，与 Server/Runner 一致，不改 UI 超时；日志 tmp/t01-final-test-r2.log |
| 2026-10-13 主 Codex，最终复核第三轮 | b7a5ed8 / 1.0 | 同上 | pnpm test | Core 164/165；后续三包未运行 | 锁测试误假定先调用必先取得目录锁；实际二→一仍互斥。改为先确认第一调用已持锁再启动竞争者，保留互斥/异常释放断言；日志 tmp/t01-final-test-r3.log |
| 2026-10-13 主 Codex，最终复核第四轮 | 3a91db1 / 1.0 | 同上 | pnpm test | Core 165、Web 121、Server 499 全部通过；Runner 无完整结果 | 两个 Runner 文件在执行中同时开始出现 Git spawn EINVAL，工具会话失效，无完整 Runner 汇总；保留为未通过/中断。只读诊断未发现环境或 mock 污染，外部执行环境中断仅为推测；日志 tmp/t01-final-test-r4.log |
| 2026-10-13 主 Codex，Runner 独立复核 | 3a91db1 / 1.0 | 同上 | pnpm --filter @anvil/runner test | 10 文件 / 226 全通过，退出码 0 | 没有为 EINVAL 改业务代码或断言；日志 tmp/t01-runner-final-isolated.log |
| 2026-10-13 主 Codex，最终复核第五轮 | 3a91db1 / 1.0 | 同上 | pnpm test → pnpm build | 全量 56 文件 / 1011 通过；build 失败，noEmit 未运行 | Core165/Server499/Runner226/Web121；Web 误经 Core 根入口载入 Node 文件锁，randomUUID 无浏览器导出。日志 tmp/t01-final-test-r5.log、tmp/t01-final-build.log |
| 2026-10-13 主 Codex，构建修复复核 | 4859fa9 对应改动 / 1.0 | 同上 | pnpm build | 四包构建及 Web 生产包通过，退出码 0 | Git 锁改为 @anvil/core/git-lock 子入口，锁算法不变；只读包装边界复核通过；日志 tmp/t01-final-build-r2.log |
| 2026-10-13 主 Codex，最终交付门槛 | 4859fa9ff91e3f11d9a3c0e5d05df9da294ab42d / 1.0 | 同上 | 串行 pnpm test → pnpm build → 四包 pnpm exec tsc --noEmit -p tsconfig.json | **56 文件 / 1011 用例全部通过；构建、四包 noEmit 全通过；全部退出码 0** | Core165/Server499/Runner226/Web121；日志 tmp/t01-final-test-r6.log、tmp/t01-final-build-r3.log、tmp/t01-final-types.log；无真实外部产品写入 |

当前完整实现的最终门槛已通过，交付文档提交不改变上述产品代码。Vite 仍提示既有 Core reporef/delivery 的 node:crypto/node:path 浏览器 externalization，构建退出码 0；本次文件锁的构建错误已经修复。文档链接检查不计作产品用例通过。

## 验收记录

产品验收人：仓库所有者，尚未执行。S1 独立静态审查为 implementation_audit；完整实现独立审查为 t01_final_audit，7 项问题修复后复核通过。t01_acceptance_docs_check 只读核对用户步骤并补清验证策略前置。主会话承担自审、测试与修复；各代理未运行独立测试。真实外部 TC12、所有者产品验收、合并/发布和 J01 分别待执行。
