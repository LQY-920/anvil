import { createElement, StrictMode, useLayoutEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewTimer } from "../src/hooks/useReviewTimer.js";

let focused: boolean, visible: DocumentVisibilityState;
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const event = (target: EventTarget, name: string) => act(() => { target.dispatchEvent(new Event(name)); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  localStorage.clear(); focused = true; visible = "visible";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("A08 主动验收计时", () => {
  it("交付区刚提交 DOM 时已可采样，不依赖延后的 passive effect", () => {
    let snapshot: ReturnType<ReturnType<typeof useReviewTimer>["snapshot"]> | undefined;
    renderHook(() => {
      const timer = useReviewTimer("t1", true);
      useLayoutEffect(() => { snapshot = timer.snapshot(); }, [timer]);
      return timer;
    });
    expect(snapshot?.review_started_at).not.toBeNull(); expect(snapshot?.active_review_ms).toBe(0);
  });
  it("可见且聚焦时累计，默认记录已打开日志", () => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(4321);
    expect(result.current.snapshot()).toMatchObject({ active_review_ms: 4321, opened_transcript: true, opened_full_diff: false, ui_version: "legacy" });
    expect(result.current.snapshot().active_review_ms).toBe(4321);
  });
  it("窗口失焦后暂停，重新聚焦继续", () => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    focused = false; event(window, "blur"); advance(20_000);
    expect(result.current.snapshot().active_review_ms).toBe(1000);
    focused = true; event(window, "focus"); advance(2000);
    expect(result.current.snapshot().active_review_ms).toBe(3000);
  });
  it("隐藏时暂停，显示但未聚焦仍不累计", () => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    visible = "hidden"; event(document, "visibilitychange"); advance(5000);
    visible = "visible"; focused = false; event(document, "visibilitychange"); advance(5000);
    expect(result.current.snapshot().active_review_ms).toBe(1000);
    focused = true; event(window, "focus"); advance(1000);
    expect(result.current.snapshot().active_review_ms).toBe(2000);
  });
  it("60 秒无操作精确暂停，恢复交互后续计", () => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(90_000);
    expect(result.current.snapshot().active_review_ms).toBe(60_000);
    event(document, "pointerdown"); advance(5000);
    expect(result.current.snapshot().active_review_ms).toBe(65_000);
  });
  it.each(["keydown", "pointermove", "scroll"])("%s 交互延长活跃区间", name => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(59_000);
    event(document, name); advance(59_000);
    expect(result.current.snapshot().active_review_ms).toBe(118_000);
  });
  it("StrictMode effect 双运行不重复累计，卸载后停止", () => {
    const { result, unmount } = renderHook(() => useReviewTimer("t1", true), { wrapper: p => createElement(StrictMode, null, p.children) });
    advance(1200); expect(result.current.snapshot().active_review_ms).toBe(1200);
    unmount(); advance(5000); expect(result.current.snapshot().active_review_ms).toBe(1200);
  });
  it("刷新恢复累计和 Diff 标志，不累计关闭到重开间隔", () => {
    const first = renderHook(() => useReviewTimer("t1", true)); advance(2500);
    first.result.current.markFullDiff(); event(window, "pagehide"); first.unmount(); advance(30_000);
    const next = renderHook(() => useReviewTimer("t1", true)); advance(1500);
    expect(next.result.current.snapshot()).toMatchObject({ active_review_ms: 4000, opened_full_diff: true });
  });
  it("任务切换互相隔离，返回时接续本任务", () => {
    const { result, rerender } = renderHook(({ id }) => useReviewTimer(id, true), { initialProps: { id: "t1" } });
    advance(1000); result.current.markFullDiff(); rerender({ id: "t2" }); advance(2000);
    expect(result.current.snapshot()).toMatchObject({ active_review_ms: 2000, opened_full_diff: false });
    rerender({ id: "t1" }); advance(3000); expect(result.current.snapshot().active_review_ms).toBe(4000);
  });
  it("数据加载前不计时，启用后才开始", () => {
    const { result, rerender } = renderHook(({ enabled }) => useReviewTimer("t1", enabled), { initialProps: { enabled: false } });
    advance(10_000); rerender({ enabled: true }); advance(1000);
    expect(result.current.snapshot().active_review_ms).toBe(1000);
  });
  it("请求中暂停，失败重试接续累计，成功完成后刷新不重计", () => {
    const { result, unmount } = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    result.current.pause(); advance(10_000); expect(result.current.snapshot().active_review_ms).toBe(1000);
    result.current.resume(); advance(2000); expect(result.current.snapshot().active_review_ms).toBe(3000);
    result.current.finish(); unmount(); advance(5000);
    const next = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    expect(next.result.current.snapshot().active_review_ms).toBe(3000);
  });
  it("失败标记跨刷新保留，不能变回有效测量", () => {
    const first = renderHook(() => useReviewTimer("t1", true)); advance(1000); first.result.current.invalidate(); first.unmount();
    const next = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    expect(next.result.current.snapshot()).toMatchObject({ review_started_at: null, active_review_ms: null });
  });
  it("本地存储不可用时不阻断操作，但不制造有效样本", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("配额不足"); });
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    expect(result.current.snapshot().active_review_ms).toBeNull();
  });
  it("墙钟回拨不能产生负数或超墙钟的样本", () => {
    const { result } = renderHook(() => useReviewTimer("t1", true)); advance(1000);
    vi.setSystemTime(Date.now() - 5000);
    expect(result.current.snapshot().active_review_ms).toBeNull();
  });
});
