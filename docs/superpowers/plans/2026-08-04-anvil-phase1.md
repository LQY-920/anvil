# Anvil 一期（编码任务调度）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-08-04-anvil-design.md` 实现 Anvil 一期：看板创建 issue → 指派 Agent → 本地 runner 认领 → git worktree 中 spawn Kimi Code CLI 自主执行 → 日志流实时回看板 → 完成进 `in_review`。

**Architecture:** pnpm monorepo 四个包：`packages/core`（纯类型协议）、`apps/server`（Fastify + Drizzle/SQLite，唯一状态权威）、`apps/runner`（本地 daemon，轮询认领 + spawn CLI）、`apps/web`（React + Vite 看板）。server 与 runner 之间 HTTP 轮询为主、WS 仅作"有活了"轻提示。

**Tech Stack:** TypeScript strict / Node ≥ 20 / pnpm / Fastify ^5 + @fastify/websocket ^11 / Drizzle ORM + better-sqlite3 / React ^18 + Vite / vitest ^3 / tsx。

**Spec:** `docs/superpowers/specs/2026-08-04-anvil-design.md`（已评审定稿）。本计划与 spec 的两处有意差异：

1. `issues` 表增加 `repo_path TEXT NULL`——spec 要求"每任务独立 git worktree"，但 spec 的 issues 字段里没有指明目标仓库，不补这个字段 runner 不知道对哪个仓库建 worktree。`repo_path` 为 NULL 时任务在普通工作目录执行（不建 worktree）。
2. `tasks` 表增加 `task_token_hash TEXT NULL`——spec §6 安全设计要求任务级 token，字段列表未列出，此处补落库字段（存 SHA-256 哈希，不存明文）。

**全局约定（所有 Task 遵守）：**

- 包名：`@anvil/core`、`@anvil/server`、`@anvil/runner`、`@anvil/web`。
- 所有 ID：`crypto.randomUUID()` 生成的 text；时间戳：`new Date().toISOString()` 的 UTC ISO 字符串（字典序即可比较）。
- server 监听 `127.0.0.1:3100`；web dev 端口 5173 通过 Vite proxy 转发 `/api` 与 `/ws`。
- v1 认证模型（单用户自用）：web REST 不鉴权（仅监听 loopback）；daemon 端点要求 `Authorization: Bearer <daemon_token>`；任务级端点要求 `Bearer <task_token>`。
- 每个 Task 完成后按其最后一步的 commit 指令提交；commit message 用 Conventional Commits。
- 测试命令都在对应包目录下执行（如 `pnpm --filter @anvil/server test`）。

---

## 文件结构

```
D:/anvil
├── package.json                      # root：workspace 脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .gitignore
├── packages/core/
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── models.ts                 # 领域模型 + 状态枚举
│       ├── messages.ts               # AgentMessage 7 型 + parseAgentLine
│       ├── protocol.ts               # daemon REST 请求/响应 + WS 事件
│       └── index.ts
├── apps/server/
│   ├── package.json  tsconfig.json  drizzle.config.ts
│   ├── drizzle/                      # drizzle-kit 生成的迁移（提交进 git）
│   └── src/
│       ├── index.ts                  # 入口：buildApp + listen
│       ├── app.ts                    # buildApp：注册路由/WS/清扫定时器
│       ├── db/schema.ts              # 13 张表 Drizzle 定义
│       ├── db/client.ts              # createDb(path) + runMigrations + seed
│       ├── services/issues.ts        # issue CRUD + 入队触发
│       ├── services/tasks.ts         # claim/start/complete/fail/重试/清扫/cancel
│       ├── services/runtimes.ts      # 注册/心跳/离线清扫
│       ├── services/messages.ts      # transcript 落库 + seq 校验
│       ├── lib/auth.ts               # daemon token / task token 校验
│       ├── lib/hash.ts               # sha256Hex
│       ├── ws/hub.ts                 # WS 连接池 + broadcast
│       └── routes/                   # issues.ts tasks.ts agents.ts daemon.ts meta.ts
├── apps/runner/
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── index.ts                  # 入口：runDaemon
│       ├── config.ts                 # 加载/生成 daemon 配置
│       ├── probe.ts                  # 探测本机 CLI（kimi --version）
│       ├── client.ts                 # ApiClient：daemon REST 封装
│       ├── poller.ts                 # 主循环：心跳/轮询/WS hint
│       ├── worktree.ts               # git worktree 创建/清理
│       ├── uploader.ts               # 500ms 批量上报 + redact + seq
│       ├── executor.ts               # 单任务执行编排
│       ├── agents/backend.ts         # AgentBackend 接口
│       ├── agents/process.ts         # spawn/行解析/watchdog/杀进程组
│       ├── agents/kimi.ts            # Kimi CLI adapter
│       └── testing/fake-cli.mjs      # 测试替身 CLI
└── apps/web/
    ├── package.json  tsconfig.json  vite.config.ts  index.html
    └── src/
        ├── main.tsx  App.tsx  styles.css
        ├── api.ts                    # REST 封装
        ├── ws.ts                     # useServerEvents hook
        └── pages/BoardPage.tsx  TaskDetailPage.tsx  AgentsPage.tsx
```

---

## Task 0: 仓库脚手架与 git 初始化

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/runner/package.json`, `apps/runner/tsconfig.json`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`

- [x] **Step 1: 初始化 git 仓库与根文件**

```bash
cd /d/anvil && git init
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-journal
.anvil/
research/
kimi-export-session_*.md
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`package.json`（root）:

```json
{
  "name": "anvil",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "dev:server": "pnpm --filter @anvil/server dev",
    "dev:runner": "pnpm --filter @anvil/runner dev",
    "dev:web": "pnpm --filter @anvil/web dev",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

- [x] **Step 2: 写四个包的 package.json 与 tsconfig**

`packages/core/package.json`:

```json
{
  "name": "@anvil/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`apps/server/package.json`:

```json
{
  "name": "@anvil/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@anvil/core": "workspace:*",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.10.0",
    "drizzle-orm": "^0.38.0",
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "drizzle-kit": "^0.30.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "ws": "^8.18.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/runner/package.json`:

```json
{
  "name": "@anvil/runner",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@anvil/core": "workspace:*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/runner/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/web/package.json`:

```json
{
  "name": "@anvil/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run --environment jsdom",
    "build": "tsc -p tsconfig.json && vite build"
  },
  "dependencies": {
    "@anvil/core": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "noEmit": true },
  "include": ["src"]
}
```

- [x] **Step 3: 安装依赖并验证 workspace 链接**

Run: `cd /d/anvil && pnpm install`
Expected: 四个包安装成功，`node_modules/@anvil/core` 为 workspace 软链。Windows 上 `better-sqlite3` 若触发编译失败，先执行 `pnpm approve-builds` 或安装预编译版本后重试；成功标志是 `pnpm --filter @anvil/server exec node -e "require('better-sqlite3');console.log('ok')"` 输出 `ok`。

- [x] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (core/server/runner/web)"
```

---

## Task 1: packages/core —— 领域模型、消息类型、协议契约

**Files:**
- Create: `packages/core/src/models.ts`
- Create: `packages/core/src/messages.ts`
- Create: `packages/core/src/protocol.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/core.test.ts`

- [x] **Step 1: 写失败测试**

`packages/core/test/core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ISSUE_STATUSES, TASK_STATUSES, MESSAGE_TYPES, FAILURE_REASONS,
  parseAgentLine, priorityWeight,
} from "../src/index.js";

describe("enums", () => {
  it("has spec-defined values", () => {
    expect(ISSUE_STATUSES).toEqual(["backlog","todo","in_progress","in_review","done","blocked","cancelled"]);
    expect(TASK_STATUSES).toEqual(["queued","dispatched","running","completed","failed","cancelled"]);
    expect(MESSAGE_TYPES).toEqual(["text","thinking","tool_use","tool_result","status","error","log"]);
    expect(FAILURE_REASONS).toEqual(["runtime_offline","idle_timeout","spawn_failed","non_zero_exit","lease_expired","cancelled_by_user"]);
  });
  it("priorityWeight orders urgent > none", () => {
    expect(priorityWeight("urgent")).toBeGreaterThan(priorityWeight("none"));
  });
});

describe("parseAgentLine", () => {
  it("parses assistant text", () => {
    const m = parseAgentLine(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }));
    expect(m).toEqual({ type: "text", content: "hi" });
  });
  it("parses assistant tool_calls", () => {
    const m = parseAgentLine(JSON.stringify({ role: "assistant", tool_calls: [{ name: "Bash", input: { cmd: "ls" } }] }));
    expect(m).toEqual({ type: "tool_use", tool: "Bash", input: { cmd: "ls" } });
  });
  it("parses tool result", () => {
    const m = parseAgentLine(JSON.stringify({ role: "tool", name: "Bash", content: "file.txt" }));
    expect(m).toEqual({ type: "tool_result", tool: "Bash", output: "file.txt" });
  });
  it("wraps unparseable line as log", () => {
    expect(parseAgentLine("not json at all")).toEqual({ type: "log", content: "not json at all" });
  });
  it("returns null for empty line", () => {
    expect(parseAgentLine("   ")).toBeNull();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd /d/anvil && pnpm --filter @anvil/core test`
Expected: FAIL，报 `../src/index.js` 不存在或导出缺失。

- [x] **Step 3: 实现 models.ts / messages.ts / protocol.ts / index.ts**

`packages/core/src/models.ts`:

```ts
export const ISSUE_STATUSES = ["backlog","todo","in_progress","in_review","done","blocked","cancelled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const TASK_STATUSES = ["queued","dispatched","running","completed","failed","cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["urgent","high","medium","low","none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function priorityWeight(p: Priority): number {
  return { urgent: 40, high: 30, medium: 20, low: 10, none: 0 }[p];
}

export const FAILURE_REASONS = ["runtime_offline","idle_timeout","spawn_failed","non_zero_exit","lease_expired","cancelled_by_user"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const AGENT_STATUSES = ["idle","working","blocked","error","offline"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PROVIDERS = ["kimi"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Workspace { id: string; name: string; slug: string; settings_json: string; created_at: string; }
export interface User { id: string; email: string; name: string; password_hash: string | null; created_at: string; }

export interface Issue {
  id: string; workspace_id: string; title: string; description: string | null;
  status: IssueStatus; priority: Priority;
  assignee_type: "member" | "agent" | null; assignee_id: string | null;
  creator_type: "member" | "agent"; creator_id: string;
  repo_path: string | null; position: number;
  created_at: string; updated_at: string;
}

export interface Task {
  id: string; workspace_id: string; issue_id: string; agent_id: string;
  runtime_id: string | null; status: TaskStatus; priority: number;
  attempt: number; max_attempts: number; parent_task_id: string | null;
  failure_reason: FailureReason | null; session_id: string | null; work_dir: string | null;
  task_token_hash: string | null; result_json: string | null; error: string | null;
  lease_expires_at: string | null; dispatched_at: string | null;
  started_at: string | null; completed_at: string | null; created_at: string;
}

export interface Comment {
  id: string; issue_id: string; author_type: "member" | "agent" | "system";
  author_id: string; type: "comment" | "status_change" | "progress_update" | "system";
  body: string; created_at: string;
}

export interface Agent {
  id: string; workspace_id: string; name: string; provider: Provider;
  status: AgentStatus; max_concurrent_tasks: number; runtime_id: string | null; created_at: string;
}

export interface Runtime {
  id: string; workspace_id: string; daemon_id: string; provider: string;
  version: string | null; status: "online" | "offline"; last_seen_at: string | null;
}
```

`packages/core/src/messages.ts`:

```ts
export const MESSAGE_TYPES = ["text","thinking","tool_use","tool_result","status","error","log"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface AgentMessage {
  type: MessageType;
  tool?: string;
  content?: string;
  input?: unknown;
  output?: unknown;
}

/** 把一行 CLI stdout 解析为统一消息；解析不了的原样包成 log。空行返回 null。 */
export function parseAgentLine(line: string): AgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return { type: "log", content: line }; }
  if (obj == null || typeof obj !== "object") return { type: "log", content: line };
  if (obj.role === "assistant") {
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      const tc = obj.tool_calls[0];
      return { type: "tool_use", tool: String(tc.name ?? tc.function?.name ?? "unknown"), input: tc.input ?? tc.function?.arguments };
    }
    const parts = Array.isArray(obj.content) ? obj.content : [{ type: "text", text: String(obj.content ?? "") }];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
    return { type: "text", content: text };
  }
  if (obj.role === "tool") {
    return { type: "tool_result", tool: String(obj.name ?? "unknown"), output: typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content) };
  }
  return { type: "log", content: line };
}
```

`packages/core/src/protocol.ts`:

```ts
import type { AgentMessage, Issue, Priority, Task } from "./index.js";

export interface DaemonRegisterRequest { daemon_id: string; runtimes: { provider: string; version: string | null }[]; }
export interface DaemonHeartbeatRequest { daemon_id: string; }
export interface ClaimRequest { daemon_id: string; max_tasks?: number; }
export interface TaskPackage {
  task: Task;
  issue: Issue;
  prior_work_dir: string | null;
  task_token: string;
}
export interface ClaimResponse { tasks: TaskPackage[]; }

export interface MessageBatchItem extends AgentMessage { seq: number; }
export interface AppendMessagesRequest { messages: MessageBatchItem[]; }
export interface AppendMessagesResponse { last_seq: number; }

export interface StartRequest { work_dir: string; }
export interface CompleteRequest { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string; }
export interface FailRequest { failure_reason: string; error: string; work_dir?: string; }
export interface IssueStatusRequest { status: "in_review" | "done" | "blocked"; note?: string; }

export type ServerEventType = "issue.updated" | "task.updated" | "task.message" | "runtime.updated" | "task.available";
export interface ServerEvent { type: ServerEventType; data: unknown; }

export interface CreateIssueRequest {
  title: string; description?: string; priority?: Priority;
  assignee_type?: "member" | "agent"; assignee_id?: string; repo_path?: string;
}
export interface UpdateIssueRequest {
  title?: string; description?: string; status?: string; priority?: Priority;
  assignee_type?: "member" | "agent" | null; assignee_id?: string | null; repo_path?: string | null;
}
```

`packages/core/src/index.ts`:

```ts
export * from "./models.js";
export * from "./messages.js";
export * from "./protocol.js";
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @anvil/core test`
Expected: PASS（6 个用例）。

- [x] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): domain models, message types, daemon protocol contracts"
```

---

## Task 2: server —— Drizzle schema、迁移、seed

**Files:**
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/drizzle/0000_*.sql`（由 drizzle-kit 生成）
- Test: `apps/server/test/db.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createDb, runMigrations, seed } from "../src/db/client.js";

describe("db", () => {
  it("migrates and seeds idempotently", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const s1 = seed(db);
    const s2 = seed(db);
    expect(s1.workspace.id).toBe(s2.workspace.id);
    expect(s1.user.id).toBe(s2.user.id);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["workspaces","users","workspace_members","issues","tasks","task_messages","comments","agents","runtimes","daemon_tokens","skills","skill_files","agent_skills"]) {
      expect(names).toContain(t);
    }
  });

  it("enforces one pending task per issue via partial unique index", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const { workspace } = seed(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
                VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspace.id, now);
    db.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
                VALUES ('i1', ?, 't', 'todo', 'medium', 'member', 'u', 1, ?, ?)`).run(workspace.id, now, now);
    const ins = db.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, created_at)
                            VALUES (?, ?, 'i1', 'a1', 'queued', 20, 1, 3, ?)`);
    ins.run("t1", workspace.id, now);
    expect(() => ins.run("t2", workspace.id, now)).toThrow(); // 第二条 queued 同 issue → 唯一索引拒绝
    db.prepare(`UPDATE tasks SET status='completed' WHERE id='t1'`).run();
    ins.run("t3", workspace.id, now); // 终态之后允许再排队
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL，`../src/db/client.js` 不存在。

- [x] **Step 3: 实现 schema.ts**

`apps/server/src/db/schema.ts`:

```ts
import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings_json: text("settings_json").notNull().default("{}"),
  created_at: text("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password_hash: text("password_hash"),
  created_at: text("created_at").notNull(),
});

