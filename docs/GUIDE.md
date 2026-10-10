# 当前功能与 API 参考

更新时间：2026-10-10；代码基线 ff12dea4d57639ae1dbd189872d2b27ea56074a7。本文记录已有实现，规划看 [TASKS](TASKS.md)，启动看 [README](../README.md)，不重复维护命令与测试数量。

## 当前闭环与限制

四包分别负责共享协议、Server 调度/存储、本机 Runner 执行、Web 看板。当前只有 Kimi adapter；T01–T06 尚未实现，配置 CLI 名称不能直接启用 Codex。

Web 创建/指派 Issue → Server 排队 → Runner 认领与准备 worktree → CLI 执行/消息上报 → Report 与 Runner 独立终检 → 材料齐全才进入人工审查。进程退出不等于交付，in_review 不代表可以安全合入。

v1 保留 issue-status 的旧交付语义；v2 由任务提交 Delivery Report，并由 Runner 在固定基线策略下执行验证。追问最多两轮，由 Runner 发起，末轮仍要核对 Report/HEAD。Agent 自述不能写成 Runner 实测。

当前页面 Diff 仍有浮动基线，旧 URL 合入存在 push 失败仍误置 done 的缺口，实时 Gate 尚未实现；这些进入 T01。现有 merge API 仅作现状索引，不能据此宣称 GitHub PR 闭环已实现。

单机单用户：人类 HTTP/WS 无认证，Server 默认 loopback。daemon token 与 task token 分离；远程开放须完成 T05，不能直接暴露当前服务。

## 人类界面/API（当前仅本机）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/bootstrap | 初始化数据 |
| GET/POST | /api/issues | 列表/新建 |
| GET/PATCH | /api/issues/:id | 详情/更新 |
| GET | /api/issues/:id/tasks | 任务历史 |
| POST | /api/issues/:id/rerun | 重跑 |
| POST | /api/issues/:id/comments | 旧评论即指令通路，按守卫排队接力；不是新聊天接口 |
| GET | /api/tasks/:id、/api/tasks/:id/messages | 详情/日志回放 |
| POST | /api/tasks/:id/cancel | 取消 |
| GET | /api/tasks/:id/diff | 旧交付 Diff，固定版本改造待 T01 |
| POST | /api/tasks/:id/merge | 旧合入入口，正确性改造待 T01 |
| PUT | /api/tasks/:id/review-measurement | 保存审查计时；不代表人工裁决或安全 Gate |
| GET/POST | /api/agents | Agent 列表/新建 |
| GET | /api/runtimes | Runtime 列表 |
| GET/POST | /api/daemon-tokens | token 列表/生成 |
| POST | /api/daemon-tokens/:id/revoke | 吊销 |
| GET | /api/guidance | 仓库常驻指引预览 |
| GET | /ws | 看板 WS |

## Runner 和 Agent API

| 身份 | 方法 / 路径 | 说明 |
|---|---|---|
| daemon token | POST /api/daemon/register、/heartbeat、/claim | 注册、心跳、认领 |
| daemon token | GET /api/daemon/ws | Runner 提示连接 |
| daemon token | POST /api/daemon/tasks/:id/start、/complete、/fail | 生命周期；含所有权校验、事务与幂等 |
| task token | GET /api/daemon/tasks/:id/status、/delivery | 单任务状态/交付查询 |
| task token | POST /api/daemon/tasks/:id/messages | 消息上传，seq 连续 |
| task token | PUT /api/daemon/tasks/:id/delivery-report | v2 Agent Report |
| task token | POST /api/daemon/tasks/:id/issue-status | 旧兼容回调；v2 不可自行写 in_review/done |

上述缩写路径按同一前缀展开。鉴权依据 [daemon.ts](../apps/server/src/routes/daemon.ts)，完整不变量见 [AGENTS](../AGENTS.md)。不要向 Agent 传 daemon token。

## 已有证据与后续工作

[A01–A08 和测试结果](PROGRESS.md)是本地分支上的已有基础；未合并/未发布与已实现分开。旧 R2 未通过；真实 Codex 验收归 T02，GitHub 联合链路归 J01，计时对照 H01 单列。

当前功能、故障与验证以源码和真实运行结果为准。新增/变更 API 时同步本索引及对应 PRD/测试，不用历史文档中的旧测试计数宣称通过。
