# 旧验收流程计时测试用例

> 来源需求：锁定 PRD FR-003 telemetry、FR-005；实施计划 A08、D-002。
> 日期：2026-10-06 | 产品形态：网站 | 用例数：9。
> 范围：旧 TaskPanel、Review Timer、测量 API；不包含新决策页、Metrics API 或真实工作基线采集。
> 环境：Windows、Node、pnpm、Git；服务端内存 SQLite；浏览器使用独立测试服务和临时 Git 仓库，不访问用户运行中的数据库。

## 用例列表

### TC-ReviewTimer_001 保存测量_重复提交_保持单行与原回执

- 优先级：P0 | 类型：接口
- 前置条件：项目依赖已安装；测试 fixture 创建 completed Task。
- 测试数据：[ui_version: legacy] [active_review_ms: 5000] [opened_transcript: true] [opened_full_diff: false]。
- 测试步骤：
  1. 执行 `pnpm --filter @anvil/server test test/review-measurements.test.ts`。
- 预期结果：
  1. v1/v2 Task 都返回 200；重复提交保持一行及 recorded_at；后续 8000ms 和 opened_full_diff=true 不被迟到的 5000ms/false 回退。
- 执行结果：✅ 通过（2026-10-06）。

### TC-ReviewTimer_002 校验测量_字段不合契约_拒绝写入

- 优先级：P1 | 类型：接口
- 前置条件：同接口专项独立创建的 completed Task。
- 测试数据：[active_review_ms: -1、1.5、"5"、60000、null] [review_started_at: 2999 年、2 月 30 日、空字符串、早于任务完成] [ui_version: v2] [opened_full_diff: 1]。
- 测试步骤：
  1. 执行接口专项“拒绝非法测量”矩阵。
- 预期结果：
  1. 返回 400、无测量行；未完成 Task 返回 409，不存在 Task 返回 404。日志打开标志为 false、未知字段、缺字段及半个 null 同样拒绝。
- 执行结果：✅ 通过（2026-10-06）。

### TC-ReviewTimer_003 排除样本_迟到请求_保持失效

- 优先级：P1 | 类型：接口
- 前置条件：接口 fixture 中已有 5000ms 测量。
- 测试数据：[review_started_at: null] [active_review_ms: null] [review_measurement_failed_for: 当前 task_id]。
- 测试步骤：
  1. 执行接口专项“失效标记”“merge 携带失败标记”“打回意见携带失败标记”。
- 预期结果：
  1. 失效后测量时间保持 null；迟到的有效载荷不能恢复为有效样本；打回返回 201 并入队；标记指向其他 Issue/Task 返回 400。
- 执行结果：✅ 通过（2026-10-06）。

### TC-ReviewTimer_004 继续裁决_测量表拒写_保存独立失效标记

- 优先级：P0 | 类型：接口
- 前置条件：内存库有一条测量，SQLite trigger 拒绝 review_measurements INSERT。
- 测试数据：[active_review_ms: 6000] [打回意见: 继续打回]。
- 测试步骤：
  1. 执行接口专项“测量表持续写入失败”。
- 预期结果：
  1. 计时接口 500 后，打回仍 201 且入队；Task result_json 保留原 branch/head/verification，并增加 review_measurement_excluded=true；解除故障后再发有效请求仍得到 null 样本。
- 执行结果：✅ 通过（2026-10-06）。

### TC-ReviewTimer_005 刷新验收页_已展开 Diff_续计后合入

- 优先级：P1 | 类型：页面
- 前置条件：隔离 preview 服务创建 `计时验收 pass`，提供真实可合入的临时 Git 分支；打开该 Task URL。
- 测试数据：[界面: legacy] [分支: task/preview]。
- 测试步骤：
  1. 点击“查看 diff”。
  2. 刷新页面。
  3. 点击“合入 main”。
- 预期结果：
  1. 展示包含“浏览器验收产物”的 Diff。
  2. 交付区可继续操作。
  3. 显示“✓ 已合入 task/preview”；持久化测量非负，opened_transcript=1、opened_full_diff=1，开始时间延续刷新前。
- 执行结果：✅ 通过（2026-10-06）；本轮隔离样本实际保存 17886ms。

### TC-ReviewTimer_006 合入产物_计时接口失败_继续合入并提示

- 优先级：P1 | 类型：页面
- 前置条件：隔离 preview 的 `计时验收 fail-merge`；测量 PUT 固定返回 503。
- 测试数据：[分支: task/preview]。
- 测试步骤：
  1. 点击“合入 main”。
- 预期结果：
  1. 显示“本任务不计入验收耗时样本”警告及“✓ 已合入 task/preview”；数据库测量时间为 null。
- 执行结果：✅ 通过（2026-10-06）；截图 `tmp/codex-a08-warning.png`。

### TC-ReviewTimer_007 打回产物_计时接口失败_保存意见并排队