export const workspaceMembers = sqliteTable("workspace_members", {
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  user_id: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(), // owner | admin | member
});

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("medium"),
  assignee_type: text("assignee_type"), // member | agent | null
  assignee_id: text("assignee_id"),
  creator_type: text("creator_type").notNull(),
  creator_id: text("creator_id").notNull(),
  repo_path: text("repo_path"),
  position: real("position").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => [
  index("issues_ws_status").on(t.workspace_id, t.status),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  issue_id: text("issue_id").notNull().references(() => issues.id),
  agent_id: text("agent_id").notNull().references(() => agents.id),
  runtime_id: text("runtime_id"),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(20), // priorityWeight
  attempt: integer("attempt").notNull().default(1),
  max_attempts: integer("max_attempts").notNull().default(3),
  parent_task_id: text("parent_task_id"),
  failure_reason: text("failure_reason"),
  session_id: text("session_id"),
  work_dir: text("work_dir"),
  task_token_hash: text("task_token_hash"),
  result_json: text("result_json"),
  error: text("error"),
  lease_expires_at: text("lease_expires_at"),
  dispatched_at: text("dispatched_at"),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  created_at: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("tasks_one_pending_per_issue").on(t.issue_id).where(sql`status IN ('queued','dispatched')`),
  index("tasks_claim").on(t.status, t.priority, t.created_at),
]);

export const taskMessages = sqliteTable("task_messages", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull().references(() => tasks.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  tool: text("tool"),
  content: text("content"),
  input_json: text("input_json"),
  output: text("output"),
  created_at: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("task_messages_task_seq").on(t.task_id, t.seq),
]);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  issue_id: text("issue_id").notNull().references(() => issues.id),
  author_type: text("author_type").notNull(),
  author_id: text("author_id").notNull(),
  type: text("type").notNull().default("comment"),
  body: text("body").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => [
  index("comments_issue").on(t.issue_id, t.created_at),
]);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // 初版仅 'kimi'
  status: text("status").notNull().default("idle"),
  max_concurrent_tasks: integer("max_concurrent_tasks").notNull().default(1),
  runtime_id: text("runtime_id"),
  created_at: text("created_at").notNull(),
});

export const runtimes = sqliteTable("runtimes", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  daemon_id: text("daemon_id").notNull(),
  provider: text("provider").notNull(),
  version: text("version"),
  status: text("status").notNull().default("offline"),
  last_seen_at: text("last_seen_at"),
}, (t) => [
  uniqueIndex("runtimes_ws_daemon_provider").on(t.workspace_id, t.daemon_id, t.provider),
]);

export const daemonTokens = sqliteTable("daemon_tokens", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  token_hash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  revoked_at: text("revoked_at"),
  created_at: text("created_at").notNull(),
});

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  content: text("content").notNull(),
  config_json: text("config_json").notNull().default("{}"),
}, (t) => [
  uniqueIndex("skills_ws_name").on(t.workspace_id, t.name),
]);

export const skillFiles = sqliteTable("skill_files", {
  id: text("id").primaryKey(),
  skill_id: text("skill_id").notNull().references(() => skills.id),
  path: text("path").notNull(),
  content: text("content").notNull(),
});

export const agentSkills = sqliteTable("agent_skills", {
  agent_id: text("agent_id").notNull().references(() => agents.id),
  skill_id: text("skill_id").notNull().references(() => skills.id),
});
```

- [x] **Step 4: 实现 client.ts 与 drizzle.config.ts，生成迁移**

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

`apps/server/src/db/client.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import * as schema from "./schema.js";
import type { User, Workspace } from "@anvil/core";

export type Db = ReturnType<typeof createDrizzle> & {
  $client: Database.Database;
  prepare: Database.Database["prepare"]; // 服务层/测试写精确 SQL 用（认领、部分唯一索引等）
};

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = createDrizzle(sqlite) as Db;
  // 暴露 prepare/run 便于服务层写精确 SQL（认领、部分唯一索引等）
  (db as any).prepare = sqlite.prepare.bind(sqlite);
  return db;
}

const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "drizzle",
);

export function runMigrations(db: Db) {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_USER_ID = "00000000-0000-4000-8000-000000000002";

export function seed(db: Db): { workspace: Workspace; user: User } {
  const now = new Date().toISOString();
  db.insert(schema.workspaces)
    .values({ id: DEFAULT_WORKSPACE_ID, name: "Default", slug: "default", settings_json: "{}", created_at: now })
    .onConflictDoNothing()
    .run();
  db.insert(schema.users)
    .values({ id: DEFAULT_USER_ID, email: "owner@anvil.local", name: "Owner", created_at: now })
    .onConflictDoNothing()
    .run();
  db.insert(schema.workspaceMembers)
    .values({ workspace_id: DEFAULT_WORKSPACE_ID, user_id: DEFAULT_USER_ID, role: "owner" })
    .onConflictDoNothing()
    .run();
  const workspace = db.select().from(schema.workspaces).all().find((w) => w.slug === "default")! as Workspace;
  const user = db.select().from(schema.users).all().find((u) => u.id === DEFAULT_USER_ID)! as User;
  return { workspace, user };
}

export function newId(): string {
  return crypto.randomUUID();
}
```

- [x] **Step 5: 生成迁移文件并跑测试**

Run:

```bash
cd /d/anvil/apps/server && pnpm db:generate && cd /d/anvil && pnpm --filter @anvil/server test
```

Expected: `drizzle/` 下生成 `0000_*.sql`；测试 PASS（2 个用例）。若部分唯一索引未生成，检查 schema 中 `.where(sql\`...\`)` 是否生效，生成的 SQL 里应出现 `CREATE UNIQUE INDEX tasks_one_pending_per_issue ON tasks (issue_id) WHERE status IN ('queued','dispatched')`。

- [x] **Step 6: Commit**

```bash
git add apps/server && git commit -m "feat(server): drizzle schema (13 tables) + migrations + seed"
```

---

## Task 3: server —— issue CRUD、入队触发、基础路由骨架

**Files:**
- Create: `apps/server/src/lib/hash.ts`
- Create: `apps/server/src/ws/hub.ts`
- Create: `apps/server/src/services/issues.ts`
- Create: `apps/server/src/routes/issues.ts`
- Create: `apps/server/src/routes/meta.ts`
- Create: `apps/server/src/app.ts`
- Test: `apps/server/test/issues.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/issues.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let workspaceId: string;
let agentId: string;
let userId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
  workspaceId = boot.json().workspace.id;
  userId = boot.json().user.id;
  const a = await app.inject({
    method: "POST", url: "/api/agents",
    payload: { name: "bot", provider: "kimi" },
  });
  agentId = a.json().id;
});

async function createIssue(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("issue CRUD + enqueue triggers", () => {
  it("assign to agent with status todo → queued task created", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    expect(issue.status).toBe("todo");
    const list = await app.inject({ method: "GET", url: `/api/issues?workspace_id=${workspaceId}` });
    expect(list.json()).toHaveLength(1);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(1);
    expect(tasks.json()[0].status).toBe("queued");
    expect(tasks.json()[0].agent_id).toBe(agentId);
  });

  it("backlog does not trigger; moving backlog→todo with agent assignee triggers", async () => {
    const issue = await createIssue({ status: "backlog", assignee_type: "agent", assignee_id: agentId });
    let tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { status: "todo" } });
    tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(1);
  });

  it("assign to member → no task", async () => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: userId });
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
  });

  it("rerun creates a new task after previous reached terminal state", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    let res = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` });
    expect(res.statusCode).toBe(409); // 已有 pending 任务
    const db = app.db;
    db.prepare(`UPDATE tasks SET status='failed', failure_reason='non_zero_exit'`).run();
    res = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` });
    expect(res.statusCode).toBe(201);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(2);
  });

  it("issue detail includes comments; adding comment works", async () => {
    const issue = await createIssue();
    const c = await app.inject({
      method: "POST", url: `/api/issues/${issue.id}/comments`,
      payload: { body: "补充说明" },
    });
    expect(c.statusCode).toBe(201);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().comments).toHaveLength(1);
    expect(detail.json().comments[0].body).toBe("补充说明");
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL，`../src/app.js` 不存在。

- [x] **Step 3: 实现 hash.ts、hub.ts、services/issues.ts**

`apps/server/src/lib/hash.ts`:

```ts
import crypto from "node:crypto";
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
```

`apps/server/src/ws/hub.ts`:

```ts
import type { WebSocket } from "ws";
import type { ServerEvent } from "@anvil/core";

/** 极简连接池：web 端 WS 订阅 + server 内广播。runner hint 通道复用同一池（按 kind 区分）。 */
export class Hub {
  private webSockets = new Set<WebSocket>();
  private daemonSockets = new Set<WebSocket>();

  addWeb(ws: WebSocket) { this.webSockets.add(ws); ws.on("close", () => this.webSockets.delete(ws)); }
  addDaemon(ws: WebSocket) { this.daemonSockets.add(ws); ws.on("close", () => this.daemonSockets.delete(ws)); }

  broadcast(event: ServerEvent) {
    const raw = JSON.stringify(event);
    for (const ws of this.webSockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  }

  /** 给 runner 的"有活了"轻提示；丢了无害。 */
  hintDaemons(event: ServerEvent) {
    const raw = JSON.stringify(event);
    for (const ws of this.daemonSockets) if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}
```

`apps/server/src/services/issues.ts`:

```ts
import { eq } from "drizzle-orm";
import { newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { priorityWeight, type CreateIssueRequest, type Issue, type Task, type UpdateIssueRequest } from "@anvil/core";

function rowToIssue(r: typeof schema.issues.$inferSelect): Issue {
  return r as unknown as Issue;
}

export function getIssue(db: Db, id: string): Issue | null {
  const rows = db.select().from(schema.issues).where(eq(schema.issues.id, id)).all();
  return rows[0] ? rowToIssue(rows[0]) : null;
}

export function listIssues(db: Db, workspaceId: string): Issue[] {
  return db.select().from(schema.issues).where(eq(schema.issues.workspace_id, workspaceId)).all()
    .map(rowToIssue)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

/** 入队判定（spec §6 三个入口共用的唯一函数）：assignee 是 agent 且状态非 backlog 才入队。 */
export function enqueueForIssue(db: Db, issue: Issue, trigger: string): Task | null {
  if (issue.assignee_type !== "agent" || !issue.assignee_id) return null;
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return null;
  const now = new Date().toISOString();
  const id = newId();
  try {
    db.insert(schema.tasks).values({
      id, workspace_id: issue.workspace_id, issue_id: issue.id,
      agent_id: issue.assignee_id, status: "queued",
      priority: priorityWeight(issue.priority), attempt: 1, max_attempts: 3,
      created_at: now,
    }).run();
  } catch (e: any) {
    // better-sqlite3 对部分唯一索引的报错不含索引名（形如 UNIQUE constraint failed: tasks.issue_id），两种都匹配
    const msg = String(e?.message);
    if (msg.includes("tasks_one_pending_per_issue") || msg.includes("UNIQUE constraint failed: tasks.issue_id")) return null; // 已有 pending，幂等
    throw e;
  }
  addComment(db, issue.id, { author_type: "system", author_id: "system", type: "system", body: `任务已入队（触发：${trigger}）` });
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).all()[0] as unknown as Task;
}

export function addComment(
  db: Db, issueId: string,
  c: { author_type: string; author_id: string; type: string; body: string },
) {
  const id = newId();
  db.insert(schema.comments).values({
    id, issue_id: issueId, author_type: c.author_type, author_id: c.author_id,
    type: c.type, body: c.body, created_at: new Date().toISOString(),
  }).run();
  return id;
}

export function createIssueRow(db: Db, workspaceId: string, userId: string, req: CreateIssueRequest & { status?: string }): Issue {
  const now = new Date().toISOString();
  const id = newId();
  const status = (req.status as any) ?? "todo";
  db.insert(schema.issues).values({
    id, workspace_id: workspaceId, title: req.title, description: req.description ?? null,
    status, priority: req.priority ?? "medium",
    assignee_type: req.assignee_type ?? null, assignee_id: req.assignee_id ?? null,
    creator_type: "member", creator_id: userId,
    repo_path: req.repo_path ?? null,
    position: Date.now(), created_at: now, updated_at: now,
  }).run();
  return getIssue(db, id)!;
}

export function updateIssueRow(db: Db, id: string, req: UpdateIssueRequest): Issue | null {
  const cur = getIssue(db, id);
  if (!cur) return null;
  db.update(schema.issues).set({
    title: req.title ?? cur.title,
    description: req.description !== undefined ? req.description : cur.description,
    status: (req.status as any) ?? cur.status,
    priority: req.priority ?? cur.priority,
    assignee_type: req.assignee_type !== undefined ? req.assignee_type : cur.assignee_type,
    assignee_id: req.assignee_id !== undefined ? req.assignee_id : cur.assignee_id,
    repo_path: req.repo_path !== undefined ? req.repo_path : cur.repo_path,
    updated_at: new Date().toISOString(),
  }).where(eq(schema.issues.id, id)).run();
  return getIssue(db, id);
}

export function listTasksForIssue(db: Db, issueId: string): Task[] {
  return db.select().from(schema.tasks).where(eq(schema.tasks.issue_id, issueId)).all() as unknown as Task[];
}
```

- [x] **Step 4: 实现路由与 app.ts**

`apps/server/src/routes/issues.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { addComment, createIssueRow, enqueueForIssue, getIssue, listIssues, listTasksForIssue, updateIssueRow } from "../services/issues.js";
import { seed } from "../db/client.js";
import type { CreateIssueRequest, UpdateIssueRequest } from "@anvil/core";

export function registerIssueRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  app.get("/api/issues", async (req) => {
    const { workspace_id } = req.query as { workspace_id: string };
    return listIssues(db, workspace_id);
  });

  app.post("/api/issues", async (req, reply) => {
    const { user, workspace } = seed(db);
    const body = req.body as CreateIssueRequest & { status?: string };
    if (!body.title) return reply.code(400).send({ error: "title required" });
    let issue = createIssueRow(db, workspace.id, user.id, body);
    const wasActive = issue.status !== "backlog";
    if (wasActive) {
      const task = enqueueForIssue(db, issue, "assign");
      if (task) hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    }
    hub.broadcast({ type: "issue.updated", data: issue });
    return reply.code(201).send(issue);
  });

  app.patch("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const before = getIssue(db, id);
    if (!before) return reply.code(404).send({ error: "not found" });
    const body = req.body as UpdateIssueRequest;
    if (body.status && before.status !== body.status) {
      addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "status_change", body: `${before.status} → ${body.status}` });
    }
    const after = updateIssueRow(db, id, body)!;
    // 触发入队：改派给 agent / 从 backlog 移出且 assignee 是 agent
    const becameActive = before.status === "backlog" && after.status !== "backlog";
    const assignedAgent = after.assignee_type === "agent" &&
      (before.assignee_id !== after.assignee_id || before.assignee_type !== "agent");
    if ((becameActive || assignedAgent) && after.assignee_type === "agent") {
      const task = enqueueForIssue(db, after, becameActive ? "status" : "assign");
      if (task) hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    }
    hub.broadcast({ type: "issue.updated", data: after });
    return after;
  });

  app.post("/api/issues/:id/rerun", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(db, id);
    if (!issue) return reply.code(404).send({ error: "not found" });
    const task = enqueueForIssue(db, issue, "rerun");
    if (!task) return reply.code(409).send({ error: "已有 pending 任务或 assignee 不是 agent" });
    hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    return reply.code(201).send(task);
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(db, id);
    if (!issue) return reply.code(404).send({ error: "not found" });
    const commentRows = db.$client
      .prepare(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
      .all(id);
    return { issue, comments: commentRows };
  });

  app.get("/api/issues/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return listTasksForIssue(db, id);
  });

  app.post("/api/issues/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getIssue(db, id)) return reply.code(404).send({ error: "not found" });
    const { body } = req.body as { body: string };
    if (!body) return reply.code(400).send({ error: "body required" });
    const cid = addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "comment", body });
    hub.broadcast({ type: "issue.updated", data: getIssue(db, id) });
    return reply.code(201).send({ id: cid });
  });
}
```

`apps/server/src/routes/meta.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { seed, newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import crypto from "node:crypto";

export function registerMetaRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/bootstrap", async () => seed(db));

  app.get("/api/agents", async () => {
    return db.select().from(schema.agents).all();
  });

  app.post("/api/agents", async (req, reply) => {
    const { workspace } = seed(db);
    const body = req.body as { name: string; provider: string; max_concurrent_tasks?: number };
    if (!body.name || !body.provider) return reply.code(400).send({ error: "name/provider required" });
    const id = newId();
    db.insert(schema.agents).values({
      id, workspace_id: workspace.id, name: body.name, provider: body.provider,
      status: "idle", max_concurrent_tasks: body.max_concurrent_tasks ?? 1,
      created_at: new Date().toISOString(),
    }).run();
    return reply.code(201).send(db.select().from(schema.agents).where(eq(schema.agents.id, id)).all()[0]);
  });

  app.get("/api/runtimes", async () => {
    return db.select().from(schema.runtimes).all();
  });

  // 自用 v1：web 端创建 daemon token，明文仅本响应返回一次，库中只存哈希
  app.post("/api/daemon-tokens", async (req, reply) => {
    const { workspace } = seed(db);
    const { label } = (req.body ?? {}) as { label?: string };
    const token = `anv_${crypto.randomBytes(24).toString("hex")}`;
    const id = newId();
    db.insert(schema.daemonTokens).values({
      id, workspace_id: workspace.id, token_hash: sha256Hex(token),
      label: label ?? "default", created_at: new Date().toISOString(),
    }).run();
    return reply.code(201).send({ id, token });
  });
}
```

`apps/server/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { createDb, runMigrations, seed, type Db } from "./db/client.js";
import { Hub } from "./ws/hub.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerMetaRoutes } from "./routes/meta.js";

