import { useLayoutEffect, useMemo } from "react";
import type { ReviewMeasurementRequest } from "@anvil/core";

const IDLE_MS = 60_000;
interface Draft {
  version: 1;
  startedAt: string | null;
  activeMs: number;
  openedFullDiff: boolean;
  invalid: boolean;
  finished: boolean;
}

/** 每个任务独立的累计量。只保存已发生的时间，刷新期间不推算任何活动。 */
function createTimer(taskId: string) {
  const key = `anvil:review-timer:legacy:${taskId}`;
  let draft: Draft = { version: 1, startedAt: null, activeMs: 0, openedFullDiff: false, invalid: false, finished: false };
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Draft;
      if (parsed.version !== 1 || typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt)) || !Number.isSafeInteger(parsed.activeMs) || parsed.activeMs < 0 ||
        typeof parsed.openedFullDiff !== "boolean" || typeof parsed.invalid !== "boolean" || typeof parsed.finished !== "boolean") throw new Error("无效计时草稿");
      draft = parsed;
    }
  } catch { draft.invalid = true; }
  let attached = false, paused = false, focused = false, visible = false;
  let lastActivity = 0, cursor: number | null = null;
  const persist = () => {
    if (!draft.startedAt) return;
    try { localStorage.setItem(key, JSON.stringify({ ...draft, activeMs: Math.floor(draft.activeMs) })); }
    catch { draft.invalid = true; }
  };
  const settle = () => {
    const now = performance.now();
    if (cursor !== null) {
      draft.activeMs += Math.max(0, Math.min(now, lastActivity + IDLE_MS) - cursor);
      cursor = now >= lastActivity + IDLE_MS ? null : now;
    }
  };
  const activate = () => {
    lastActivity = performance.now();
    cursor = attached && !paused && !draft.finished && focused && visible ? lastActivity : null;
  };
  const interact = () => {
    settle(); activate(); persist();
  };
  const onFocus = () => { settle(); focused = true; activate(); persist(); };
  const onBlur = () => { settle(); focused = false; cursor = null; persist(); };
  const onVisibility = () => {
    settle(); visible = document.visibilityState === "visible"; focused = document.hasFocus(); activate(); persist();
  };
  const onPageHide = () => { settle(); visible = false; cursor = null; persist(); };
  const interactions = ["pointerdown", "pointermove", "keydown", "scroll", "input"];
  const timer = {
    attach() {
      attached = true;
      if (!draft.startedAt) draft.startedAt = new Date().toISOString();
      visible = document.visibilityState === "visible"; focused = document.hasFocus(); activate(); persist();
      interactions.forEach(name => document.addEventListener(name, interact, { passive: true, capture: true }));
      window.addEventListener("focus", onFocus); window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide); window.addEventListener("pageshow", onVisibility);
      // 定期保存已发生的活动；pagehide/cleanup 另行保存不足一秒的尾段。
      const interval = setInterval(() => { settle(); persist(); }, 1000);
      return () => {
        settle(); attached = false; cursor = null; persist(); clearInterval(interval);
        interactions.forEach(name => document.removeEventListener(name, interact, true));
        window.removeEventListener("focus", onFocus); window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide); window.removeEventListener("pageshow", onVisibility);
      };
    },
    pause() { settle(); paused = true; cursor = null; persist(); },
    resume() { paused = false; activate(); },
    finish() { timer.pause(); draft.finished = true; persist(); },
    invalidate() { draft.invalid = true; persist(); },
    markFullDiff() { draft.openedFullDiff = true; persist(); },
    snapshot(): ReviewMeasurementRequest {
      settle();
      const ms = Math.floor(draft.activeMs);
      if (!draft.startedAt || ms > Date.now() - Date.parse(draft.startedAt)) draft.invalid = true;
      persist();
      return { ui_version: "legacy", review_started_at: draft.invalid ? null : draft.startedAt,
        active_review_ms: draft.invalid ? null : ms, opened_transcript: true, opened_full_diff: draft.openedFullDiff };
    },
  };
  return timer;
}

export function useReviewTimer(taskId: string, enabled: boolean) {
  const timer = useMemo(() => createTimer(taskId), [taskId]);
  // 交付按钮显示前完成初始化，避免首帧点击先于 passive effect 导致空采样。
  useLayoutEffect(() => enabled ? timer.attach() : undefined, [timer, enabled]);
  return timer;
}