- 优先级：P1 | 类型：页面
- 前置条件：隔离 preview 的 `计时验收 fail-reject`；测量 PUT 固定返回 503。
- 测试数据：[打回意见: 补充边界检查后重跑]。
- 测试步骤：
  1. 在“打回意见…”输入测试数据。
  2. 点击“提交意见并重跑”。
  3. 刷新页面。
- 预期结果：
  1. 文本框保留所输入的文本。
  2. 显示计时警告；保存评论并创建 queued 接续 Task，测量时间为 null。
  3. 评论显示“补充边界检查后重跑”。
- 执行结果：✅ 通过（2026-10-06）；数据证据 `tmp/codex-a08-browser-evidence.json`。

### TC-ReviewTimer_008 中止测量_三秒未响应_释放请求

- 优先级：P2 | 类型：接口（浏览器传输层自动化）
- 前置条件：Vitest fake timers 与遵守 AbortSignal 的 fetch fixture。
- 测试数据：[等待: 3000ms]。
- 测试步骤：
  1. 执行 `pnpm --filter @anvil/web test test/review-measurement-api.test.ts`。
- 预期结果：
  1. 3000ms 触发 abort；无 body 的旧 merge 保持不带 JSON content-type；计时失败标记随 merge/comment 原请求发送。
- 执行结果：✅ 通过（2026-10-06）；2 条自动化测试。

### TC-ReviewTimer_009 采集主动时长_暂停恢复刷新_保持累计

- 优先级：P0 | 类型：页面（Hook/组件契约自动化，非实机时钟测量）
- 前置条件：jsdom、fake Date/performance、React StrictMode；不向生产库写测量。
- 测试数据：[活动: 1000ms] [失焦/隐藏: 5000ms] [无交互: 90000ms] [恢复: 5000ms]。
- 测试步骤：
  1. 执行 `pnpm --filter @anvil/web test test/review-timer.test.ts test/task-panel.test.tsx`。
- 预期结果：
  1. 隐藏/失焦期间不增长，90000ms 无交互只计 60000ms、恢复后为 65000ms；刷新/StrictMode 不重复；任务隔离；API 等待暂停；重试接续；首帧 DOM 可见时计时器已就绪；连续点击及跨裁决点击仅执行一次；存储失败/墙钟回拨形成 null 样本。
- 执行结果：✅ 通过（2026-10-06）；16 条 Hook 测试、17 条组件测试。浏览器实操范围以 005–007 为准，未把合成事件测试称为实机焦点/空闲测量。

## 需求覆盖矩阵

| 功能点 | 来源 | 用例 |
|---|---|---|
| 按 Task upsert、版本正交、单调累计 | A08、D-002 | 001、002 |
| 失败不吞裁决、排除基线、迟到请求 | A08 | 003、004、006、007、008 |
| 展开 Transcript/Diff、刷新续计 | FR-003、FR-005 | 005、009 |
| visibility/focus/60 秒空闲、StrictMode、重复点击 | FR-005、A08 | 009 |

## 执行汇总

- 9 个场景：通过 9、失败 0、阻塞 0、未执行 0；其中浏览器实操 3，其他为接口/组件自动化。比例仅描述上述验证范围。
- 开发红灯：测量路由未实现时 22 条失败，Hook 模块缺失时无法加载，面板未接线时 6 条失败；实现后均通过。
- 全量回归发现首帧按钮先于 passive effect 就绪，新增 layout effect 探针稳定复现，改为 useLayoutEffect 后修复。实际计时保留 performance 精度，本地草稿落整数毫秒，避免刷新误判。
- 故障注入发现重复写失效测量也会阻断原打回，现用 Task result_json 的独立服务端标记兜底；测量表恢复后的有效请求仍失效，不改原 Git/验证事实。
- 本地测试服务只绑 127.0.0.1，已停止；测试数据、截图与日志留在 tmp。浏览器样本和 Fake CLI 不计入 R2 真实工作样本。
- 新增协议类型位于 Core；为让打回携带失效标记，额外修改 comments 路由与 addComment 客户端，属于 A08 失败恢复所需配套；无新依赖、无 DB 迁移。
- 最终独立回归：`pnpm test` **40 文件 / 840 用例通过**（core 161、server 390、runner 210、web 79）；`pnpm build`、四包 `tsc --noEmit`、`git diff --check` 通过。
- 一轮测试未结束时误启动构建，两个既有 Runner Git 用例超过 5 秒；单独运行全量后通过。本轮未改变测试超时或断言，失败日志保留。
- 工程日志：最终通过为 `tmp/codex-a08-tests-isolated.log`；重叠失败为 `tmp/codex-a08-tests-final.log`；构建为 `tmp/codex-a08-build-final.log`，专项为 `tmp/codex-a08-server-final.log`、`tmp/codex-a08-web-final.log`。缺陷本轮已修复，未向 GitHub 创建外部记录。