declare module "fastify" {
  interface FastifyInstance { db: Db; hub: Hub; }
}

export interface BuildAppOptions { dbPath: string; logger?: boolean; }

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const db = createDb(opts.dbPath);
  runMigrations(db);
  seed(db);
  const hub = new Hub();
  app.decorate("db", db);
  app.decorate("hub", hub);

  await app.register(websocket);
  app.get("/ws", { websocket: true }, (socket) => { hub.addWeb(socket); });

  registerMetaRoutes(app, db);
  registerIssueRoutes(app, db, hub);
  return app;
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/server test`
Expected: PASS（db 2 + issues 5 = 7 个用例）。

- [x] **Step 6: Commit**

```bash
git add apps/server && git commit -m "feat(server): issue CRUD + enqueue triggers + bootstrap/agents/runtimes routes"
```

---

## Task 4: server —— daemon 认证、原子认领（claim）、租约

**Files:**
- Create: `apps/server/src/lib/auth.ts`
- Create: `apps/server/src/services/tasks.ts`
- Create: `apps/server/src/routes/daemon.ts`
- Modify: `apps/server/src/app.ts`（注册 daemon 路由）
- Test: `apps/server/test/claim.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/claim.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let agentId: string;
let issueId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } });
  token = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", assignee_type: "agent", assignee_id: agentId },
  });
  issueId = i.json().id;
  // 注册 daemon（携带 kimi runtime），使 claim 有可用执行体
  await app.inject({
    method: "POST", url: "/api/daemon/register",
    headers: { authorization: `Bearer ${token}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1.0.0" }] },
  });
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("daemon auth + claim", () => {
  it("rejects claim without token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", payload: { daemon_id: "d1" } });
    expect(res.statusCode).toBe(401);
  });

  it("claims queued task atomically: second claim gets nothing", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r1.statusCode).toBe(200);
    const body = r1.json();
    expect(body.tasks).toHaveLength(1);
    const pkg = body.tasks[0];
    expect(pkg.task.status).toBe("dispatched");
    expect(pkg.task.lease_expires_at).toBeTruthy();
    expect(pkg.task_token).toMatch(/^atk_/);
    expect(pkg.issue.id).toBe(issueId);
    expect(pkg.prior_work_dir).toBeNull();

    const r2 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r2.json().tasks).toHaveLength(0);
  });

  it("concurrent claims: only one winner", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
    ]);
    const total = r1.json().tasks.length + r2.json().tasks.length;
    expect(total).toBe(1);
  });

  it("respects agent max_concurrent_tasks", async () => {
    // 先领走唯一任务（agent 上限 1）
    await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    // 再造一个 issue（会入队第二个任务），但 agent 已有 1 个 dispatched
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "second", assignee_type: "agent", assignee_id: agentId } });
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(res.json().tasks).toHaveLength(0);
  });

  it("priority order: urgent claimed before medium", async () => {
    // 第一个任务领走后清空，重新造两个不同优先级任务
    const db = app.db;
    db.prepare(`DELETE FROM tasks`).run();
    const mk = async (priority: string) => {
      await app.inject({ method: "POST", url: "/api/issues", payload: { title: priority, priority, assignee_type: "agent", assignee_id: agentId } });
    };
    await mk("medium");
    await mk("urgent");
    // agent 上限提到 2 一次领完
    db.prepare(`UPDATE agents SET max_concurrent_tasks=2 WHERE id=?`).run(agentId);
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1", max_tasks: 2 } });
    expect(res.json().tasks).toHaveLength(2);
    expect(res.json().tasks[0].issue.title).toBe("urgent");
  });

  it("task token authorizes task-scoped endpoints", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const pkg = r1.json().tasks[0];
    const bad = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: "Bearer wrong" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("dispatched");
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL（auth/claim 相关模块不存在）。

- [x] **Step 3: 实现 auth.ts 与 services/tasks.ts（claim 部分）**

`apps/server/src/lib/auth.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { sha256Hex } from "./hash.js";

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

/** daemon token 预校验：通过则给 request 挂上 workspaceId。 */
export function makeDaemonAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ error: "missing token" });
    const row = db.$client
      .prepare(`SELECT * FROM daemon_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(sha256Hex(token)) as any;
    if (!row) return reply.code(401).send({ error: "invalid token" });
    (req as any).workspaceId = row.workspace_id;
  };
}

/** task token 预校验：哈希匹配且 task id 与路径一致。 */
export function makeTaskAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const { id } = req.params as { id: string };
    if (!token) return reply.code(401).send({ error: "missing token" });
    const row = db.$client
      .prepare(`SELECT id FROM tasks WHERE id = ? AND task_token_hash = ?`)
      .get(id, sha256Hex(token)) as any;
    if (!row) return reply.code(401).send({ error: "invalid task token" });
  };
}
```

`apps/server/src/services/tasks.ts`:

```ts
import crypto from "node:crypto";
import { newId, type Db } from "../db/client.js";
import { sha256Hex } from "../lib/hash.js";
import { getIssue, addComment } from "./issues.js";
import type { Task, TaskPackage } from "@anvil/core";

export const LEASE_MS = 2 * 60 * 1000;

export function getTask(db: Db, id: string): Task | null {
  const row = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  return row ?? null;
}

/**
 * 原子认领：候选按 priority DESC, created_at ASC 排序；
 * 逐个用单条 UPDATE ... WHERE status='queued' 判赢（better-sqlite3 同步执行 + SQLite 单写者，
 * 语义等价 FOR UPDATE SKIP LOCKED）。认领前检查 agent 并发上限。
 */
export function claimTasks(db: Db, workspaceId: string, daemonId: string, maxTasks: number): TaskPackage[] {
  const providers = (db.$client
    .prepare(`SELECT provider FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND status = 'online'`)
    .all(workspaceId, daemonId) as any[]).map((r) => r.provider);
  if (providers.length === 0) return [];

  const out: TaskPackage[] = [];
  const candidates = db.$client
    .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND status = 'queued'
              ORDER BY priority DESC, created_at ASC LIMIT 50`)
    .all(workspaceId) as any[];

  for (const cand of candidates) {
    if (out.length >= maxTasks) break;
    const agent = db.$client.prepare(`SELECT * FROM agents WHERE id = ?`).get(cand.agent_id) as any;
    if (!agent || !providers.includes(agent.provider)) continue;
    const running = db.$client
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('dispatched','running')`)
      .get(cand.agent_id) as any;
    if (running.n >= agent.max_concurrent_tasks) continue;

    const runtime = db.$client
      .prepare(`SELECT * FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND provider = ? AND status = 'online'`)
      .get(workspaceId, daemonId, agent.provider) as any;
    const taskToken = `atk_${crypto.randomBytes(24).toString("hex")}`;
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const now = new Date().toISOString();
    const res = db.$client
      .prepare(`UPDATE tasks SET status='dispatched', runtime_id=?, task_token_hash=?, lease_expires_at=?, dispatched_at=?
                WHERE id=? AND status='queued'`)
      .run(runtime.id, sha256Hex(taskToken), lease, now, cand.id);
    if (res.changes !== 1) continue; // 被别人抢先

    // 同 issue 上一次完成任务的 work_dir，用于会话连续性
    const prior = db.$client
      .prepare(`SELECT work_dir FROM tasks WHERE issue_id = ? AND id != ? AND work_dir IS NOT NULL
                ORDER BY created_at DESC LIMIT 1`)
      .get(cand.issue_id, cand.id) as any;
    const task = getTask(db, cand.id)!;
    const issue = getIssue(db, cand.issue_id)!;
    out.push({ task, issue, prior_work_dir: prior?.work_dir ?? null, task_token: taskToken });
  }
  return out;
}
```

- [x] **Step 4: 实现 routes/daemon.ts 并接入 app.ts**

`apps/server/src/routes/daemon.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { makeDaemonAuth, makeTaskAuth } from "../lib/auth.js";
import { claimTasks, getTask } from "../services/tasks.js";
import { registerRuntimes, heartbeat } from "../services/runtimes.js";
import type { ClaimRequest, DaemonHeartbeatRequest, DaemonRegisterRequest } from "@anvil/core";

export function registerDaemonRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  const daemonAuth = makeDaemonAuth(db);
  const taskAuth = makeTaskAuth(db);

  app.post("/api/daemon/register", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as DaemonRegisterRequest;
    return { runtimes: registerRuntimes(db, (req as any).workspaceId, body.daemon_id, body.runtimes) };
  });

  app.post("/api/daemon/heartbeat", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as DaemonHeartbeatRequest;
    heartbeat(db, (req as any).workspaceId, body.daemon_id);
    return { ok: true };
  });

  app.post("/api/daemon/claim", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as ClaimRequest;
    const tasks = claimTasks(db, (req as any).workspaceId, body.daemon_id, body.max_tasks ?? 1);
    return { tasks };
  });

  app.get("/api/daemon/ws", { websocket: true, preHandler: daemonAuth }, (socket) => {
    hub.addDaemon(socket);
  });

  app.get("/api/daemon/tasks/:id/status", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { status: task.status };
  });
}
```

`apps/server/src/app.ts` —— 在 `registerIssueRoutes(app, db, hub);` 一行后追加：

```ts
  const { registerDaemonRoutes } = await import("./routes/daemon.js");
  registerDaemonRoutes(app, db, hub);
```

（runner runtime 服务在下一个 Task 实现；此处 import 会在 Task 5 完成后通过编译，两个 Task 一起跑测试。）

- [x] **Step 5: 跑测试（预期仍失败，等 Task 5 补齐 runtimes 服务）**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL，`./services/runtimes.js` 不存在——这是预期的，直接进入 Task 5。

- [x] **Step 6: （暂不 commit，与 Task 5 合并提交）**

---

## Task 5: server —— runtime 注册、心跳、离线清扫

**Files:**
- Create: `apps/server/src/services/runtimes.ts`
- Modify: `apps/server/src/app.ts`（挂清扫定时器）
- Test: `apps/server/test/runtimes.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/runtimes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { registerRuntimes, heartbeat, sweepOfflineRuntimes, OFFLINE_AFTER_MS } from "../src/services/runtimes.js";
import { seed } from "../src/db/client.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

describe("runtimes", () => {
  it("register upserts by (workspace, daemon, provider)", () => {
    const db = app.db;
    const { workspace } = seed(db);
    const r1 = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    const r2 = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.1" }]);
    expect(r2[0].id).toBe(r1[0].id);
    expect(r2[0].version).toBe("1.1");
    expect(r2[0].status).toBe("online");
  });

  it("heartbeat refreshes last_seen_at", () => {
    const db = app.db;
    const { workspace } = seed(db);
    registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    db.$client.prepare(`UPDATE runtimes SET last_seen_at = '2000-01-01T00:00:00.000Z'`).run();
    heartbeat(db, workspace.id, "d1");
    const row = db.$client.prepare(`SELECT * FROM runtimes`).get() as any;
    expect(row.last_seen_at > "2000-01-01").toBe(true);
  });

  it("sweep marks stale runtimes offline and fails their tasks", () => {
    const db = app.db;
    const { workspace } = seed(db);
    const [rt] = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    const now = new Date().toISOString();
    db.$client.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
                        VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspace.id, now);
    db.$client.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
                        VALUES ('i1', ?, 't', 'in_progress', 'medium', 'member', 'u', 1, ?, ?)`).run(workspace.id, now, now);
    db.$client.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, runtime_id, status, priority, attempt, max_attempts, created_at, started_at)
                        VALUES ('t1', ?, 'i1', 'a1', ?, 'running', 20, 1, 3, ?, ?)`).run(workspace.id, rt.id, now, now);
    // 心跳停在阈值之前
    const stale = new Date(Date.now() - OFFLINE_AFTER_MS - 1000).toISOString();
    db.$client.prepare(`UPDATE runtimes SET last_seen_at = ?`).run(stale);

    const swept = sweepOfflineRuntimes(db, new Date().toISOString());
    expect(swept).toBe(1);
    const task = db.$client.prepare(`SELECT * FROM tasks WHERE id='t1'`).get() as any;
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toBe("runtime_offline");
    const runtime = db.$client.prepare(`SELECT * FROM runtimes WHERE id=?`).get(rt.id) as any;
    expect(runtime.status).toBe("offline");
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL，`services/runtimes.js` 不存在。

- [x] **Step 3: 实现 services/runtimes.ts**

`apps/server/src/services/runtimes.ts`:

```ts
import { newId, type Db } from "../db/client.js";
import type { Runtime } from "@anvil/core";
import { failTaskInternal } from "./tasks.js";

export const OFFLINE_AFTER_MS = 60 * 1000;

