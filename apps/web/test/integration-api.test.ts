import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/api.js";
afterEach(() => vi.unstubAllGlobals());

describe("T01 API 传输", () => {
  it("裁决、交付与恢复发送明确幂等键；无 body 的同步不加 JSON 头", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({}) })); vi.stubGlobal("fetch", fetcher);
    const body = { expected_head: "b".repeat(40), expected_version: "v1" };
    await api.submitTaskDecision("t1", { ...body, result: "approved" }, "decision-key");
    await api.createTaskPullRequest("t1", body, "pr-key");
    await api.integrateTask("t1", body, "local-key");
    await api.recoverTaskOperation("t1", "op1", body, "recovery-key");
    for (const [index, key] of ["decision-key", "pr-key", "local-key", "recovery-key"].entries()) {
      const options = (fetcher.mock.calls as any)[index][1];
      expect(options.headers).toEqual({ "content-type": "application/json", "Idempotency-Key": key });
      expect(JSON.parse(options.body)).toMatchObject(body);
    }
    expect(fetcher).toHaveBeenLastCalledWith("/api/tasks/t1/operations/op1/recover", expect.anything());
    await api.syncRepository("r1");
    expect(fetcher).toHaveBeenLastCalledWith("/api/repositories/r1/sync", expect.objectContaining({ method: "POST", headers: undefined, body: undefined }));
  });

  it("导入仅发送明确编号；接受来源提交指定快照", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({}) })); vi.stubGlobal("fetch", fetcher);
    await api.importRepositoryIssue("r1", 42);
    expect(fetcher).toHaveBeenLastCalledWith("/api/repositories/r1/import-issue", expect.objectContaining({ body: '{"issue_number":42}' }));
    await api.acceptIssueSource("i1", "source-2");
    expect(fetcher).toHaveBeenLastCalledWith("/api/issues/i1/accept-source", expect.objectContaining({ body: '{"snapshot_id":"source-2"}' }));
  });

  it("新路由保留机器错误与服务端中文说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code: "source_changed", error: "来源已变化，请先核对差异" }) })));
    await expect(api.importRepositoryIssue("r1", 42)).rejects.toMatchObject({ status: 409, code: "source_changed", detail: "来源已变化，请先核对差异" });
  });
});
