import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskPanel from "../src/components/TaskPanel.js";
import * as api from "../src/api.js";

vi.mock("../src/api.js", () => ({
  getTask: vi.fn(async () => ({
    task: { id: "t1", issue_id: "i1", status: "completed", agent_id: "a1", error: null, failure_reason: null },
    issue: { id: "i1", title: "修 bug", status: "in_progress", description: "详细描述" },
  })),
  getTaskMessages: vi.fn(async () => []),
  getIssueDetail: vi.fn(async () => ({ issue: { id: "i1", title: "修 bug" }, comments: [] })),
  getTaskDiff: vi.fn(async () => ({
    branch: "agent/t1", base: "main",
    diff_stat: " src/a.ts | 2 +-",
    diff_text: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    truncated: false,
  })),
  mergeTask: vi.fn(async () => ({ ok: true, merged_branch: "agent/t1", target: "main" })),
  cancelTask: vi.fn(),
  addComment: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

describe("TaskPanel", () => {
  it("renders review zone with diff stat and merge button, merges on click", async () => {
    render(<TaskPanel taskId="t1" />);
    await waitFor(() => expect(screen.getByText("合入 main")).toBeTruthy());
    expect(screen.getByText("修 bug")).toBeTruthy();
    expect(screen.getByText("agent/t1")).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts \| 2/)).toBeTruthy();
    fireEvent.click(screen.getByText("合入 main"));
    await waitFor(() => expect(screen.getByText("✓ 已合入 agent/t1")).toBeTruthy());
    expect(api.mergeTask).toHaveBeenCalledWith("t1");
  });
});