export function registerRuntimes(
  db: Db, workspaceId: string, daemonId: string,
  list: { provider: string; version: string | null }[],
): Runtime[] {
  const now = new Date().toISOString();
  const out: Runtime[] = [];
  for (const r of list) {
    const existing = db.$client
      .prepare(`SELECT * FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND provider = ?`)
      .get(workspaceId, daemonId, r.provider) as any;
    if (existing) {
      db.$client
        .prepare(`UPDATE runtimes SET version = ?, status = 'online', last_seen_at = ? WHERE id = ?`)
        .run(r.version, now, existing.id);
      out.push({ ...existing, version: r.version, status: "online", last_seen_at: now });
    } else {
      const id = newId();
      db.$client
        .prepare(`INSERT INTO runtimes (id, workspace_id, daemon_id, provider, version, status, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, 'online', ?)`)
        .run(id, workspaceId, daemonId, r.provider, r.version, now);
      out.push({ id, workspace_id: workspaceId, daemon_id: daemonId, provider: r.provider, version: r.version, status: "online", last_seen_at: now });
    }
  }
  return out;
}

export function heartbeat(db: Db, workspaceId: string, daemonId: string) {
  db.$client
    .prepare(`UPDATE runtimes SET status = 'online', last_seen_at = ? WHERE workspace_id = ? AND daemon_id = ?`)
    .run(new Date().toISOString(), workspaceId, daemonId);
}

/** 离线清扫：心跳超阈值的 runtime 置 offline；其 dispatched/running 任务按 runtime_offline 失败（走重试链）。 */
export function sweepOfflineRuntimes(db: Db, nowIso: string): number {
  const cutoff = new Date(Date.parse(nowIso) - OFFLINE_AFTER_MS).toISOString();
  const stale = db.$client
    .prepare(`SELECT * FROM runtimes WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)`)
    .all(cutoff) as any[];
  let count = 0;
  for (const rt of stale) {
    db.$client.prepare(`UPDATE runtimes SET status = 'offline' WHERE id = ?`).run(rt.id);
    const tasks = db.$client
      .prepare(`SELECT id FROM tasks WHERE runtime_id = ? AND status IN ('dispatched','running')`)
      .all(rt.id) as any[];
    for (const t of tasks) {
      failTaskInternal(db, t.id, "runtime_offline", `runtime ${rt.id} offline`, null);
    }
    count++;
  }
  return count;
}
```

- [x] **Step 4: 在 tasks.ts 末尾补 failTaskInternal（完整版在 Task 7 扩展，此处先满足离线清扫）**

在 `apps/server/src/services/tasks.ts` 末尾追加：

```ts
/** 失败落库 + 有限重试：attempt 未满则派生子任务重新入队。 */
export function failTaskInternal(db: Db, taskId: string, reason: string, error: string, workDir: string | null) {
  const task = getTask(db, taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
  const now = new Date().toISOString();
  db.$client
    .prepare(`UPDATE tasks SET status='failed', failure_reason=?, error=?, completed_at=?, work_dir=COALESCE(?, work_dir),
              task_token_hash=NULL, lease_expires_at=NULL WHERE id=?`)
    .run(reason, error, now, workDir, taskId);
  if (task.attempt < task.max_attempts) {
    db.$client
      .prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, parent_task_id, created_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(newId(), task.workspace_id, task.issue_id, task.agent_id, task.priority, task.attempt + 1, task.max_attempts, task.id, now);
    addComment(db, task.issue_id, {
      author_type: "system", author_id: "system", type: "system",
      body: `任务失败（${reason}），自动重试 ${task.attempt + 1}/${task.max_attempts}`,
    });
  }
}
```

并在 `apps/server/src/services/tasks.ts` 顶部 import 区补上 `newId`（已存在则跳过）。

- [x] **Step 5: app.ts 挂清扫定时器**

`apps/server/src/app.ts` —— 在 `registerIssueRoutes(app, db, hub);` 之后追加：

```ts
  const { sweepOfflineRuntimes } = await import("./services/runtimes.js");
  const sweepTimer = setInterval(() => {
    try { sweepOfflineRuntimes(db, new Date().toISOString()); }
    catch (e) { app.log.error(e, "sweepOfflineRuntimes failed"); }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweepTimer));
```

- [x] **Step 6: 跑全部 server 测试确认通过**

Run: `pnpm --filter @anvil/server test`
Expected: PASS（db 2 + issues 5 + claim 6 + runtimes 3 = 16 个用例）。

- [x] **Step 7: Commit（包含 Task 4）**

```bash
git add apps/server && git commit -m "feat(server): daemon auth, atomic claim with lease, runtime registry + offline sweep"
```

---

## Task 6: server —— transcript 批量上报、seq 校验、WS 广播、消息读取

**Files:**
- Create: `apps/server/src/services/messages.ts`
- Modify: `apps/server/src/routes/daemon.ts`（挂消息路由）
- Create: `apps/server/src/routes/tasks.ts`
- Modify: `apps/server/src/app.ts`（注册 task 查询路由）
- Test: `apps/server/test/messages.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/messages.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pkg: any;
let taskToken: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: a.json().id } });
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  pkg = c.json().tasks[0];
  taskToken = pkg.task_token;
});

const post = (url: string, payload: unknown, token = taskToken) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe("task messages", () => {
  it("appends batch with continuous seq and reads back", async () => {
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, {
      messages: [
        { seq: 0, type: "text", content: "hello" },
        { seq: 1, type: "tool_use", tool: "Bash", input: { cmd: "ls" } },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().last_seq).toBe(1);

    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages?after_seq=-1` });
    expect(got.json()).toHaveLength(2);
    expect(got.json()[1].tool).toBe("Bash");
    expect(got.json()[1].input_json).toBe('{"cmd":"ls"}');

    const incremental = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages?after_seq=0` });
    expect(incremental.json()).toHaveLength(1);
  });

  it("rejects seq gap with 409 + last_seq for resync", async () => {
    await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 0, type: "text", content: "a" }] });
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 5, type: "text", content: "b" }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().last_seq).toBe(0);
    // 从 last_seq+1 重发即恢复
    const ok = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 1, type: "text", content: "b" }] });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects messages with wrong token", async () => {
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 0, type: "text", content: "x" }] }, "bad");
    expect(res.statusCode).toBe(401);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL，`services/messages.js` 与消息路由不存在。

- [x] **Step 3: 实现 services/messages.ts**

`apps/server/src/services/messages.ts`:

```ts
import { newId, type Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import type { MessageBatchItem } from "@anvil/core";

export function lastSeq(db: Db, taskId: string): number {
  const row = db.$client.prepare(`SELECT MAX(seq) AS m FROM task_messages WHERE task_id = ?`).get(taskId) as any;
  return row?.m ?? -1;
}

/** 落库一批消息；seq 必须从 last_seq+1 连续，否则返回冲突让 runner 重发。 */
export function appendTaskMessages(
  db: Db, hub: Hub, taskId: string, items: MessageBatchItem[],
): { ok: true; last_seq: number } | { ok: false; last_seq: number } {
  if (items.length === 0) return { ok: true, last_seq: lastSeq(db, taskId) };
  const expected = lastSeq(db, taskId) + 1;
  if (items[0].seq !== expected) return { ok: false, last_seq: expected - 1 };
  const insert = db.$client.prepare(
    `INSERT INTO task_messages (id, task_id, seq, type, tool, content, input_json, output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  const tx = db.$client.transaction((rows: MessageBatchItem[]) => {
    let seq = expected;
    for (const m of rows) {
      if (m.seq !== seq) throw new Error("seq gap within batch");
      insert.run(newId(), taskId, m.seq, m.type, m.tool ?? null, m.content ?? null,
        m.input !== undefined ? JSON.stringify(m.input) : null,
        m.output !== undefined ? String(m.output) : null, now);
      seq++;
    }
  });
  tx(items);
  for (const m of items) hub.broadcast({ type: "task.message", data: { task_id: taskId, ...m } });
  return { ok: true, last_seq: expected + items.length - 1 };
}

export function listMessages(db: Db, taskId: string, afterSeq: number) {
  return db.$client
    .prepare(`SELECT seq, type, tool, content, input_json, output, created_at FROM task_messages
              WHERE task_id = ? AND seq > ? ORDER BY seq ASC`)
    .all(taskId, afterSeq);
}
```

- [x] **Step 4: 挂 daemon 消息路由 + web 侧任务查询路由**

`apps/server/src/routes/daemon.ts` —— 顶部 import 区追加：

```ts
import { appendTaskMessages } from "../services/messages.js";
```

并在 `registerDaemonRoutes` 函数内、`status` 路由后追加：

```ts
  app.post("/api/daemon/tasks/:id/messages", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { messages } = req.body as { messages: any[] };
    const result = appendTaskMessages(db, hub, id, messages);
    if (!result.ok) return reply.code(409).send({ last_seq: result.last_seq });
    return result;
  });
```

`apps/server/src/routes/tasks.ts`（新文件）:

```ts
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getTask } from "../services/tasks.js";
import { listMessages } from "../services/messages.js";
import { getIssue } from "../services/issues.js";

export function registerTaskRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { task, issue: getIssue(db, task.issue_id) };
  });

  app.get("/api/tasks/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const { after_seq } = req.query as { after_seq?: string };
    return listMessages(db, id, after_seq !== undefined ? Number(after_seq) : -1);
  });
}
```

`apps/server/src/app.ts` —— 在 daemon 路由注册行之后追加：

```ts
  const { registerTaskRoutes } = await import("./routes/tasks.js");
  registerTaskRoutes(app, db);
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/server test`
Expected: PASS（新增 3 个用例，累计 19）。

- [x] **Step 6: Commit**

```bash
git add apps/server && git commit -m "feat(server): transcript batch upload with seq check + WS broadcast + message read"
```

---

## Task 7: server —— start / complete / fail / 重试 / 租约清扫 / 取消 / Agent 回调改 issue 状态

**Files:**
- Modify: `apps/server/src/services/tasks.ts`（补 startTask/completeTask/sweepExpiredLeases/cancelTask/setIssueStatusFromAgent）
- Modify: `apps/server/src/routes/daemon.ts`（挂 start/complete/fail/issue-status 路由）
- Modify: `apps/server/src/routes/tasks.ts`（挂 cancel 路由）
- Modify: `apps/server/src/app.ts`（租约清扫进定时器）
- Test: `apps/server/test/lifecycle.test.ts`

- [x] **Step 1: 写失败测试**

`apps/server/test/lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;
let issueId: string;

async function claimOne() {
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  return c.json().tasks[0] as any;
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: agentId } });
  issueId = i.json().id;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
});

const tpost = (url: string, payload: unknown, token: string) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe("task lifecycle", () => {
  it("start → running; complete → completed with result", async () => {
    const pkg = await claimOne();
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    expect(s.statusCode).toBe(200);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "task/abc", diff_stat: "2 files changed", work_dir: "/tmp/w1" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toBe("/tmp/w1");
    // 完成后 token 失效
    const again = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {}, pkg.task_token);
    expect(again.statusCode).toBe(401);
  });

  it("fail creates retry child until max_attempts", async () => {
    const pkg = await claimOne();
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg.task_token);
    expect(f.statusCode).toBe(200);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks.json()).toHaveLength(2);
    const child = tasks.json().find((t: any) => t.parent_task_id === pkg.task.id);
    expect(child.status).toBe("queued");
    expect(child.attempt).toBe(2);

    // 把子任务也耗到超限：max_attempts=1 时不再派生
    app.db.$client.prepare(`UPDATE tasks SET attempt = 3, max_attempts = 3 WHERE id = ?`).run(child.id);
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(child.id);
    await tpost(`/api/daemon/tasks/${pkg2.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg2.task_token);
    const tasks2 = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks2.json()).toHaveLength(2); // 不再派生
  });

  it("expired lease requeues task and clears token", async () => {
    const pkg = await claimOne();
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.$client.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past, pkg.task.id);
    const { sweepExpiredLeases } = await import("../src/services/tasks.js");
    expect(sweepExpiredLeases(app.db, new Date().toISOString())).toBe(1);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("queued");
    // 旧 token 已作废
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/x" }, pkg.task_token);
    expect(s.statusCode).toBe(401);
    // 可以被重新认领
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(pkg.task.id);
  });

  it("cancel from web sets cancelled; runner status endpoint reflects it", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    expect(res.statusCode).toBe(200);
    const st = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    // 取消后 token 已清，走 401 也算 runner 能感知终态；但设计是 runner 先轮询到 cancelled——因此 cancel 不清 token
    expect([200, 401]).toContain(st.statusCode);
    if (st.statusCode === 200) expect(st.json().status).toBe("cancelled");
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled");
  });

  it("agent callback moves issue to in_review and writes timeline", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const res = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "in_review", note: "做完了，请 review" }, pkg.task_token);
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    expect(detail.json().issue.status).toBe("in_review");
    expect(detail.json().comments.some((c: any) => c.type === "status_change")).toBe(true);
    // 非法目标状态被拒绝
    const bad = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "todo" }, pkg.task_token);
    expect(bad.statusCode).toBe(400);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/server test`
Expected: FAIL（start/complete/fail/issue-status/cancel 路由未实现）。

- [x] **Step 3: 扩展 services/tasks.ts**

在 `apps/server/src/services/tasks.ts` 末尾追加：

```ts
export function startTask(db: Db, taskId: string, workDir: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='running', started_at=?, work_dir=? WHERE id=? AND status='dispatched'`)
    .run(now, workDir, taskId);
  return res.changes === 1;
}

export function completeTask(db: Db, taskId: string, result: { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string }): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='completed', result_json=?, completed_at=?,
              work_dir=COALESCE(?, work_dir), session_id=COALESCE(?, session_id),
              task_token_hash=NULL, lease_expires_at=NULL
              WHERE id=? AND status IN ('dispatched','running')`)
    .run(JSON.stringify(result), now, result.work_dir ?? null, result.session_id ?? null, taskId);
  return res.changes === 1;
}

/** 租约清扫：dispatched 且租约过期 → 回 queued，token 作废，等待重新认领。 */
export function sweepExpiredLeases(db: Db, nowIso: string): number {
  const res = db.$client
    .prepare(`UPDATE tasks SET status='queued', runtime_id=NULL, task_token_hash=NULL,
              lease_expires_at=NULL, dispatched_at=NULL
              WHERE status='dispatched' AND lease_expires_at < ?`)
    .run(nowIso);
  return res.changes;
}

/** 看板取消：置 cancelled + failure_reason=cancelled_by_user。保留 token 让 runner 轮询能读到终态。 */
export function cancelTask(db: Db, taskId: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='cancelled', failure_reason='cancelled_by_user', completed_at=?, lease_expires_at=NULL
              WHERE id=? AND status IN ('queued','dispatched','running')`)
    .run(now, taskId);
  return res.changes === 1;
}

/** Agent 回调推进 issue 状态（spec §6：平台不替 Agent 做决定，只提供端点）。 */
export function setIssueStatusFromAgent(db: Db, taskId: string, status: string, note?: string): { ok: boolean; error?: string } {
  if (!["in_review", "done", "blocked"].includes(status)) return { ok: false, error: "status must be in_review | done | blocked" };
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const issue = getIssue(db, task.issue_id);
  if (!issue) return { ok: false, error: "issue not found" };
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(status, now, issue.id);
  addComment(db, issue.id, {
    author_type: "agent", author_id: task.agent_id, type: "status_change",
    body: note ? `${issue.status} → ${status}：${note}` : `${issue.status} → ${status}`,
  });
  return { ok: true };
}
```

并在文件顶部确认 `getIssue`/`addComment` 已从 `./issues.js` 导入（Task 4 已导入 `getIssue, addComment`，无遗漏）。

- [x] **Step 4: 挂路由**

`apps/server/src/routes/daemon.ts` —— 顶部 import 区追加：

```ts
import { startTask, completeTask, failTaskInternal, setIssueStatusFromAgent } from "../services/tasks.js";
import { getIssue } from "../services/issues.js";
```

并在消息路由后追加：

```ts
  app.post("/api/daemon/tasks/:id/start", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { work_dir } = req.body as { work_dir: string };
    if (!startTask(db, id, work_dir)) return reply.code(409).send({ error: "task not in dispatched state" });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/complete", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!completeTask(db, id, req.body as any)) return reply.code(409).send({ error: "task not active" });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "task.updated", data: task });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/fail", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { failure_reason: string; error: string; work_dir?: string };
    failTaskInternal(db, id, body.failure_reason, body.error, body.work_dir ?? null);
    hub.broadcast({ type: "task.updated", data: getTask(db, id) });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/issue-status", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { status: string; note?: string };
    const r = setIssueStatusFromAgent(db, id, body.status, body.note);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
    return { ok: true };
  });
