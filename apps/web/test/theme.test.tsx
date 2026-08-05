import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App.js";

vi.mock("../src/api.js", () => ({
  bootstrap: vi.fn(async () => ({
    workspace: { id: "ws1", name: "Default", slug: "default" },
    user: { id: "u1", name: "Owner" },
  })),
  listIssues: vi.fn(async () => []),
  listAgents: vi.fn(async () => []),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

describe("App shell", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("renders left nav with 看板 and Agents links", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /看板/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Agents/ })).toBeTruthy();
  });

  it("toggles theme: updates documentElement.dataset.theme and localStorage", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    const before = document.documentElement.dataset.theme;
    const toggle = screen.getByRole("button", { name: /深色模式|浅色模式/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).not.toBe(before),
    );
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
    expect(window.localStorage.getItem("anvil-theme")).toBe(
      document.documentElement.dataset.theme,
    );
  });
});
