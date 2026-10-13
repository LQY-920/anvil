import { spawn } from "node:child_process";
import { integrationDiagnostic } from "../services/integration-attempts.js";

export interface GitHubResponse<T> { data: T; headers: Record<string, string>; }
export interface GitHubClient {
  request<T>(host: string, method: "GET" | "POST", endpoint: string, body?: unknown, headers?: Record<string, string>): Promise<GitHubResponse<T>>;
}

export class GitHubError extends Error {
  constructor(message: string, public readonly http = 503, public readonly code = "github_unavailable",
    public readonly retryable = true, public readonly retryAfterMs = 0, public readonly outcomeUnknown = false) {
    super(integrationDiagnostic(message)); this.name = "GitHubError";
  }
}

export function allowedGitHubHosts(): string[] {
  return (process.env.ANVIL_GITHUB_HOSTS || "github.com").split(",").map(value => value.trim().toLowerCase())
    .filter(value => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value));
}

export function checkGitHubHost(host: string): void {
  if (!allowedGitHubHosts().includes(host.toLowerCase())) throw new GitHubError("GitHub 主机未在允许列表中", 400, "github_host_denied", false);
}

/** 仅接受不含密码、查询串或片段的明确 GitHub 仓库地址。 */
export function parseGitHubRepository(value: string): { host: string; owner: string; name: string; fullName: string } {
  let host: string, pathname: string;
  const scp = /^git@([^/:\s]+):([^\s]+)$/.exec(value);
  if (scp) { host = scp[1].toLowerCase(); pathname = scp[2]; }
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw new GitHubError("请填写 HTTPS 或 SSH GitHub 仓库地址", 400, "invalid_repository", false); }
    if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || url.port
      || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) {
      throw new GitHubError("仓库地址不能包含凭据、端口、查询串或片段", 400, "invalid_repository", false);
    }
    host = url.hostname.toLowerCase(); pathname = url.pathname.replace(/^\//, "");
  }
  checkGitHubHost(host);
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(pathname);
  if (!match || [match[1], match[2]].some(part => part === "." || part === "..")) {
    throw new GitHubError("仓库地址必须包含一个所有者和一个仓库名", 400, "invalid_repository", false);
  }
  return { host, owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

export function githubRepositoryPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
    throw new GitHubError("远端仓库名称非法", 502, "invalid_github_response", false);
  }
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}

export function retryDelay(headers: Record<string, string>, now = Date.now()): number {
  const retry = headers["retry-after"];
  if (retry) {
    const seconds = Number(retry);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    const delay = Number(headers["x-ratelimit-reset"]) * 1000 - now;
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return 0;
}

/** gh 的通路限定到本功能的查询和创建 PR；没有合并、保护设置或任意 URL 能力。 */
export function validateGitHubRequest(host: string, method: string, endpoint: string): void {
  checkGitHubHost(host);
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || /[\r\n\\]/.test(endpoint)) throw new GitHubError("GitHub 接口不在允许范围", 400, "github_endpoint_denied", false);
  const url = new URL(endpoint, `https://${host}`);
  const repository = "/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
  const permitted = method === "POST" ? new RegExp(`^${repository}/pulls$`).test(url.pathname)
    : method === "GET" && (url.pathname === "/user" || /^\/repositories\/\d+$/.test(url.pathname)
      || new RegExp(`^${repository}(?:/(?:branches/[^/]+|issues/\\d+|pulls(?:/\\d+)?|git/ref/heads/.+|commits/[a-fA-F0-9]{40}/(?:check-runs|status)))?$`).test(url.pathname));
  if (!permitted || [...url.searchParams.keys()].some(key => !["state", "head", "base", "per_page", "page"].includes(key))) {
    throw new GitHubError("GitHub 接口不在允许范围", 400, "github_endpoint_denied", false);
  }
}

export interface GhClientOptions { command?: string; argsPrefix?: string[]; timeoutMs?: number; maxBytes?: number; }

export class GhClient implements GitHubClient {
  constructor(private readonly options: GhClientOptions = {}) {}
  async request<T>(host: string, method: "GET" | "POST", endpoint: string, body?: unknown, headers: Record<string, string> = {}): Promise<GitHubResponse<T>> {
    validateGitHubRequest(host, method, endpoint);
    if (method === "GET" && body !== undefined) throw new GitHubError("GET 不接受写入载荷", 400, "invalid_request", false);
    for (const [name, value] of Object.entries(headers)) {
      if (!["if-none-match", "if-modified-since"].includes(name.toLowerCase()) || /[\r\n]/.test(value)) {
        throw new GitHubError("不允许的 GitHub 请求头", 400, "invalid_request", false);
      }
    }
    const args = [...(this.options.argsPrefix ?? []), "api", "--hostname", host, "--method", method, "--include",
      "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
    for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
    if (body !== undefined) args.push("--input", "-");
    args.push(endpoint);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(this.options.command ?? "gh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" } });
      const output: Buffer[] = []; let bytes = 0, stderr = "", aborted = false;
      const stop = (message: string) => { if (aborted) return; aborted = true; child.kill(); reject(new GitHubError(message, 503, "github_transport_error", true, 0, method === "POST")); };
      const timer = setTimeout(() => stop("GitHub 请求超时，需先查询远端结果"), this.options.timeoutMs ?? 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (this.options.maxBytes ?? 2 * 1024 * 1024)) { stop("GitHub 响应超过大小限制"); return; }
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
      child.on("error", () => { clearTimeout(timer); stop("无法启动 gh，请确认本机已安装并登录"); });
      child.on("close", code => { clearTimeout(timer); if (!aborted) resolve({ code, stdout: Buffer.concat(output).toString("utf8"), stderr }); });
      child.stdin.on("error", () => { /* 进程先退出时由 close/error 统一报告。 */ });
      child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const split = /\r?\n\r?\n/.exec(result.stdout);
    const headerText = split ? result.stdout.slice(0, split.index) : "";
    const payload = split ? result.stdout.slice(split.index + split[0].length) : result.stdout;
    const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(headerText)?.[1] ?? (result.code === 0 ? 200 : 503));
    const responseHeaders: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/).slice(1)) {
      const index = line.indexOf(":"); if (index > 0) responseHeaders[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    }
    if (status === 304) return { data: null as T, headers: { ...responseHeaders, ":status": "304" } };
    let data: unknown;
    try { data = payload.trim() ? JSON.parse(payload) : null; } catch {
      throw new GitHubError("GitHub 返回了无法解析的结果", 502, "invalid_github_response", true, retryDelay(responseHeaders), method === "POST");
    }
    if (result.code !== 0 || status >= 400) {
      const rate = status === 429 || (status === 403 && (retryDelay(responseHeaders) > 0 || /rate limit|secondary rate/i.test(payload)));
      const message = typeof (data as any)?.message === "string" ? (data as any).message : result.stderr || "GitHub 请求失败";
      throw new GitHubError(message, rate ? 429 : status, rate ? "github_rate_limited" : status === 401 || status === 403 ? "github_permission_denied" : "github_request_failed",
        rate || status >= 500, retryDelay(responseHeaders), method === "POST" && status >= 500);
    }
    return { data: data as T, headers: responseHeaders };
  }
}