```

`apps/server/src/routes/tasks.ts` —— 顶部 import 区追加，并把 `registerTaskRoutes` 签名改为接收 hub：

```ts
import type { Hub } from "../ws/hub.js";
import { cancelTask } from "../services/tasks.js";

export function registerTaskRoutes(app: FastifyInstance, db: Db, hub: Hub) {
```

（替换 Task 6 中的签名行 `export function registerTaskRoutes(app: FastifyInstance, db: Db) {`。）

并在 `registerTaskRoutes` 函数内追加：

```ts
  app.post("/api/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!cancelTask(db, id)) return reply.code(409).send({ error: "task not active" });
    hub.broadcast({ type: "task.updated", data: getTask(db, id) });
    return { ok: true };
  });
```

`apps/server/src/app.ts` —— 修改 task 路由注册行并扩展清扫定时器：

```ts
  const { registerTaskRoutes } = await import("./routes/tasks.js");
  registerTaskRoutes(app, db, hub);
```

```ts
  const { sweepOfflineRuntimes } = await import("./services/runtimes.js");
  const { sweepExpiredLeases } = await import("./services/tasks.js");
  const sweepTimer = setInterval(() => {
    try {
      sweepOfflineRuntimes(db, new Date().toISOString());
      sweepExpiredLeases(db, new Date().toISOString());
    } catch (e) { app.log.error(e, "sweep failed"); }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(sweepTimer));
```

（替换 Task 5 Step 5 的定时器代码块。）

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/server test`
Expected: PASS（新增 5 个用例，累计 24）。

- [x] **Step 6: Commit**

```bash
git add apps/server && git commit -m "feat(server): task lifecycle (start/complete/fail/retry/lease-sweep/cancel) + agent issue-status callback"
```

---

## Task 8: runner —— 配置、API client、注册/心跳/轮询主循环

**Files:**
- Create: `apps/runner/src/config.ts`
- Create: `apps/runner/src/client.ts`
- Create: `apps/runner/src/probe.ts`
- Create: `apps/runner/src/poller.ts`
- Test: `apps/runner/test/poller.test.ts`

- [x] **Step 1: 写失败测试**

`apps/runner/test/poller.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { Daemon } from "../src/poller.js";

let app: FastifyInstance;
let daemon: Daemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  await app?.close();
});

async function startServerWithTask() {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: a.json().id } });
  return { url: `http://127.0.0.1:${port}`, token: tk.json().token };
}

describe("daemon poller", () => {
  it("registers, claims and executes a task via injected executor", async () => {
    const { url, token } = await startServerWithTask();
    const client = new ApiClient(url, token);
    let executed = 0;
    daemon = new Daemon(client, {
      daemonId: "d-test",
      providers: [{ provider: "kimi", version: "test" }],
      pollMs: 50, heartbeatMs: 1000,
      executor: async (pkg) => {
        executed++;
        expect(pkg.issue.title).toBe("demo");
        expect(pkg.task_token.startsWith("atk_")).toBe(true);
      },
    });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toBe(1);
  });

  it("survives executor crash and keeps polling", async () => {
    const { url, token } = await startServerWithTask();
    const client = new ApiClient(url, token);
    let calls = 0;
    daemon = new Daemon(client, {
      daemonId: "d-test",
      providers: [{ provider: "kimi", version: "test" }],
      pollMs: 50, heartbeatMs: 1000,
      executor: async () => { calls++; throw new Error("boom"); },
    });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(daemon.isAlive()).toBe(true);
  });
});
```

注：此测试需要 `@anvil/server` 能被 runner 引用。在 `apps/runner/package.json` 的 `devDependencies` 中追加 `"@anvil/server": "workspace:*"`（server 的 `package.json` 需补 `"main": "src/app.ts"`、`"types": "src/app.ts"` 与 `"exports": { ".": "./src/app.ts" }"`，tsx/vitest 直接跑 TS 源，无需构建）。

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/runner test`
Expected: FAIL，`../src/client.js` 等不存在。

- [x] **Step 3: 实现 config.ts、probe.ts、client.ts**

`apps/runner/src/config.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface RunnerConfig {
  serverUrl: string;    // ANVIL_SERVER_URL
  daemonToken: string;  // ANVIL_DAEMON_TOKEN
  daemonId: string;     // 持久化在 <runnerRoot>/daemon.json
  runnerRoot: string;   // ANVIL_RUNNER_ROOT，默认 ~/.anvil
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const runnerRoot = env.ANVIL_RUNNER_ROOT ?? path.join(os.homedir(), ".anvil");
  fs.mkdirSync(runnerRoot, { recursive: true });
  const stateFile = path.join(runnerRoot, "daemon.json");
  let daemonId = "";
  if (fs.existsSync(stateFile)) {
    daemonId = JSON.parse(fs.readFileSync(stateFile, "utf8")).daemon_id;
  } else {
    daemonId = `daemon-${crypto.randomBytes(6).toString("hex")}`;
    fs.writeFileSync(stateFile, JSON.stringify({ daemon_id: daemonId }, null, 2));
  }
  const serverUrl = env.ANVIL_SERVER_URL ?? "http://127.0.0.1:3100";
  const daemonToken = env.ANVIL_DAEMON_TOKEN ?? "";
  if (!daemonToken) throw new Error("ANVIL_DAEMON_TOKEN 未设置（在 web 的 Agents 页创建）");
  return { serverUrl, daemonToken, daemonId, runnerRoot };
}
```

`apps/runner/src/probe.ts`:

```ts
import { execFile } from "node:child_process";

export interface ProbeResult { provider: string; version: string | null; }

/** 探测本机可用的 Agent CLI。初版只探 kimi。 */
export async function probeProviders(): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const version = await tryVersion("kimi", ["--version"]);
  if (version) out.push({ provider: "kimi", version });
  return out;
}

export function tryVersion(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve((stdout || stderr).trim().split("\n")[0] ?? null);
    });
  });
}
```

`apps/runner/src/client.ts`:

```ts
import type { ClaimResponse, TaskPackage } from "@anvil/core";

export class ApiClient {
  constructor(private baseUrl: string, private daemonToken: string) {}

  private async req(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token ?? this.daemonToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${method} ${path} → ${res.status} ${text}`) as any;
      err.status = res.status;
      try { err.body = JSON.parse(text); } catch { /* ignore */ }
      throw err;
    }
    return res.json();
  }

  register(daemonId: string, runtimes: { provider: string; version: string | null }[]) {
    return this.req("POST", "/api/daemon/register", { daemon_id: daemonId, runtimes });
  }
  heartbeat(daemonId: string) {
    return this.req("POST", "/api/daemon/heartbeat", { daemon_id: daemonId });
  }
  claim(daemonId: string, maxTasks = 1): Promise<ClaimResponse> {
    return this.req("POST", "/api/daemon/claim", { daemon_id: daemonId, max_tasks: maxTasks });
  }
  startTask(taskId: string, token: string, workDir: string) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/start`, { work_dir: workDir }, token);
  }
  appendMessages(taskId: string, token: string, messages: unknown[]) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/messages`, { messages }, token);
  }
  complete(taskId: string, token: string, result: Record<string, unknown>) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/complete`, result, token);
  }
  fail(taskId: string, token: string, reason: string, error: string, workDir?: string) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/fail`, { failure_reason: reason, error, work_dir: workDir }, token);
  }
  async taskStatus(taskId: string, token: string): Promise<string | null> {
    try {
      const r = await this.req("GET", `/api/daemon/tasks/${taskId}/status`, undefined, token);
      return r.status;
    } catch (e: any) {
      if (e.status === 401 || e.status === 404) return null; // token 失效/任务消失 → 视为终态
      throw e;
    }
  }
}

export type { TaskPackage };
```

- [x] **Step 4: 实现 poller.ts（daemon 主循环，永不退出）**

`apps/runner/src/poller.ts`:

```ts
import WebSocket from "ws";
import type { ApiClient } from "./client.js";
import type { TaskPackage } from "@anvil/core";

export interface DaemonOptions {
  daemonId: string;
  providers: { provider: string; version: string | null }[];
  pollMs: number;          // 正常轮询间隔（生产 10s，测试 50ms）
  heartbeatMs: number;     // 心跳间隔（生产 15s）
  executor: (pkg: TaskPackage) => Promise<void>;
  wsUrl?: string;          // hint 通道；缺省从 client baseUrl 推导
}

/** 主循环纪律（spec §8）：任何单任务/单轮异常都不能让 daemon 退出。 */
export class Daemon {
  private stopped = false;
  private executing = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private ws: WebSocket | null = null;

  constructor(private client: ApiClient, private opts: DaemonOptions) {}

  async start() {
    await this.withGuard(() => this.client.register(this.opts.daemonId, this.opts.providers));
    const hb = setInterval(() => this.withGuard(() => this.client.heartbeat(this.opts.daemonId)), this.opts.heartbeatMs);
    const poll = setInterval(() => this.withGuard(() => this.pollOnce()), this.opts.pollMs);
    this.timers.push(hb, poll);
    this.connectHints();
    await this.withGuard(() => this.pollOnce()); // 启动立即来一轮
  }

  isAlive() { return !this.stopped; }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.ws?.close();
  }

  private connectHints() {
    const base = (this.client as any).baseUrl as string | undefined;
    if (!base) return; // 测试里 client 可能不暴露 baseUrl，hint 非必需
    try {
      const wsUrl = base.replace(/^http/, "ws") + "/api/daemon/ws";
      this.ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${(this.client as any).daemonToken}` } });
      this.ws.on("message", () => this.withGuard(() => this.pollOnce()));
      this.ws.on("close", () => { if (!this.stopped) setTimeout(() => this.connectHints(), 5000); });
      this.ws.on("error", () => { /* hint 丢失无害，轮询兜底 */ });
    } catch { /* ignore */ }
  }

  private async pollOnce() {
    if (this.stopped) return;
    const { tasks } = await this.client.claim(this.opts.daemonId, 4);
    for (const pkg of tasks) {
      if (this.executing.has(pkg.task.id)) continue;
      this.executing.add(pkg.task.id);
      this.opts.executor(pkg)
        .catch(() => { /* executor 内部已上报 fail；这里兜底不传播 */ })
        .finally(() => this.executing.delete(pkg.task.id));
    }
  }

  private async withGuard(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error("[anvil-daemon]", (e as Error).message); }
  }
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/runner test`
Expected: PASS（2 个用例）。

- [x] **Step 6: Commit**

```bash
git add apps/runner apps/server/package.json && git commit -m "feat(runner): config/probe/api client + resilient daemon poll loop"
```

---

## Task 9: runner —— AgentBackend 接口、进程执行底座（spawn/行解析/watchdog/杀进程组）、fake CLI

**Files:**
- Create: `apps/runner/src/agents/backend.ts`
- Create: `apps/runner/src/agents/process.ts`
- Create: `apps/runner/src/testing/fake-cli.mjs`
- Test: `apps/runner/test/process.test.ts`

- [x] **Step 1: 写失败测试**

`apps/runner/test/process.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliProcess, killProcessTree } from "../src/agents/process.js";
import { parseAgentLine, type AgentMessage } from "@anvil/core";

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "testing", "fake-cli.mjs");

function runFake(env: Record<string, string>, idleTimeoutMs = 5000) {
  return runCliProcess({
    command: process.execPath,
    args: [fakeCli],
    cwd: process.cwd(),
    env: { ...process.env, ...env } as Record<string, string>,
    parseLine: parseAgentLine,
    idleTimeoutMs,
  });
}

async function drain(messages: AsyncIterable<AgentMessage>) {
  const out: AgentMessage[] = [];
  for await (const m of messages) out.push(m);
  return out;
}

describe("runCliProcess", () => {
  it("streams parsed messages then completes with exit code", async () => {
    const lines = JSON.stringify([
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }) },
      { delay_ms: 10, line: "plain text line" },
    ]);
    const p = runFake({ FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" });
    const msgs = await drain(p.messages);
    const result = await p.result;
    expect(msgs[0]).toEqual({ type: "text", content: "hi" });
    expect(msgs[1]).toEqual({ type: "log", content: "plain text line" });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("non-zero exit → failed", async () => {
    const p = runFake({ FAKE_CLI_LINES: "[]", FAKE_CLI_EXIT: "3" });
    await drain(p.messages);
    const result = await p.result;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("idle watchdog kills silent process", async () => {
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]); // 长时间静默
    const p = runFake({ FAKE_CLI_LINES: lines }, 200);
    await drain(p.messages);
    const result = await p.result;
    expect(result.status).toBe("timeout");
  }, 15000);

  it("kill() terminates the process tree", async () => {
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]);
    const p = runFake({ FAKE_CLI_LINES: lines });
    await new Promise((r) => setTimeout(r, 100));
    p.kill();
    const result = await p.result;
    expect(result.status).toBe("cancelled");
  }, 15000);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/runner test`
Expected: FAIL，`agents/process.js` 不存在。

- [x] **Step 3: 实现 backend.ts 与 fake-cli.mjs**

`apps/runner/src/agents/backend.ts`:

```ts
import type { AgentMessage } from "@anvil/core";

export interface ExecOptions {
  workDir: string;
  env: Record<string, string>;
  prompt: string;
  resume: boolean;        // 是否恢复上次会话（同 workDir 的 -c）
  idleTimeoutMs: number;  // 无消息判死时长
}

export type AgentResultStatus = "completed" | "failed" | "aborted" | "timeout" | "cancelled";

export interface AgentResult {
  status: AgentResultStatus;
  exitCode?: number;
  error?: string;
}

export interface AgentSession {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
}

export interface AgentBackend {
  provider: string;
  execute(opts: ExecOptions): AgentSession;
}
```

`apps/runner/src/testing/fake-cli.mjs`:

```js
// 测试替身 CLI：按 FAKE_CLI_LINES（JSON 数组 [{delay_ms, line}]）逐条往 stdout 写，最后以 FAKE_CLI_EXIT 退出。
const lines = JSON.parse(process.env.FAKE_CLI_LINES ?? "[]");
const exitCode = Number(process.env.FAKE_CLI_EXIT ?? "0");

async function main() {
  for (const item of lines) {
    await new Promise((r) => setTimeout(r, item.delay_ms ?? 0));
    process.stdout.write(String(item.line) + "\n");
  }
  process.exit(exitCode);
}
main();
```

- [x] **Step 4: 实现 process.ts**

`apps/runner/src/agents/process.ts`:

```ts
import { spawn, exec } from "node:child_process";
import type { AgentMessage } from "@anvil/core";
import type { AgentResult } from "./backend.js";

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  parseLine: (line: string) => AgentMessage | null;
  idleTimeoutMs: number; // 0 = 不设 watchdog
}

export interface RunningProcess {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
  kill: () => void;
}

/** 杀整个进程组/进程树（spec §6：防止孤儿化 CLI 拉起的子进程）。 */
export function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  }
}

