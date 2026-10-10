import { afterEach, describe, expect, it, vi } from "vitest";
import { addComment, mergeTask, saveReviewMeasurement } from "../src/api.js";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("A08 测量传输", () => {
  it("三秒未响应则中止测量请求，不无限占用裁决入口", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("计时请求超时")));
    }));
    vi.stubGlobal("fetch", fetcher);
    const promise = saveReviewMeasurement("t1", { ui_version: "legacy", review_started_at: new Date().toISOString(), active_review_ms: 0, opened_transcript: true, opened_full_diff: false });
    const rejection = expect(promise).rejects.toThrow("计时请求超时");
    await vi.advanceTimersByTimeAsync(3000); await rejection;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("原有无 body merge 保持无 JSON 头，失败标记随原操作发出", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })); vi.stubGlobal("fetch", fetcher);
    await mergeTask("t1"); expect(fetcher).toHaveBeenLastCalledWith("/api/tasks/t1/merge", expect.objectContaining({ headers: undefined, body: undefined }));
    await mergeTask("t1", { review_measurement_failed_for: "t1" });
    expect(JSON.parse((fetcher.mock.calls as any)[1][1].body)).toEqual({ review_measurement_failed_for: "t1" });
    await addComment("i1", "补测试", { review_measurement_failed_for: "t1" });
    expect(JSON.parse((fetcher.mock.calls as any)[2][1].body)).toEqual({ body: "补测试", review_measurement_failed_for: "t1" });
  });
});
