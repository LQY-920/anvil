import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FastifyInstance;
const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-guidance-"));
  tmpDirs.push(dir);
  return dir;
}

function guidance(repo?: string) {
  const url = repo === undefined ? "/api/guidance" : `/api/guidance?repo=${encodeURIComponent(repo)}`;
  return app.inject({ method: "GET", url });
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

afterEach(async () => {
  await app.close();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 临时目录清理失败可忽略 */ }
  }
});

describe("GET /api/guidance", () => {
  it("本地路径：命中 ANVIL.md 返回 found/content", async () => {
    const repo = makeTmp();
    fs.writeFileSync(path.join(repo, "ANVIL.md"), "改完跑 pnpm test\n");
    const res = await guidance(repo);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: true, content: "改完跑 pnpm test\n", truncated: false });
  });

  it("内容超 2000 字符：截断为恰好 2000 且 truncated=true", async () => {
    const repo = makeTmp();
    fs.writeFileSync(path.join(repo, "ANVIL.md"), "x".repeat(3000));
    const res = await guidance(repo);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.found).toBe(true);
    expect(body.truncated).toBe(true);
    expect(body.content).toHaveLength(2000);
    expect(body.content).toBe("x".repeat(2000));
  });

  it("ANVIL.md 不存在 → found:false", async () => {
    const res = await guidance(makeTmp());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: false });
  });

  it("ANVIL.md 为纯空白 → found:false（与 runner 不注入对齐）", async () => {
    const repo = makeTmp();
    fs.writeFileSync(path.join(repo, "ANVIL.md"), "  \n\t\n");
    const res = await guidance(repo);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ found: false });
  });

  it("repo 缺失或空串 → 400 repo required", async () => {
    const missing = await guidance();
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "repo required" });
    const empty = await guidance("");
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "repo required" });
  });

  it("URL 仓库无缓存 → found:false", async () => {
    // ANVIL_RUNNER_ROOT 指向空目录，该 URL 的缓存路径必然不存在
    const runnerRoot = makeTmp();
    const prev = process.env.ANVIL_RUNNER_ROOT;
    process.env.ANVIL_RUNNER_ROOT = runnerRoot;
    try {
      const res = await guidance("https://github.com/user/never-cloned.git");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ found: false });
    } finally {
      if (prev === undefined) delete process.env.ANVIL_RUNNER_ROOT;
      else process.env.ANVIL_RUNNER_ROOT = prev;
    }
  });
});
