import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RepositoriesPage from "../src/pages/RepositoriesPage.js";
import * as api from "../src/api.js";
import { repository } from "./integration-fixtures.js";
vi.mock("../src/api.js", async original => ({ ...(await original<typeof import("../src/api.js")>()), listRepositories: vi.fn(), bindRepository: vi.fn(), syncRepository: vi.fn(), importRepositoryIssue: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.listRepositories).mockResolvedValue([]); });
afterEach(cleanup);
const renderPage = () => render(<MemoryRouter><RepositoriesPage /></MemoryRouter>);

describe("T01 仓库配置", () => {
  it("GitHub SSH 地址原样提交，重命名冲突必须明确确认才再次绑定", async () => {
    vi.mocked(api.bindRepository).mockRejectedValueOnce(new api.ApiError("409", 409, "repository_renamed", "稳定仓库 ID 相同，名称已经变化"));
    vi.mocked(api.bindRepository).mockResolvedValueOnce(repository);
    renderPage(); fireEvent.change(screen.getByLabelText("交付模式"), { target: { value: "github_pr" } });
    fireEvent.change(screen.getByLabelText("GitHub 仓库地址（HTTPS 或 SSH）"), { target: { value: "git@github.com:owner/repo.git" } });
    fireEvent.click(screen.getByText("检查并绑定"));
    await screen.findByText("稳定仓库 ID 相同，名称已经变化");
    expect(api.bindRepository).toHaveBeenCalledTimes(1);
    expect((screen.getByText("确认名称变化并重新绑定") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByText("确认名称变化并重新绑定"));
    await screen.findByText("owner/repo");
    expect(api.bindRepository).toHaveBeenLastCalledWith({ mode: "github_pr", repo: "git@github.com:owner/repo.git", target_branch: "main", confirm_rename: true });
  });

  it("只导入指定 Issue 并链接配置，不指派任务", async () => {
    vi.mocked(api.listRepositories).mockResolvedValue([repository]);
    vi.mocked(api.importRepositoryIssue).mockResolvedValue({ issue_id: "i1", source_snapshot_id: "s1", disposition: "created" });
    renderPage(); await screen.findByText("owner/repo");
    fireEvent.change(screen.getByLabelText("owner/repo 的 Issue 编号"), { target: { value: "42" } });
    fireEvent.click(screen.getByText("导入指定 Issue"));
    expect((await screen.findByRole("link", { name: "导入完成，打开 Issue 配置与指派" })).getAttribute("href")).toBe("/?issue=i1");
    expect(api.importRepositoryIssue).toHaveBeenCalledWith("r1", 42);
  });

  it("连接失败保留真实错误，未来同步时间使手动刷新冷却", async () => {
    vi.mocked(api.listRepositories).mockResolvedValue([{ ...repository, connection_status: "unavailable", can_push: false, connection_login: null, error: "网络不可达", next_sync_at: new Date(Date.now() + 60_000).toISOString() }]);
    renderPage(); await screen.findByText("owner/repo");
    expect(screen.getByText("连接：连接不可用")).toBeTruthy();
    expect(screen.queryByText("连接：连接可用")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("网络不可达");
    expect((screen.getByRole("button", { name: /刷新冷却/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.syncRepository).not.toHaveBeenCalled();
  });

  it("同步请求失败不把历史连接记录刷新为成功", async () => {
    vi.mocked(api.listRepositories).mockResolvedValue([{ ...repository, connection_status: "permission_denied", error: "无仓库权限" }]);
    vi.mocked(api.syncRepository).mockRejectedValue(new api.ApiError("403", 403, "permission_denied", "当前身份无权限"));
    renderPage(); fireEvent.click(await screen.findByText("刷新连接与远端状态"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("当前身份无权限"));
    expect(screen.getByText("连接：最新连接检查失败，请核对错误")).toBeTruthy();
  });
});