export function runCliProcess(opts: RunProcessOptions): RunningProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  // 消息队列：生产-消费桥接为 AsyncIterable
  const queue: AgentMessage[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  const push = (m: AgentMessage | null) => {
    if (!m) return;
    queue.push(m);
    notify?.();
  };

  let watchdog: NodeJS.Timeout | null = null;
  let killedByWatchdog = false;
  let killedManually = false;
  const armWatchdog = () => {
    if (!opts.idleTimeoutMs) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      killedByWatchdog = true;
      if (child.pid) killProcessTree(child.pid);
    }, opts.idleTimeoutMs);
  };
  armWatchdog();

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      push(opts.parseLine(line));
      armWatchdog(); // 有消息即重置 watchdog
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) push({ type: "log", content: `[stderr] ${line}` });
  });

  const result = new Promise<AgentResult>((resolve) => {
    child.on("error", (err) => {
      finish();
      resolve({ status: "failed", error: `spawn_failed: ${err.message}` });
    });
    child.on("close", (code) => {
      if (buf.trim()) push(opts.parseLine(buf));
      finish();
      if (killedByWatchdog) return resolve({ status: "timeout", error: "idle watchdog" });
      if (killedManually) return resolve({ status: "cancelled" });
      resolve(code === 0 ? { status: "completed", exitCode: 0 } : { status: "failed", exitCode: code ?? -1, error: `exit ${code}` });
    });
    function finish() {
      if (watchdog) clearTimeout(watchdog);
      done = true;
      notify?.();
    }
  });

  const messages: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentMessage>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise((resolve) => {
            notify = () => {
              notify = null;
              if (queue.length > 0) resolve({ value: queue.shift()!, done: false });
              else resolve({ value: undefined as any, done: true });
            };
          });
        },
      };
    },
  };

  return {
    messages,
    result,
    kill: () => {
      killedManually = true;
      if (child.pid) killProcessTree(child.pid);
    },
  };
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/runner test`
Expected: PASS（新增 4 个用例，累计 6）。

- [x] **Step 6: Commit**

```bash
git add apps/runner && git commit -m "feat(runner): agent backend interface + process runner (watchdog, tree-kill) + fake cli"
```

---

## Task 10: runner —— Kimi CLI adapter

**Files:**
- Create: `apps/runner/src/agents/kimi.ts`
- Modify: `apps/runner/src/agents/backend.ts`（AgentSession 增加 `kill`）
- Test: `apps/runner/test/kimi.test.ts`

背景（Kimi Code 官方文档实证，`kimi` 命令参考页）：headless 模式为 `kimi -p "<prompt>" --output-format stream-json`，stdout 每行一个 JSON 对象（Assistant 消息 / 带 `tool_calls` 的 Assistant 消息 / Tool 消息）；`-p` 模式默认 auto 权限、不求人工确认；恢复会话用 `-c`（继续当前工作目录最近一次会话）。thinking 不进 JSONL，走 stderr——process.ts 已把 stderr 包成 `log` 消息。

- [x] **Step 1: 写失败测试**

`apps/runner/test/kimi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKimiArgs, createKimiBackend } from "../src/agents/kimi.js";
import type { AgentMessage } from "@anvil/core";

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "testing", "fake-cli.mjs");

describe("kimi adapter", () => {
  it("builds args per kimi headless protocol", () => {
    const args = buildKimiArgs({ prompt: "do it", resume: false });
    expect(args).toEqual(["-p", "do it", "--output-format", "stream-json"]);
    const resumed = buildKimiArgs({ prompt: "do it", resume: true });
    expect(resumed).toContain("-c");
  });

  it("streams kimi-shaped stream-json lines via fake cli", async () => {
    const backend = createKimiBackend({ command: process.execPath, argsPrefix: [fakeCli] });
    const lines = JSON.stringify([
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", tool_calls: [{ name: "Bash", input: { command: "ls" } }] }) },
      { delay_ms: 10, line: JSON.stringify({ role: "tool", name: "Bash", content: "a.txt" }) },
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "done" }] }) },
    ]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" } as Record<string, string>,
      prompt: "test",
      resume: false,
      idleTimeoutMs: 5000,
    });
    const msgs: AgentMessage[] = [];
    for await (const m of session.messages) msgs.push(m);
    const result = await session.result;
    expect(msgs.map((m) => m.type)).toEqual(["tool_use", "tool_result", "text"]);
    expect(msgs[0].tool).toBe("Bash");
    expect(result.status).toBe("completed");
  });

  it("session.kill() cancels the run", async () => {
    const backend = createKimiBackend({ command: process.execPath, argsPrefix: [fakeCli] });
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines } as Record<string, string>,
      prompt: "test",
      resume: false,
      idleTimeoutMs: 60000,
    });
    setTimeout(() => session.kill(), 100);
    for await (const _ of session.messages) { /* drain */ }
    const result = await session.result;
    expect(result.status).toBe("cancelled");
  }, 15000);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/runner test`
Expected: FAIL，`agents/kimi.js` 不存在；`backend.ts` 的 `AgentSession` 缺 `kill`。

- [x] **Step 3: 修改 backend.ts，实现 kimi.ts**

`apps/runner/src/agents/backend.ts` —— `AgentSession` 接口改为：

```ts
export interface AgentSession {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
  kill: () => void;
}
```

`apps/runner/src/agents/kimi.ts`:

```ts
import { parseAgentLine } from "@anvil/core";
import { runCliProcess } from "./process.js";
import type { AgentBackend, AgentSession, ExecOptions } from "./backend.js";

export function buildKimiArgs(opts: { prompt: string; resume: boolean }): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json"];
  if (opts.resume) args.push("-c"); // 恢复当前工作目录的最近一次会话
  return args;
}

export interface KimiBackendOptions {
  command?: string;    // 默认 'kimi'，测试注入 process.execPath
  argsPrefix?: string[]; // 测试注入 fake cli 路径
}

/** Kimi Code CLI adapter。协议依据：kimi 命令官方文档（-p + --output-format stream-json）。 */
export function createKimiBackend(opts: KimiBackendOptions = {}): AgentBackend {
  const command = opts.command ?? "kimi";
  const prefix = opts.argsPrefix ?? [];
  return {
    provider: "kimi",
    execute(execOpts: ExecOptions): AgentSession {
      const p = runCliProcess({
        command,
        args: [...prefix, ...buildKimiArgs({ prompt: execOpts.prompt, resume: execOpts.resume })],
        cwd: execOpts.workDir,
        env: execOpts.env,
        parseLine: parseAgentLine,
        idleTimeoutMs: execOpts.idleTimeoutMs,
      });
      return { messages: p.messages, result: p.result, kill: p.kill };
    },
  };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @anvil/runner test`
Expected: PASS（新增 3 个用例，累计 9）。

- [x] **Step 5: Commit**

```bash
git add apps/runner && git commit -m "feat(runner): kimi cli adapter (headless stream-json, resume via -c)"
```

---

## Task 11: runner —— worktree、消息上传器（批量/redact/seq 重发）、executor 执行编排

**Files:**
- Create: `apps/runner/src/worktree.ts`
- Create: `apps/runner/src/uploader.ts`
- Create: `apps/runner/src/executor.ts`
- Create: `apps/runner/src/index.ts`
- Test: `apps/runner/test/executor.test.ts`
- Test: `apps/runner/test/uploader.test.ts`

- [ ] **Step 1: 写失败测试（uploader）**

`apps/runner/test/uploader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MessageUploader, redact } from "../src/uploader.js";

function mockClient(failures: Map<number, { status: number; body: any }> = new Map()) {
  const received: any[][] = [];
  return {
    received,
    async appendMessages(_id: string, _t: string, msgs: any[]) {
      const first = msgs[0]?.seq ?? -1;
      if (failures.has(first)) {
        const f = failures.get(first)!;
        failures.delete(first);
        const err: any = new Error("conflict");
        err.status = f.status;
        err.body = f.body;
        throw err;
      }
      received.push(msgs);
      return { last_seq: msgs[msgs.length - 1].seq };
    },
  };
}

describe("redact", () => {
  it("replaces secrets in content/input/output", () => {
    const m = redact(
      { type: "tool_use", tool: "Bash", input: { cmd: "curl -H Bearer atk_secret123" }, content: "token is atk_secret123" },
      ["atk_secret123"],
    );
    expect(m.content).toBe("token is ***");
    expect(JSON.stringify(m.input)).toContain("***");
    expect(JSON.stringify(m.input)).not.toContain("atk_secret123");
  });
});

describe("MessageUploader", () => {
  it("batches messages with continuous seq", async () => {
    const client = mockClient();
    const up = new MessageUploader(client as any, "t1", "tok", [], 10);
    up.push({ type: "text", content: "a" });
    up.push({ type: "text", content: "b" });
    await up.close();
    expect(client.received.flat().map((m) => m.seq)).toEqual([0, 1]);
  });

  it("resyncs from server last_seq on 409", async () => {
    const failures = new Map([[0, { status: 409, body: { last_seq: 0 } }]]);
    const client = mockClient(failures);
    // 模拟：server 已收到 seq 0，runner 重发整批
    const up = new MessageUploader(client as any, "t1", "tok", [], 10);
    up.push({ type: "text", content: "a" });
    up.push({ type: "text", content: "b" });
    await up.close();
    const sent = client.received.flat().map((m) => m.content);
    expect(sent).toEqual(["b"]); // seq 0 被服务器确认后不再重发
  });
});
```

- [ ] **Step 2: 写失败测试（executor 端到端，真 server + fake backend）**

`apps/runner/test/executor.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { executeTask, buildPrompt } from "../src/executor.js";
import type { AgentBackend } from "../src/agents/backend.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FastifyInstance;

afterEach(async () => { await app?.close(); });

function fakeBackend(behavior: "success" | "crash" | "hang") {
  const state = { killed: false };
  const backend: AgentBackend = {
    provider: "kimi",
    execute() {
      const messages = (async function* (): AsyncGenerator<{ type: string; content: string }> {
        if (behavior === "hang") {
          while (!state.killed) await new Promise((r) => setTimeout(r, 20));
          return;
        }
        yield { type: "text", content: "working..." };
      })();
      const result = new Promise<any>((resolve) => {
        if (behavior === "success") setTimeout(() => resolve({ status: "completed", exitCode: 0 }), 50);
        if (behavior === "crash") setTimeout(() => resolve({ status: "failed", exitCode: 1, error: "exit 1" }), 50);
        if (behavior === "hang") {
          const t = setInterval(() => { if (state.killed) { clearInterval(t); resolve({ status: "cancelled" }); } }, 20);
        }
      });
      return { messages, result, kill: () => { state.killed = true; } };
    },
  };
  return Object.assign(backend, { get killed() { return state.killed; } });
}

async function setup() {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "修复登录 bug", assignee_type: "agent", assignee_id: a.json().id } });
  const client = new ApiClient(url, tk.json().token);
  await client.register("d1", [{ provider: "kimi", version: "test" }]);
  const { tasks } = await client.claim("d1");
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
  return { client, pkg: tasks[0], runnerRoot, issueId: i.json().id };
}

