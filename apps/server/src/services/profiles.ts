import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import {
  AUTH_STATES,
  CODEX_HELP_CAPABILITIES,
  CODEX_SANDBOX_MODES,
  EXECUTION_SNAPSHOT_SCHEMA,
  capabilitiesMatch,
  parseExecutionSnapshot,
  rejectReservedProfileFields,
  type AuthState,
  type CodexCapabilities,
  type CodexSandboxMode,
  type ExecutionSnapshot,
} from "@anvil/core";
import { newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";

export interface AgentProfileRow {
  id: string;
  workspace_id: string;
  provider: string;
  executable: string;
  sandbox: string;
  model: string | null;
  config_version: number;
  capabilities_json: string;
  auth_state: string;
  cli_version: string | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_FIELDS = new Set(["provider", "executable", "sandbox", "model"]);

export function validateProfileBody(body: Record<string, unknown>, partial = false): string | null {
  const reserved = rejectReservedProfileFields(body);
  if (reserved) return reserved;
  for (const key of Object.keys(body)) {
    if (!PROFILE_FIELDS.has(key)) return `不接受的配置字段：${key}`;
  }
  if (!partial || body.provider !== undefined) {
    if (body.provider !== "codex") return "目前只能配置 codex";
  }
  if (!partial || body.executable !== undefined) {
    if (typeof body.executable !== "string" || body.executable.trim() === "" || /[\r\n"]/.test(body.executable)) {
      return "executable 必须是非空路径";
    }
  }
  if (body.sandbox !== undefined && !(CODEX_SANDBOX_MODES as readonly string[]).includes(String(body.sandbox))) {
    return "sandbox 只允许 read-only 或 workspace-write";
  }
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(body.model)) return "model 不合法";
  }
  return null;
}

export function listProfiles(db: Db): AgentProfileRow[] {
  return db.select().from(schema.agentProfiles).all() as AgentProfileRow[];
}

export function getProfile(db: Db, id: string): AgentProfileRow | undefined {
  return db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.id, id)).all()[0] as AgentProfileRow | undefined;
}

export function createProfile(db: Db, workspaceId: string, body: { executable: string; sandbox?: CodexSandboxMode; model?: string | null }): AgentProfileRow {
  const now = new Date().toISOString();
  const id = newId();
  const row = {
    id,
    workspace_id: workspaceId,
    provider: "codex",
    executable: body.executable.trim(),
    sandbox: body.sandbox ?? "workspace-write",
    model: body.model ?? null,
    config_version: 1,
    capabilities_json: JSON.stringify(CODEX_HELP_CAPABILITIES),
    auth_state: "auth_not_checked" satisfies AuthState,
    cli_version: null,
    created_at: now,
    updated_at: now,
  };
  db.insert(schema.agentProfiles).values(row).run();
  return row;
}

export function updateProfile(db: Db, id: string, body: { executable?: string; sandbox?: CodexSandboxMode; model?: string | null }): AgentProfileRow | undefined {
  const current = getProfile(db, id);
  if (!current) return undefined;
  const now = new Date().toISOString();
  db.update(schema.agentProfiles).set({
    executable: body.executable?.trim() ?? current.executable,
    sandbox: body.sandbox ?? current.sandbox,
    model: body.model === undefined ? current.model : body.model,
    config_version: current.config_version + 1,
    auth_state: "auth_not_checked",
    updated_at: now,
  }).where(eq(schema.agentProfiles.id, id)).run();
  return getProfile(db, id);
}

export function snapshotForAgent(db: Db, agentId: string): { profile_id: string | null; config_version: number | null; snapshot_json: string | null; cli_version: string | null } | null {
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).all()[0];
  if (!agent || agent.provider !== "codex") return null;
  const profile = agent.profile_id ? getProfile(db, agent.profile_id) : undefined;
  const snapshot: ExecutionSnapshot = {
    schema: EXECUTION_SNAPSHOT_SCHEMA,
    provider: "codex",
    profile_id: profile?.id ?? null,
    config_version: profile?.config_version ?? 0,
    executable: profile?.executable ?? "codex",
    sandbox: (profile?.sandbox === "read-only" ? "read-only" : "workspace-write"),
    model: profile?.model ?? null,
    cli_version: profile?.cli_version ?? null,
    capabilities: CODEX_HELP_CAPABILITIES,
  };
  return {
    profile_id: profile?.id ?? null,
    config_version: profile?.config_version ?? null,
    snapshot_json: JSON.stringify(snapshot),
    cli_version: profile?.cli_version ?? null,
  };
}

export function runtimeCanRunTask(task: { execution_snapshot_json?: string | null }, runtime: { provider: string; capabilities_json?: string | null }): boolean {
  const snapshot = parseExecutionSnapshot(task.execution_snapshot_json);
  if (!snapshot) return true;
  if (snapshot.provider !== runtime.provider) return false;
  let actual: CodexCapabilities | null = null;
  if (runtime.capabilities_json) {
    try { actual = JSON.parse(runtime.capabilities_json) as CodexCapabilities; } catch { actual = null; }
  }
  return capabilitiesMatch(snapshot.capabilities, actual);
}

function runVersion(executable: string): Promise<{ ok: true; version: string } | { ok: false }> {
  return new Promise((resolve) => {
    execFile(executable, ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false });
      const version = (stdout || stderr).trim().split(/\r?\n/)[0] ?? "";
      if (!version) return resolve({ ok: false });
      resolve({ ok: true, version });
    });
  });
}

/** 只根据版本命令区分找不到和可执行。不读取认证，也不把帮助成功写成已登录。 */
export async function probeProfile(db: Db, id: string): Promise<AgentProfileRow | undefined> {
  const current = getProfile(db, id);
  if (!current) return undefined;
  const probed = await runVersion(current.executable);
  const authState: AuthState = probed.ok ? "executable" : "missing";
  if (!(AUTH_STATES as readonly string[]).includes(authState)) return current;
  db.update(schema.agentProfiles).set({
    auth_state: authState,
    cli_version: probed.ok ? probed.version : null,
    updated_at: new Date().toISOString(),
  }).where(eq(schema.agentProfiles.id, id)).run();
  return getProfile(db, id);
}
