import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AgentsPage from "../src/pages/AgentsPage.js";

vi.mock("../src/api.js", () => ({
  listAgents: vi.fn(async () => [
    { id: "a1", workspace_id: "ws", name: "小K", provider: "kimi", status: "idle", max_concurrent_tasks: 1, runtime_id: null, created_at: "x" },
  ]),
  listRuntimes: vi.fn(async () => [
    { id: "r1", workspace_id: "ws", daemon_id: "daemon-abc", provider: "kimi", version: "1.0.0", status: "online", last_seen_at: "x" },
  ]),
  createAgent: vi.fn(),
  createDaemonToken: vi.fn(async () => ({ id: "t", token: "anv_secret" })),
}));

describe("AgentsPage", () => {
  it("lists agents and runtimes", async () => {
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("小K")).toBeTruthy());
    expect(screen.getByText("daemon-abc")).toBeTruthy();
    expect(screen.getByText("在线")).toBeTruthy();
  });
});
