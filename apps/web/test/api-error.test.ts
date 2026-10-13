import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getTaskDiff, mergeTask } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("审查请求错误", () => {
  it("保留 HTTP 状态、错误码和后端说明，原错误文本仍可读取", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 409,
      json: async () => ({ code: "recovery_required", error: "合入结果待恢复确认。" }),
    })));
    const error = await mergeTask("t1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409, code: "recovery_required", detail: "合入结果待恢复确认。",
      message: "POST /api/tasks/t1/merge → 409 — 合入结果待恢复确认。",
    });
  });

  it("旧服务端仅返回 error 时仍保留说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "历史请求失败" }),
    })));
    await expect(mergeTask("t1")).rejects.toMatchObject({
      status: 400, code: undefined, detail: "历史请求失败",
      message: "POST /api/tasks/t1/merge → 400 — 历史请求失败",
    });
  });

  it("非 JSON 错误不丢失请求路径和 HTTP 状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError("返回了 HTML"); },
    })));
    await expect(getTaskDiff("t1")).rejects.toMatchObject({
      status: 502, code: undefined, detail: undefined,
      message: "GET /api/tasks/t1/diff → 502",
    });
  });
});