describe("executor", () => {
  it("happy path: start → stream messages → complete", async () => {
    const { client, pkg, runnerRoot } = await setup();
    await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50 }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toContain(runnerRoot);
    const msgs = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages` });
    expect(msgs.json().some((m: any) => m.content === "working...")).toBe(true);
  });

  it("crash path: reports fail with failure_reason", async () => {
    const { client, pkg, runnerRoot } = await setup();
    await executeTask({ client, backend: fakeBackend("crash"), runnerRoot, cancelPollMs: 50 }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("failed");
    expect(got.json().task.failure_reason).toBe("non_zero_exit");
  });

  it("cancel path: kills backend when task cancelled on server", async () => {
    const { client, pkg, runnerRoot } = await setup();
    const backend = fakeBackend("hang");
    const run = executeTask({ client, backend, runnerRoot, cancelPollMs: 50 }, pkg);
    await new Promise((r) => setTimeout(r, 150));
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    await run;
    expect(backend.killed).toBe(true);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled"); // 不被覆盖成 failed
  });

  it("buildPrompt carries issue content and callback instruction", () => {
    const p = buildPrompt(
      { title: "标题", description: "描述" } as any,
      { id: "t1" } as any,
    );
    expect(p).toContain("标题");
    expect(p).toContain("描述");
    expect(p).toContain("issue-status");
    expect(p).toContain("ANVIL_TOKEN");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @anvil/runner test`
Expected: FAIL，`worktree.js` / `uploader.js` / `executor.js` 不存在。

- [ ] **Step 4: 实现 worktree.ts 与 uploader.ts**

`apps/runner/src/worktree.ts`:

```ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Issue } from "@anvil/core";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

export interface PreparedWorkdir { workDir: string; branch: string | null; resumed: boolean; }

/** 有 repo_path 则建 git worktree（分支 task/<shortId>）；否则用普通目录。prior_work_dir 存在则复用以恢复会话。 */
export async function prepareWorkdir(issue: Issue, taskId: string, runnerRoot: string, priorWorkDir: string | null): Promise<PreparedWorkdir> {
  if (priorWorkDir && fs.existsSync(priorWorkDir)) {
    return { workDir: priorWorkDir, branch: null, resumed: true };
  }
  const short = taskId.slice(0, 8);
  const base = path.join(runnerRoot, "worktrees");
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, short);
  if (!issue.repo_path) {
    fs.mkdirSync(dir, { recursive: true });
    return { workDir: dir, branch: null, resumed: false };
  }
  const branch = `task/${short}`;
  await git(issue.repo_path, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { workDir: dir, branch, resumed: false };
}

export async function gitDiffStat(workDir: string): Promise<string> {
  try { return await git(workDir, ["diff", "--stat", "HEAD"]); } catch { return ""; }
}
```

`apps/runner/src/uploader.ts`:

```ts
import type { AgentMessage, MessageBatchItem } from "@anvil/core";
import type { ApiClient } from "./client.js";

/** 上报前脱敏：把注入子进程的秘密值从消息里抹掉（spec §6）。 */
export function redact(m: AgentMessage, secrets: string[]): AgentMessage {
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const secret of secrets) if (secret) s = s.split(secret).join("***");
      return s;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = scrub(val);
      return out;
    }
    return v;
  };
  return { ...m, content: scrub(m.content) as any, input: scrub(m.input), output: scrub(m.output) as any };
}

/** 500ms 批量上报 + seq 连续编号 + 409 时按服务器 last_seq 重发。 */
export class MessageUploader {
  private buffer: MessageBatchItem[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: ApiClient,
    private taskId: string,
    private token: string,
    private secrets: string[],
    private flushMs = 500,
  ) {}

  push(m: AgentMessage) {
    this.buffer.push({ seq: this.seq++, ...redact(m, this.secrets) });
    if (!this.timer) this.timer = setTimeout(() => { this.flush().catch(() => {}); }, this.flushMs);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, 50);
      try {
        await this.client.appendMessages(this.taskId, this.token, batch);
        this.buffer.splice(0, batch.length);
      } catch (e: any) {
        if (e?.status === 409 && typeof e.body?.last_seq === "number") {
          this.buffer = this.buffer.filter((m) => m.seq > e.body.last_seq);
          continue;
        }
        throw e;
      }
    }
  }

  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }
}
```

- [ ] **Step 5: 实现 executor.ts 与 index.ts**

`apps/runner/src/executor.ts`:

```ts
import type { Issue, Task, TaskPackage } from "@anvil/core";
import type { ApiClient } from "./client.js";
import type { AgentBackend } from "./agents/backend.js";
import { prepareWorkdir, gitDiffStat } from "./worktree.js";
import { MessageUploader } from "./uploader.js";

export interface ExecutorDeps {
  client: ApiClient;
  backend: AgentBackend;
  runnerRoot: string;
  idleTimeoutMs?: number;  // 默认 30min（spec §6：idle watchdog）
  cancelPollMs?: number;   // 默认 5s
}

export function buildPrompt(issue: Issue, task: Task): string {
  const lines = [
    "你是 Anvil 平台上的编码 Agent，正在无人值守地执行任务。",
    "",
    "# 任务",
    `标题：${issue.title}`,
    issue.description ? `描述：\n${issue.description}` : "",
    "",
    "# 要求",
    "- 在当前工作目录内完成编码，改动用 git commit 提交（保持当前分支）。",
    "- 全部完成后，必须把 issue 移到 in_review：",
    `  curl -X POST "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/issue-status" -H "Authorization: Bearer $ANVIL_TOKEN" -H "content-type: application/json" -d "{\\"status\\":\\"in_review\\"}"`,
    "- 遇到无法继续的阻塞，用同样方式上报 status=blocked 并附原因。",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** 单任务完整旅程：准备目录 → start → spawn → 流式上报 → complete/fail。任何异常收敛为 fail 上报，绝不外抛。 */
export async function executeTask(deps: ExecutorDeps, pkg: TaskPackage): Promise<void> {
  const { client, backend } = deps;
  const { task, issue, prior_work_dir, task_token } = pkg;
  let workDir: string | null = null;
  try {
    const prepared = await prepareWorkdir(issue, task.id, deps.runnerRoot, prior_work_dir);
    workDir = prepared.workDir;
    await client.startTask(task.id, task_token, workDir);

    const env = {
      ...process.env,
      ANVIL_TOKEN: task_token,
      ANVIL_SERVER_URL: (client as any).baseUrl,
      ANVIL_WORKSPACE_ID: task.workspace_id,
      ANVIL_AGENT_ID: task.agent_id,
      ANVIL_TASK_ID: task.id,
    } as Record<string, string>;

    const uploader = new MessageUploader(client, task.id, task_token, [task_token], 500);
    const session = backend.execute({
      workDir,
      env,
      prompt: buildPrompt(issue, task),
      resume: prepared.resumed,
      idleTimeoutMs: deps.idleTimeoutMs ?? 30 * 60 * 1000,
    });

    // 取消轮询：server 端终态 → 杀进程组
    const cancelTimer = setInterval(async () => {
      try {
        const st = await client.taskStatus(task.id, task_token);
        if (st === null || st === "cancelled" || st === "completed" || st === "failed") session.kill();
      } catch { /* 网络抖动下轮再说 */ }
    }, deps.cancelPollMs ?? 5000);

    try {
      for await (const m of session.messages) uploader.push(m);
      const result = await session.result;
      await uploader.close();
      if (result.status === "completed") {
        const diffStat = prepared.branch ? await gitDiffStat(workDir) : "";
        await client.complete(task.id, task_token, {
          branch: prepared.branch ?? undefined,
          diff_stat: diffStat || undefined,
          work_dir: workDir,
        });
      } else if (result.status === "cancelled") {
        // server 已置 cancelled，不再上报
      } else if (result.status === "timeout") {
        await client.fail(task.id, task_token, "idle_timeout", result.error ?? "idle watchdog", workDir);
      } else {
        await client.fail(task.id, task_token, "non_zero_exit", result.error ?? `exit ${result.exitCode}`, workDir);
      }
    } finally {
      clearInterval(cancelTimer);
    }
  } catch (e: any) {
    const reason = String(e?.message ?? "").includes("spawn_failed") ? "spawn_failed" : "non_zero_exit";
    await client.fail(task.id, task_token, reason, String(e?.message ?? e), workDir ?? undefined).catch(() => {});
  }
}
```

`apps/runner/src/index.ts`:

```ts
import { loadConfig } from "./config.js";
import { probeProviders } from "./probe.js";
import { ApiClient } from "./client.js";
import { Daemon } from "./poller.js";
import { createKimiBackend } from "./agents/kimi.js";
import { executeTask } from "./executor.js";

async function main() {
  const cfg = loadConfig();
  const providers = await probeProviders();
  if (providers.length === 0) {
    console.error("未探测到任何 Agent CLI（kimi）。请先安装 Kimi Code CLI。");
    process.exit(1);
  }
  const client = new ApiClient(cfg.serverUrl, cfg.daemonToken);
  const backend = createKimiBackend();
  const daemon = new Daemon(client, {
    daemonId: cfg.daemonId,
    providers,
    pollMs: 10_000,
    heartbeatMs: 15_000,
    executor: (pkg) => executeTask({ client, backend, runnerRoot: cfg.runnerRoot }, pkg),
  });
  await daemon.start();
  console.log(`anvil runner started: daemon=${cfg.daemonId}, providers=${providers.map((p) => p.provider).join(",")}`);
  process.on("SIGINT", async () => { await daemon.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @anvil/runner test`
Expected: PASS（uploader 3 + executor 4 + 既有 9 = 16）。

- [ ] **Step 7: Commit**

```bash
git add apps/runner && git commit -m "feat(runner): worktree prep, batched uploader with redact/resync, task executor + entrypoint"
```

---

## Task 12: web —— 脚手架、api/ws 封装、看板页

**Files:**
- Create: `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/api.ts`, `apps/web/src/ws.ts`
- Create: `apps/web/src/pages/BoardPage.tsx`
- Test: `apps/web/test/board.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/board.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BoardPage from "../src/pages/BoardPage.js";

vi.mock("../src/api.js", () => ({
  bootstrap: vi.fn(async () => ({
    workspace: { id: "ws1", name: "Default", slug: "default" },
    user: { id: "u1", name: "Owner" },
  })),
  listIssues: vi.fn(async () => [
    { id: "i1", workspace_id: "ws1", title: "修 bug", status: "todo", priority: "high", assignee_type: "agent", assignee_id: "a1", creator_type: "member", creator_id: "u1", repo_path: null, position: 1, created_at: "x", updated_at: "x", description: null },
  ]),
  listAgents: vi.fn(async () => [
    { id: "a1", workspace_id: "ws1", name: "小K", provider: "kimi", status: "idle", max_concurrent_tasks: 1, runtime_id: null, created_at: "x" },
  ]),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

describe("BoardPage", () => {
  it("renders issue in its status column with agent name", async () => {
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    expect(screen.getByText("小K")).toBeTruthy();
    expect(screen.getByText("todo")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/web test`
Expected: FAIL，组件与 api 模块不存在。

- [ ] **Step 3: 实现脚手架与 api/ws 封装**

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/ws": { target: "ws://127.0.0.1:3100", ws: true },
    },
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Anvil</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/web/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`apps/web/src/App.tsx`:

```tsx
import { NavLink, Route, Routes } from "react-router-dom";
import BoardPage from "./pages/BoardPage.js";
import TaskDetailPage from "./pages/TaskDetailPage.js";
import AgentsPage from "./pages/AgentsPage.js";

export default function App() {
  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">⚒ Anvil</span>
        <NavLink to="/">看板</NavLink>
        <NavLink to="/agents">Agents</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<BoardPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/agents" element={<AgentsPage />} />
      </Routes>
    </div>
  );
}
```

`apps/web/src/api.ts`:

```ts
import type { Agent, Comment, CreateIssueRequest, Issue, Runtime, Task, UpdateIssueRequest } from "@anvil/core";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Bootstrap { workspace: { id: string; name: string; slug: string }; user: { id: string; name: string }; }
export interface IssueDetail { issue: Issue; comments: Comment[]; }
export interface TaskDetail { task: Task; issue: Issue; }

export const bootstrap = () => req<Bootstrap>("GET", "/api/bootstrap");
export const listIssues = (workspaceId: string) => req<Issue[]>("GET", `/api/issues?workspace_id=${workspaceId}`);
export const createIssue = (body: CreateIssueRequest) => req<Issue>("POST", "/api/issues", body);
export const updateIssue = (id: string, body: UpdateIssueRequest) => req<Issue>("PATCH", `/api/issues/${id}`, body);
export const rerunIssue = (id: string) => req<Task>("POST", `/api/issues/${id}/rerun`);
export const getIssueDetail = (id: string) => req<IssueDetail>("GET", `/api/issues/${id}`);
export const getIssueTasks = (id: string) => req<Task[]>("GET", `/api/issues/${id}/tasks`);
export const addComment = (id: string, body: string) => req("POST", `/api/issues/${id}/comments`, { body });
export const getTask = (id: string) => req<TaskDetail>("GET", `/api/tasks/${id}`);
export const getTaskMessages = (id: string, afterSeq = -1) =>
  req<{ seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null }[]>(
    "GET", `/api/tasks/${id}/messages?after_seq=${afterSeq}`,
  );
export const cancelTask = (id: string) => req("POST", `/api/tasks/${id}/cancel`);
export const listAgents = () => req<Agent[]>("GET", "/api/agents");
export const createAgent = (body: { name: string; provider: string; max_concurrent_tasks?: number }) =>
  req<Agent>("POST", "/api/agents", body);
export const listRuntimes = () => req<Runtime[]>("GET", "/api/runtimes");
export const createDaemonToken = (label: string) => req<{ id: string; token: string }>("POST", "/api/daemon-tokens", { label });
```

`apps/web/src/ws.ts`:

```ts
import { useEffect } from "react";
import type { ServerEvent } from "@anvil/core";

/** 订阅 server 事件流；断线 3s 重连。 */
export function useServerEvents(onEvent: (e: ServerEvent) => void) {
  useEffect(() => {
    let closed = false;
    let ws: WebSocket;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) setTimeout(connect, 3000); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }, []);
}
```

- [ ] **Step 4: 实现 BoardPage 与 styles.css**

`apps/web/src/pages/BoardPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ISSUE_STATUSES, PRIORITIES, type Agent, type Issue, type IssueStatus, type Priority } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

export default function BoardPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    const boot = await api.bootstrap();
    setWorkspaceId(boot.workspace.id);
    const [i, a] = await Promise.all([api.listIssues(boot.workspace.id), api.listAgents()]);
    setIssues(i);
    setAgents(a);
  }, []);

  useEffect(() => { reload().catch(console.error); }, [reload]);
  useServerEvents(useCallback((e) => {
    if (e.type === "issue.updated" || e.type === "task.updated") reload().catch(() => {});
  }, [reload]));

  const agentName = (issue: Issue) =>
    issue.assignee_type === "agent" ? agents.find((a) => a.id === issue.assignee_id)?.name ?? "agent" : null;

  const openIssue = async (issue: Issue) => {
    const tasks = await api.getIssueTasks(issue.id);
    const active = tasks.find((t) => ["queued", "dispatched", "running"].includes(t.status)) ?? tasks[tasks.length - 1];
    if (active) navigate(`/tasks/${active.id}`);
  };

  return (
    <div>
      <div className="toolbar">
        <h1>看板</h1>
        <button onClick={() => setShowCreate(true)}>+ 新建 issue</button>
      </div>
      <div className="board">
        {ISSUE_STATUSES.map((col: IssueStatus) => (
          <div key={col} className="column">
            <div className="column-title">{col}</div>
            {issues.filter((i) => i.status === col).map((issue) => (
              <div key={issue.id} className="card" onClick={() => openIssue(issue)}>
                <div className="card-title">{issue.title}</div>
                <div className="card-meta">
                  <span className={`prio prio-${issue.priority}`}>{issue.priority}</span>
                  {agentName(issue) && <span className="agent-tag">🤖 {agentName(issue)}</span>}
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={issue.status}
                    onChange={async (e) => { await api.updateIssue(issue.id, { status: e.target.value }); reload(); }}
                  >
                    {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {issue.assignee_type === "agent" && (
                    <button onClick={async () => { await api.rerunIssue(issue.id); reload(); }}>重跑</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {showCreate && <CreateIssueModal workspaceId={workspaceId} agents={agents} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
    </div>
  );
}

function CreateIssueModal(props: { workspaceId: string; agents: Agent[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [repoPath, setRepoPath] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    await api.createIssue({
      title, description: description || undefined, priority,
      assignee_type: assigneeId ? "agent" : undefined,
      assignee_id: assigneeId || undefined,
      repo_path: repoPath || undefined,
    });
    props.onCreated();
  };

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新建 issue</h2>
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <textarea placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        <label>优先级
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>指派给
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">（暂不指派）</option>
            {props.agents.map((a) => <option key={a.id} value={a.id}>🤖 {a.name}</option>)}
          </select>
        </label>
        <input placeholder="目标仓库路径（可选，如 D:/projects/foo）" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <div className="modal-actions">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" onClick={submit}>创建</button>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/styles.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e5e7eb; }
.app { min-height: 100vh; }
.topnav { display: flex; gap: 16px; align-items: center; padding: 10px 20px; background: #171a21; border-bottom: 1px solid #2a2f3a; }
.topnav a { color: #9ca3af; text-decoration: none; }
.topnav a.active { color: #fff; }
.brand { font-weight: 700; margin-right: 12px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; }
.toolbar h1 { font-size: 18px; margin: 0; }
button { background: #2a2f3a; color: #e5e7eb; border: 1px solid #3a4150; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button.primary { background: #2563eb; border-color: #2563eb; }
.board { display: flex; gap: 12px; padding: 0 20px 20px; overflow-x: auto; align-items: flex-start; }
.column { background: #171a21; border-radius: 8px; min-width: 220px; flex: 1; padding: 8px; }
.column-title { font-size: 12px; text-transform: uppercase; color: #9ca3af; padding: 4px 6px 8px; }
.card { background: #1f2330; border: 1px solid #2a2f3a; border-radius: 8px; padding: 10px; margin-bottom: 8px; cursor: pointer; }
.card:hover { border-color: #4b5563; }
.card-title { font-size: 14px; margin-bottom: 6px; }
.card-meta { display: flex; gap: 8px; font-size: 12px; align-items: center; }
.prio { padding: 1px 6px; border-radius: 4px; background: #2a2f3a; }
.prio-urgent { background: #7f1d1d; }
.prio-high { background: #78350f; }
.agent-tag { color: #93c5fd; }
.card-actions { display: flex; gap: 6px; margin-top: 8px; }
.card-actions select { background: #2a2f3a; color: #e5e7eb; border: 1px solid #3a4150; border-radius: 4px; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
.modal { background: #171a21; border-radius: 10px; padding: 20px; width: 420px; display: flex; flex-direction: column; gap: 10px; }
.modal h2 { margin: 0; font-size: 16px; }
.modal input, .modal textarea, .modal select { background: #0f1115; color: #e5e7eb; border: 1px solid #2a2f3a; border-radius: 6px; padding: 8px; width: 100%; }
.modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #9ca3af; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @anvil/web test`
Expected: PASS（1 个用例）。

- [ ] **Step 6: Commit**

```bash
git add apps/web && git commit -m "feat(web): scaffold + board page (columns, create modal, status select, rerun)"
```

---

## Task 13: web —— 任务详情页（日志流 / 取消 / 评论）

**Files:**
- Create: `apps/web/src/pages/TaskDetailPage.tsx`
- Test: `apps/web/test/task-detail.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/task-detail.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TaskDetailPage from "../src/pages/TaskDetailPage.js";

vi.mock("../src/api.js", () => ({
  getTask: vi.fn(async () => ({
    task: { id: "t1", issue_id: "i1", status: "running", agent_id: "a1" },
    issue: { id: "i1", title: "修 bug", status: "in_progress", description: "详细描述" },
  })),
  getTaskMessages: vi.fn(async () => [
    { seq: 0, type: "text", tool: null, content: "开始干活", input_json: null, output: null },
    { seq: 1, type: "tool_use", tool: "Bash", content: null, input_json: '{"command":"ls"}', output: null },
  ]),
  getIssueDetail: vi.fn(async () => ({ issue: { id: "i1", title: "修 bug" }, comments: [{ id: "c1", author_type: "member", author_id: "u", type: "comment", body: "加油", created_at: "x" }] })),
  cancelTask: vi.fn(),
  addComment: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

describe("TaskDetailPage", () => {
  it("renders issue info, transcript and comments", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/t1"]}>
        <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    expect(screen.getByText("开始干活")).toBeTruthy();
    expect(screen.getByText(/Bash/)).toBeTruthy();
    expect(screen.getByText("加油")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/web test`
Expected: FAIL，`TaskDetailPage` 不存在。

- [ ] **Step 3: 实现 TaskDetailPage**

`apps/web/src/pages/TaskDetailPage.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Comment, Issue, Task } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; }

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const lastSeq = useRef(-1);
  const bottomRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    const [detail, msgs] = await Promise.all([api.getTask(id), api.getTaskMessages(id, lastSeq.current)]);
    setTask(detail.task);
    setIssue(detail.issue);
    if (msgs.length > 0) {
      setMessages((prev) => [...prev, ...msgs]);
      lastSeq.current = msgs[msgs.length - 1].seq;
    }
    const d = await api.getIssueDetail(detail.issue.id);
    setComments(d.comments);
  }, [id]);

  useEffect(() => { reload().catch(console.error); }, [reload]);
  useServerEvents(useCallback((e) => {
    const data = e.data as any;
    if (e.type === "task.message" && data?.task_id === id) reload().catch(() => {});
    if (e.type === "task.updated" && data?.id === id) reload().catch(() => {});
  }, [id, reload]));
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  if (!task || !issue) return <div className="toolbar">加载中…</div>;
  const active = ["queued", "dispatched", "running"].includes(task.status);

  return (
    <div className="detail">
      <div className="toolbar">
        <Link to="/">← 看板</Link>
        <h1>{issue.title}</h1>
        <span className={`badge status-${task.status}`}>{task.status}</span>
        {active && <button onClick={async () => { await api.cancelTask(task.id); reload(); }}>取消任务</button>}
        {!active && (
          <button onClick={async () => { const t = await api.rerunIssue(issue.id); navigate(`/tasks/${t.id}`); }}>重跑</button>
        )}
      </div>
      {task.error && <div className="error-banner">[{task.failure_reason}] {task.error}</div>}
      <div className="detail-body">
        <div className="stream">
          {messages.map((m) => (
            <div key={m.seq} className={`msg msg-${m.type}`}>
              <span className="msg-type">{m.type}{m.tool ? `:${m.tool}` : ""}</span>
              <pre>{m.content ?? m.output ?? m.input_json ?? ""}</pre>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="sidebar">
          <h3>Issue</h3>
          <p className="desc">{issue.description || "（无描述）"}</p>
          <h3>评论</h3>
          {comments.map((c) => (
            <div key={c.id} className={`comment comment-${c.type}`}>
              <span className="comment-author">{c.author_type === "agent" ? "🤖" : c.author_type === "system" ? "⚙" : "👤"} {c.type}</span>
              <p>{c.body}</p>
            </div>
          ))}
          <div className="comment-form">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="追加指令或评论…" />
            <button onClick={async () => { if (!draft.trim()) return; await api.addComment(issue.id, draft); setDraft(""); reload(); }}>发送</button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

在 `apps/web/src/styles.css` 末尾追加：

```css
.detail { display: flex; flex-direction: column; height: calc(100vh - 49px); }
.detail .toolbar { gap: 12px; }
.detail h1 { font-size: 16px; margin: 0; flex: 1; }
.badge { padding: 2px 8px; border-radius: 4px; background: #2a2f3a; font-size: 12px; }
.status-running { background: #1e3a8a; }
.status-completed { background: #14532d; }
.status-failed { background: #7f1d1d; }
.error-banner { margin: 0 20px; padding: 8px 12px; background: #7f1d1d; border-radius: 6px; font-size: 13px; }
.detail-body { display: flex; flex: 1; gap: 12px; padding: 12px 20px; min-height: 0; }
.stream { flex: 2; overflow-y: auto; background: #0a0c10; border-radius: 8px; padding: 12px; font-family: ui-monospace, monospace; font-size: 13px; }
.msg { margin-bottom: 6px; }
.msg-type { color: #6b7280; font-size: 11px; margin-right: 8px; }
.msg pre { margin: 2px 0 0; white-space: pre-wrap; word-break: break-all; }
.msg-error pre { color: #fca5a5; }
.msg-tool_use pre { color: #93c5fd; }
.sidebar { flex: 1; overflow-y: auto; background: #171a21; border-radius: 8px; padding: 12px; }
.sidebar h3 { font-size: 12px; text-transform: uppercase; color: #9ca3af; margin: 8px 0; }
.desc { font-size: 13px; white-space: pre-wrap; }
.comment { border-left: 2px solid #2a2f3a; padding-left: 8px; margin-bottom: 8px; font-size: 13px; }
.comment-status_change { border-left-color: #2563eb; }
.comment-author { font-size: 11px; color: #9ca3af; }
.comment p { margin: 2px 0; }
.comment-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.comment-form textarea { background: #0f1115; color: #e5e7eb; border: 1px solid #2a2f3a; border-radius: 6px; padding: 8px; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @anvil/web test`
Expected: PASS（累计 2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): task detail page (live transcript, cancel/rerun, comments)"
```

---

## Task 14: web —— Agents / Runtimes 管理页

**Files:**
- Create: `apps/web/src/pages/AgentsPage.tsx`
- Test: `apps/web/test/agents.test.tsx`

- [ ] **Step 1: 写失败测试**

`apps/web/test/agents.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AgentsPage from "../src/pages/AgentsPage.js";

vi.mock("../src/api.js", () => ({
  listAgents: vi.fn(async () => [
    { id: "a1", workspace_id: "ws", name: "小K", provider: "kimi", status: "idle", max_concurrent_tasks: 1, runtime_id: null, created_at: "x" },
  ]),
  listRuntimes: vi.fn(async () => [
    { id: "r1", workspace_id: "ws", daemon_id: "daemon-abc", provider: "kimi", version: "1.0.0", status: "online", last_seen_at: "x" },
  ]),
  createAgent: vi.fn(),
  createDaemonToken: vi.fn(async () => ({ id: "t", token: "anv_secret" })),
}));

describe("AgentsPage", () => {
  it("lists agents and runtimes", async () => {
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("小K")).toBeTruthy());
    expect(screen.getByText("daemon-abc")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @anvil/web test`
Expected: FAIL，`AgentsPage` 不存在。

- [ ] **Step 3: 实现 AgentsPage**

`apps/web/src/pages/AgentsPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Agent, Runtime } from "@anvil/core";
import * as api from "../api.js";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState("");

  const reload = async () => {
    const [a, r] = await Promise.all([api.listAgents(), api.listRuntimes()]);
    setAgents(a);
    setRuntimes(r);
  };
  useEffect(() => { reload().catch(console.error); }, []);

  return (
    <div className="admin">
      <section>
        <h2>Agents</h2>
        <div className="inline-form">
          <input placeholder="新 Agent 名字" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={async () => { if (!name.trim()) return; await api.createAgent({ name, provider: "kimi" }); setName(""); reload(); }}>
            创建（kimi）
          </button>
        </div>
        <table>
          <thead><tr><th>名字</th><th>provider</th><th>状态</th><th>并发上限</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}><td>{a.name}</td><td>{a.provider}</td><td>{a.status}</td><td>{a.max_concurrent_tasks}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Runtimes</h2>
        <table>
          <thead><tr><th>daemon</th><th>provider</th><th>版本</th><th>状态</th><th>最后心跳</th></tr></thead>
          <tbody>
            {runtimes.map((r) => (
              <tr key={r.id}><td>{r.daemon_id}</td><td>{r.provider}</td><td>{r.version}</td><td>{r.status}</td><td>{r.last_seen_at}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Daemon Token</h2>
        <p className="hint">runner 启动需要 token。明文只显示这一次，请复制后配置到 runner 的 ANVIL_DAEMON_TOKEN。</p>
        <button onClick={async () => { const t = await api.createDaemonToken("default"); setNewToken(t.token); }}>生成新 token</button>
        {newToken && <pre className="token-reveal">{newToken}</pre>}
      </section>
    </div>
  );
}
```

在 `apps/web/src/styles.css` 末尾追加：

```css
.admin { padding: 20px; display: flex; flex-direction: column; gap: 24px; }
.admin h2 { font-size: 15px; margin: 0 0 8px; }
.admin table { border-collapse: collapse; width: 100%; font-size: 13px; }
.admin th, .admin td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2f3a; }
.admin th { color: #9ca3af; font-weight: 500; }
.inline-form { display: flex; gap: 8px; margin-bottom: 10px; }
.inline-form input { background: #0f1115; color: #e5e7eb; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px 10px; }
.hint { color: #9ca3af; font-size: 13px; }
.token-reveal { background: #0a0c10; padding: 10px; border-radius: 6px; user-select: all; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @anvil/web test`
Expected: PASS（累计 3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/web && git commit -m "feat(web): agents/runtimes admin page + daemon token generation"
```

---

## Task 15: server 入口 + E2E happy path

**Files:**
- Create: `apps/server/src/index.ts`
- Test: `apps/runner/test/e2e.test.ts`

- [ ] **Step 1: 写 server 入口**

`apps/server/src/index.ts`:

```ts
import { buildApp } from "./app.js";

const port = Number(process.env.ANVIL_PORT ?? 3100);
const dbPath = process.env.ANVIL_DB ?? "anvil.db";

const app = await buildApp({ dbPath });
await app.listen({ port, host: "127.0.0.1" });
console.log(`anvil server listening on http://127.0.0.1:${port}`);
```

- [ ] **Step 2: 写 E2E 测试**

`apps/runner/test/e2e.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { Daemon } from "../src/poller.js";
import { executeTask } from "../src/executor.js";
import type { AgentBackend } from "../src/agents/backend.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FastifyInstance;
let daemon: Daemon | null = null;

afterEach(async () => { await daemon?.stop(); await app?.close(); });

/** E2E happy path：创建 issue 并指派 → daemon 自动认领执行 → completed。 */
it("create issue → daemon claims → completes end to end", async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;

  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  const issue = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "E2E 任务", assignee_type: "agent", assignee_id: a.json().id },
  });

  const fakeBackend: AgentBackend = {
    provider: "kimi",
    execute() {
      const messages = (async function* () {
        yield { type: "text", content: "e2e working" };
        yield { type: "tool_use", tool: "Bash", input: { command: "echo hi" } };
      })();
      return {
        messages,
        result: Promise.resolve({ status: "completed", exitCode: 0 }),
        kill: () => {},
      };
    },
  };

  const client = new ApiClient(url, daemonToken);
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-e2e-"));
  daemon = new Daemon(client, {
    daemonId: "e2e-daemon",
    providers: [{ provider: "kimi", version: "e2e" }],
    pollMs: 50,
    heartbeatMs: 1000,
    executor: (pkg) => executeTask({ client, backend: fakeBackend, runnerRoot, cancelPollMs: 100 }, pkg),
  });
  await daemon.start();

  // 等待任务完成（最多 5s）
  let task: any = null;
  for (let i = 0; i < 50; i++) {
    const tasks = (await app.inject({ method: "GET", url: `/api/issues/${issue.json().id}/tasks` })).json();
    if (tasks[0]?.status === "completed") { task = tasks[0]; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(task?.status).toBe("completed");

  const msgs = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/messages` })).json();
  expect(msgs.map((m: any) => m.type)).toEqual(["text", "tool_use"]);

  const runtimes = (await app.inject({ method: "GET", url: "/api/runtimes" })).json();
  expect(runtimes[0].status).toBe("online");
}, 10000);
```

- [ ] **Step 3: 跑 E2E**

Run: `pnpm --filter @anvil/runner test`
Expected: 全部 PASS（含 E2E，累计 17）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts apps/runner/test/e2e.test.ts && git commit -m "feat: server entrypoint + end-to-end happy path test"
```

---

## Task 16: 收尾 —— README、MIT LICENSE、根 .env 示例、全量验证

**Files:**
- Create: `README.md`, `LICENSE`
- Test: 手动验收清单（spec §10）

- [ ] **Step 1: 写 README**

`README.md`:

```markdown
# Anvil

个人 AI Agent 工作台（一期：编码任务调度）。看板创建 issue → 指派 Agent → 本地 runner 认领 → git worktree 中由 Kimi Code CLI 自主执行 → 日志流实时回看板 → 完成进 in_review。

设计文档：`docs/superpowers/specs/2026-08-04-anvil-design.md`

## 快速开始

前置：Node ≥ 20、pnpm、Git、Kimi Code CLI（`kimi --version` 可见）。

```bash
pnpm install

# 1. 启动 server（127.0.0.1:3100，SQLite 文件 anvil.db）
pnpm dev:server

# 2. 打开 web（127.0.0.1:5173），在 Agents 页：
#    a. 创建一个 Agent（provider=kimi）
#    b. 生成 daemon token 并复制
pnpm dev:web

# 3. 启动 runner（另一个终端）
set ANVIL_DAEMON_TOKEN=anv_xxx   # Windows cmd；PowerShell 用 $env:ANVIL_DAEMON_TOKEN="anv_xxx"
pnpm dev:runner

# 4. 看板新建 issue → 指派给 Agent → 观察自动执行
```

## 测试

```bash
pnpm test
```

## License

MIT（见 LICENSE）。本项目为独立实现，与 Multica 无代码继承关系。
```

`LICENSE`：标准 MIT 文本（Copyright (c) 2026 Anvil contributors）。

- [ ] **Step 2: 全量测试 + 类型检查**

Run:

```bash
cd /d/anvil && pnpm test && pnpm -r exec tsc --noEmit -p tsconfig.json
```

Expected: 四个包测试全 PASS，tsc 无错误。

- [ ] **Step 3: 手动验收（对照 spec §10 checklist）**

逐项人工执行并记录结果：

1. 三端启动（server/web/runner），看板建 issue 指派 Agent，确认真 Kimi CLI 冒烟：任务跑完、日志流可见、issue 可被 Agent 回调移到 `in_review`（冒烟不过则检查 `kimi -p "hi" --output-format stream-json` 的输出行格式，校准 `packages/core/src/messages.ts` 的 `parseAgentLine`）。
2. 取消一个执行中的任务，确认 `git worktree list` 与进程表中无残留。
3. 杀掉 runner 进程等 2 分钟，确认租约清扫把任务重新排队；重启 runner 后被重新认领。
4. runner 断网/断心跳 60s+，确认 runtime 标 offline、任务按 `runtime_offline` 失败并自动重试。
5. daemon 连续运行期间制造单任务崩溃（比如给一个不存在目录的 repo_path），确认 daemon 不退出、其他任务不受影响。

- [ ] **Step 4: Commit**

```bash
git add README.md LICENSE && git commit -m "docs: readme quickstart + MIT license"
```

---

## 附：常见坑位提示（执行时参考）

- **better-sqlite3 安装**：Windows 需要预编译二进制匹配 Node 版本；失败时先 `pnpm rebuild better-sqlite3`，再不行换 Node LTS。
- **prompt 长度**：`kimi -p` 走命令行参数，Windows 单条命令约 32KB 上限。buildPrompt 保持精简（当前模板 < 4KB）；issue 描述超长时先截断到 8KB 再拼接（executor 里做一次 `description.slice(0, 8000)`）。
- **worktree 复用**：同一仓库并发任务各自建 worktree 互不干扰，但同一 repo_path 的任务串行执行更稳——v1 依赖 agent 的 max_concurrent_tasks=1 保证。
- **SQLite 文件位置**：`anvil.db` 默认在 server 进程 cwd；开发期在 `apps/server/` 下，已被根 `.gitignore` 的 `*.db` 覆盖。
