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
