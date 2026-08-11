# 仓库常驻指引 + 表单体验 测试用例文档

> 来源需求: docs/superpowers/specs/2026-08-11-guidance-and-forms.md
> 生成日期: 2026-08-11 | 产品形态: 网站 | 用例数: 8
> 来源章节基线: 分支 guidance-and-forms（T1/T2/T3 实现完成后）

## 全局准备

- 接口用例（独立实例）：`cd apps/server && ANVIL_PORT=3101 ANVIL_DB=anvil-test.db pnpm dev`；`BASE=http://127.0.0.1:3101`。fixture 目录：`D:/anvil/test/fixtures/guide-ok`（内含 ANVIL.md）、`D:/anvil/test/fixtures/guide-empty`（无 ANVIL.md）、`D:/anvil/test/fixtures/guide-long`（ANVIL.md 为 3000 个 x）。
- 页面用例（记 P1 环境）：server:3100 与 web:5173 已启动（runner 不起），浏览器打开 `http://localhost:5173`；`D:/anvil/ANVIL.md` 已存在（本主题 dogfood 文件）。
- runner prompt 注入（spec 范围 A）为进程内行为，由 apps/runner/test/executor.test.ts 四条用例覆盖（含截断与静默跳过），本表不重复设接口/页面用例。

## 用例列表

### TC-Guide_001 预览指引_本地仓库有指引文件_返回内容

- 优先级: P0 | 类型: 接口
- 前置条件: 接口实例已启动；fixture `D:/anvil/test/fixtures/guide-ok/ANVIL.md` 内容为 `改完跑 pnpm test`
- 测试步骤:
  1. 执行请求 `GET $BASE/api/guidance?repo=D%3A%2Fanvil%2Ftest%2Ffixtures%2Fguide-ok`
- 预期结果:
  1. HTTP 200；body.found=true；body.content 含 "改完跑 pnpm test"；body.truncated=false
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Guide_002 预览指引_文件不存在_返回未命中

- 优先级: P1 | 类型: 接口
- 前置条件: 接口实例已启动；fixture `D:/anvil/test/fixtures/guide-empty` 存在且无 ANVIL.md
- 测试步骤:
  1. 执行请求 `GET $BASE/api/guidance?repo=D%3A%2Fanvil%2Ftest%2Ffixtures%2Fguide-empty`
- 预期结果:
  1. HTTP 200；body.found=false
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Guide_003 预览指引_缺repo参数_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 接口实例已启动
- 测试步骤:
  1. 执行请求 `GET $BASE/api/guidance`
  2. 执行请求 `GET $BASE/api/guidance?repo=`
- 预期结果:
  1. HTTP 400；body.error="repo required"
  2. HTTP 400；body.error="repo required"
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Guide_004 预览指引_超长内容_截断为2000字符并标注

- 优先级: P2 | 类型: 接口
- 前置条件: 接口实例已启动；fixture `D:/anvil/test/fixtures/guide-long/ANVIL.md` 为 3000 个字符 x
- 测试步骤:
  1. 执行请求 `GET $BASE/api/guidance?repo=D%3A%2Fanvil%2Ftest%2Ffixtures%2Fguide-long`
- 预期结果:
  1. HTTP 200；body.found=true；body.content 长度恰为 2000；body.truncated=true
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Guide_005 预览指引_远程URL无缓存_返回未命中

- 优先级: P3 | 类型: 接口
- 前置条件: 接口实例已启动；`https://github.com/nonexist-xyz/none.git` 未曾被任何任务使用（无 repocache）
- 测试步骤:
  1. 执行请求 `GET $BASE/api/guidance?repo=https%3A%2F%2Fgithub.com%2Fnonexist-xyz%2Fnone.git`
- 预期结果:
  1. HTTP 200；body.found=false
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Guide_006 新建弹窗_仓库含指引文件_显示注入预览

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；`D:/anvil/ANVIL.md` 存在
- 测试数据: [目标仓库: D:/anvil]
- 测试步骤:
  1. 点击"新建 Issue"
  2. 在目标仓库输入框输入 D:/anvil
  3. 等待 1 秒，检查输入框下方区域
