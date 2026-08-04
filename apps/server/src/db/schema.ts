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
