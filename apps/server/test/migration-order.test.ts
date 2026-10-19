import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ensureCodexSchema } from "../src/db/client.js";

const serverRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(serverRoot, "../..");
const baselineTags = ["0000_dashing_loa", "0001_sturdy_hiroim", "0002_fair_scarlet_spider", "0003_luxuriant_sinister_six"];

function journal(entries: { idx: number; when: number; tag: string }[]) {
  return JSON.stringify({
    version: "7",
    dialect: "sqlite",
    entries: entries.map((entry) => ({ ...entry, version: "6", breakpoints: true })),
  });
}

function copySql(dir: string, tag: string, source: "local" | "t01") {
  const text = source === "local"
    ? fs.readFileSync(path.join(serverRoot, "drizzle", `${tag}.sql`), "utf8")
    : execFileSync("git", ["show", `codex/t01-git-github:apps/server/drizzle/${tag}.sql`], { cwd: repoRoot, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, `${tag}.sql`), text);
}

function apply(dir: string, db: Database.Database) {
  migrate(drizzle(db), { migrationsFolder: dir });
}

function columns(db: Database.Database, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

describe("T02 migration order", () => {
  it("covers baseline to T01 to merged, old T02 to merged, and empty merged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-migrate-"));
    const baseline = path.join(root, "baseline");
    fs.mkdirSync(path.join(baseline, "meta"), { recursive: true });
    for (const tag of baselineTags) copySql(baseline, tag, "local");
    fs.writeFileSync(path.join(baseline, "meta", "_journal.json"), journal([
      { idx: 0, when: 1785835701331, tag: "0000_dashing_loa" },
      { idx: 1, when: 1785836417031, tag: "0001_sturdy_hiroim" },
      { idx: 2, when: 1785912091874, tag: "0002_fair_scarlet_spider" },
      { idx: 3, when: 1787904488197, tag: "0003_luxuriant_sinister_six" },
    ]));

    const t01First = new Database(path.join(root, "t01-first.db"));
    apply(baseline, t01First);
    const withT01 = path.join(root, "with-t01");
    fs.cpSync(baseline, withT01, { recursive: true });
    copySql(withT01, "0004_narrow_norrin_radd", "t01");
    copySql(withT01, "0005_outstanding_songbird", "t01");
    fs.writeFileSync(path.join(withT01, "meta", "_journal.json"), journal([
      { idx: 0, when: 1785835701331, tag: "0000_dashing_loa" },
      { idx: 1, when: 1785836417031, tag: "0001_sturdy_hiroim" },
      { idx: 2, when: 1785912091874, tag: "0002_fair_scarlet_spider" },
      { idx: 3, when: 1787904488197, tag: "0003_luxuriant_sinister_six" },
      { idx: 4, when: 1791896089718, tag: "0004_narrow_norrin_radd" },
      { idx: 5, when: 1791898945916, tag: "0005_outstanding_songbird" },
    ]));
    apply(withT01, t01First);
    const merged = path.join(root, "merged");
    fs.cpSync(withT01, merged, { recursive: true });
    copySql(merged, "0006_t02_codex_profiles", "local");
    copySql(merged, "0007_t02_codex_ensure", "local");
    fs.writeFileSync(path.join(merged, "meta", "_journal.json"), journal([
      { idx: 0, when: 1785835701331, tag: "0000_dashing_loa" },
      { idx: 1, when: 1785836417031, tag: "0001_sturdy_hiroim" },
      { idx: 2, when: 1785912091874, tag: "0002_fair_scarlet_spider" },
      { idx: 3, when: 1787904488197, tag: "0003_luxuriant_sinister_six" },
      { idx: 4, when: 1788300000000, tag: "0006_t02_codex_profiles" },
      { idx: 5, when: 1791896089718, tag: "0004_narrow_norrin_radd" },
      { idx: 6, when: 1791898945916, tag: "0005_outstanding_songbird" },
      { idx: 7, when: 1792000000000, tag: "0007_t02_codex_ensure" },
    ]));
    apply(merged, t01First);
    ensureCodexSchema(t01First);
    expect(columns(t01First, "agent_profiles")).toContain("capabilities_json");
    expect(columns(t01First, "tasks")).toContain("execution_snapshot_json");
    t01First.close();

    const oldT02 = new Database(path.join(root, "old-t02.db"));
    const current = path.join(root, "current");
    fs.cpSync(baseline, current, { recursive: true });
    copySql(current, "0006_t02_codex_profiles", "local");
    fs.writeFileSync(path.join(current, "meta", "_journal.json"), journal([
      { idx: 0, when: 1785835701331, tag: "0000_dashing_loa" },
      { idx: 1, when: 1785836417031, tag: "0001_sturdy_hiroim" },
      { idx: 2, when: 1785912091874, tag: "0002_fair_scarlet_spider" },
      { idx: 3, when: 1787904488197, tag: "0003_luxuriant_sinister_six" },
      { idx: 4, when: 1788300000000, tag: "0006_t02_codex_profiles" },
    ]));
    apply(current, oldT02);
    oldT02.prepare(`INSERT INTO workspaces (id, name, slug, settings_json, created_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'Default', 'default', '{}', 't')`).run();
    oldT02.prepare(`INSERT INTO agent_profiles
      (id, workspace_id, provider, executable, sandbox, config_version, capabilities_json, auth_state, created_at, updated_at)
      VALUES ('p1', '00000000-0000-4000-8000-000000000001', 'codex', 'codex', 'workspace-write', 1, '{}', 'auth_not_checked', 't', 't')`).run();
    apply(merged, oldT02);
    ensureCodexSchema(oldT02);
    expect(oldT02.prepare(`SELECT id FROM agent_profiles WHERE id = 'p1'`).get()).toEqual({ id: "p1" });
    expect(columns(oldT02, "provider_sessions")).toContain("repo_path");
    const stamps = (oldT02.prepare(`SELECT created_at FROM __drizzle_migrations ORDER BY created_at`).all() as { created_at: number }[]).map((row) => row.created_at);
    expect(stamps).toContain(1788300000000);
    expect(stamps).toContain(1792000000000);
    oldT02.close();

    const fresh = new Database(path.join(root, "fresh.db"));
    apply(merged, fresh);
    ensureCodexSchema(fresh);
    ensureCodexSchema(fresh);
    expect(columns(fresh, "runtimes")).toContain("capabilities_json");
    expect(fresh.prepare(`SELECT COUNT(*) AS n FROM agent_profiles`).get()).toEqual({ n: 0 });
    fresh.close();
  });
});