- 预期结果:
  1. 对话框打开
  2. 输入成功
  3. 输入框下方出现预览块：等宽小字显示 ANVIL.md 内容开头（含 "改动纪律"），并有"将随任务注入"一行
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 预览块含内容开头与"将随任务注入"；注意 document.body.innerText 读不到 Radix portal 内容，断言须取 dialog 根节点

### TC-Form_007 新建弹窗_双击创建_仅生成一张卡片

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪
- 测试数据: [标题: 双击防重探针]
- 测试步骤:
  1. 点击"新建 Issue"，标题输入"双击防重探针"
  2. 快速双击"创建任务"按钮
  3. 检查待办列中标题为"双击防重探针"的卡片数量
  4. 执行请求 `PATCH /api/issues/<该Issue id>`（体 `{"status":"cancelled"}`）清理现场
- 预期结果:
  1. 标题填入成功
  2. 对话框关闭
  3. 该标题的卡片数量为 1
  4. HTTP 200；卡片移入已取消列
- 执行结果: ✅ 通过 (2026-08-11，修复后复跑) | 首执行实际: 同帧合成双击产生两条 issue（14:06:34.765/.768 各一条）| 缺陷: 防重入仅靠 React state，同帧事件穿透（真实离散点击不受影响）| 修复: 四个动作按钮统一加 ref 同步在途守卫后复跑，双击仅一条（新 issue id 前缀 4947d96c）

### TC-Form_008 评论框_Enter提交_ShiftEnter换行

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；存在一条有任务的 Issue（id 记为 IID）且其面板已打开（经 `/?task=<任务id>` 打开）
- 测试步骤:
  1. 在"追加指令或评论…"输入框输入"Enter探针"
  2. 在输入框上按 Enter 键
  3. 再输入"换行探针"，按 Shift+Enter
  4. 检查输入框内容
  5. 执行请求 `PATCH /api/issues/$IID`（体 `{"status":"cancelled"}`）清理现场
- 预期结果:
  1. 输入成功
  2. 评论"Enter探针"出现在评论区；输入框清空
  3. 输入框仍显示"换行探针"（含换行），未发送
  4. 评论区不出现"换行探针"
  5. HTTP 200
- 执行结果: ✅ 通过 (2026-08-11) | 实测: Enter 提交后评论落库并显示、输入框清空；Shift+Enter 草稿保留未发送（server 侧评论区核对一致）；探针已清理

## 需求覆盖矩阵

| 功能点 | 来源章节 | 用例编号 |
|--------|----------|----------|
| 指引预览端点（本地/未命中/400/截断/URL 无缓存） | spec 范围 B | TC-Guide_001~005 |
| runner prompt 注入（含截断/静默跳过） | spec 范围 A | 由 apps/runner/test/executor.test.ts 四条用例覆盖（vitest，随 pnpm test 执行） |
| 弹窗指引预览 | spec 范围 C.1 | TC-Guide_006 |
| 创建按钮防重入 | spec 范围 C.2 | TC-Form_007（组件测试另覆盖单请求断言） |
| 评论 Enter 提交 / Shift+Enter 换行 | spec 范围 C.3 | TC-Form_008 |
| 发送失败红字与草稿保留 | spec 范围 C.4 | 由 apps/web/test/task-panel.test.tsx 用例覆盖（页面级模拟 server 故障代价高，不重复设页面用例） |

## 执行汇总

- 总数 8 | 通过 8 | 失败 0 | 阻塞 0 | 未执行 0 | 通过率 100%（已执行 8 条；TC-Form_007 为首执行发现缺陷、修复后复跑通过）
- 缺陷清单:
  - TC-Form_007（已修复）: 同帧合成双击产生两条 issue | 实际: 创建 2 条 | 预期: 创建 1 条 | 根因: 防重入仅靠 React state，同帧事件读旧闭包穿透 | 修复: 创建/发送/合入/打回四个动作统一加 ref 同步在途守卫
