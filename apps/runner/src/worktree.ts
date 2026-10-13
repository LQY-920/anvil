import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRepoUrl, repoCachePath, withGitLock, type Issue, type RepositorySnapshot } from "@anvil/core";
import { ensureRepoCache } from "./repocache.js";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-replace-objects", ...args], {
      cwd, windowsHide: true, timeout: 30_000,
      // 无凭据时立即失败而非挂到超时:禁终端密码提示与 GCM 交互弹窗
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

let gitChecked = false;

/** 确保 git 可用：不在 PATH 时探测常见安装路径并注入 process.env.PATH（子进程含 Agent CLI 一并继承）。 */
export async function ensureGitAvailable(): Promise<void> {
  if (gitChecked) return;
  if (await probe("git")) { gitChecked = true; return; }
  const candidates = [
    process.env.GIT_EXE,
    "D:\\codingTools\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (await probe(c)) {
      process.env.PATH = `${path.dirname(c)}${path.delimiter}${process.env.PATH ?? ""}`;
      gitChecked = true;
      return;
    }
  }
  throw new Error("git 不可用：PATH 中找不到,已知安装路径也探测失败(可设 GIT_EXE 指定)");
}

// =============================================================================
// A04 · Git 锚点:workDir + 任务分支 + 目标分支 + 完整 40 位 baseCommit + resumed
//
// 关键不变量(PRD FR-001,AGENTS.md 不变量):
//  1. Git 仓库任务的 baseCommit 必须是完整 40 位 hex SHA-1,绝不允许短 SHA 或 "HEAD"。
//  2. detached HEAD 必须明确失败,不得把 "HEAD" 当作 targetBranch。
//  3. worktree 必须从已固化的 baseCommit 创建,不能在多个命令之间重新读取浮动的 HEAD。
//  4. Resume 必须使用 Task 已保存的锚点,不得用当前目标分支 HEAD 覆盖已保存 baseCommit。
//  5. 无 repo_path 的普通目录任务:taskBranch/targetBranch/baseCommit 一律为 null,
//     后续 Start 继续走当前无 anchors 兼容路径(daemon_id + work_dir),不伪造 Git 事实。
//
// A04-FIX2 · Resume 仓库身份校验 + 状态矩阵细化:
//  6. Resume 前必须验证 priorWorkDir 与 issue.repo_path 指向同一 Git common directory,
//     防止 PATCH Issue 改 repo_path 后 Runner 在错误仓库中执行。
//  7. 状态矩阵:
//     A. Initial/Fresh 合法:priorWorkDir == null 且 savedAnchors 三项全 null。
//     B. Resume 合法:priorWorkDir 非空且目录存在,savedAnchors 三项齐全且合法,
//        priorWorkDir 与 issue.repo_path 同仓库,worktree 分支 === saved taskBranch。
//     C. 非法矛盾:上述条件任一不满足 → 任何 git worktree add / Start 之前明确失败。
//  8. 无 repo_path 普通目录任务不得携带任何 saved Git anchor(防止忽略异常锚点)。
//
// A04-FIX3 · 仓库身份精度 + 空字符串锚点严格化:
//  9. 仓库身份 dev/ino 必须直接从 fs.statSync(path, { bigint: true }) 取得,
//     不得先取普通 fs.Stats 再 BigInt(number) 转换(Windows 上 inode 会丢失精度)。
// 10. 仓库身份比较规则:同规范路径 ⇒ 相同;不同路径 + 两边都是 0n/0n ⇒ 不同;
//     不同路径 + 精确非零 dev/ino 相同 ⇒ 相同;其余 ⇒ 不同。
// 11. stat 必须作用于真实可访问的路径;小写化与长路径前缀归一化只能用于比较字符串。
// 12. hasAnySavedAnchor / areAllAnchorsPresent 严格按 null/undefined 判断,
//     空字符串视为"已提供但非法",后续必须按格式校验失败。
//
// A04-FIX4 · 仓库身份退化判定收紧(在 A04-FIX3 基础上继续修复两类误判):
// 13. "有效文件标识"严格定义为 dev !== 0n 且 ino !== 0n,缺一不可:
//     {dev:0n, ino:5n} 与 {dev:5n, ino:0n} 都不得当作有效文件标识。
// 14. reposEqualById 顺序:
//     A. 双方都有有效文件标识 ⇒ 仅 dev+ino 同时精确相等 ⇒ 相同;只要文件标识
//        不同(即使显示层 path 字符串完全相同)就必须返回 false,防止同一路径
//        已被删除 / 替换 / 重新 clone 后被误认为原仓库。
//     B. 任意一方没有有效文件标识 ⇒ 不得用不完整 dev/ino 比较,只能退化到
//        "保留大小写的真实路径"比较(canonicalizeRealPathForIdentity);真实
//        路径精确相同 ⇒ 相同;不同 ⇒ 不同。
//     C. canonicalizePathForCompare 的全小写结果(path 字段)只用于显示与错误
//        信息,不得作为强身份依据;reposEqualById 不允许把它当一等公民。
// 15. canonicalizeRealPathForIdentity 是新增的纯字符串归一函数:
//     A. 正确处理 \\?\ 与 \\?\UNC\ 前缀(UNC 根必须保留双反斜杠);
//     B. 可以统一盘符字母大小写,但不动路径其余段(必须保留 Repo 与 repo 的
//        区别,不得被显示层小写化抹平);
//     C. 不主动对路径其余段小写;非 Windows 平台不改变大小写;
//     D. 不得执行 stat;任何 stat 必须仍作用于 realPath + {bigint:true}。
// 16. assertResumeRepository 仍然只调 reposEqualById,不在自身内重新做身份
//     判定;URL 缓存路径也走 realPath + BigIntStats 的精确读取路径。
// =============================================================================

const SHA1_40 = /^[0-9a-f]{40}$/i;

// -----------------------------------------------------------------------------
// A04-FIX3 · 路径规范化与仓库身份比较(纯函数,可独立测试)
// -----------------------------------------------------------------------------

/**
 * Windows 路径纯字符串归一(用于比较展示,绝不直接喂给 fs.statSync):
 *  - 去除 `\\?\` 长路径前缀;
 *  - 把 `\\?\UNC\<server>\<share>\...` 还原成 `<server>\<share>\...` 形式的 UNC 路径,
 *    **保留开头的双反斜杠**,不能错误地变成 `UNC\...`;
 *  - 统一大小写(NTFS 不区分大小写)和分隔符。
 *
 * 非 Windows 平台(或 `win32Mode=false`):不主动小写,只把分隔符归一为 POSIX。
 * 显式 `win32Mode` 是为让非 Windows 跑测时可以覆盖 Windows 行为,防止平台差异掩盖 bug。
 */
export function canonicalizePathForCompare(p: string, win32Mode: boolean = process.platform === "win32"): string {
  if (win32Mode) {
    let s = p;
    if (s.startsWith("\\\\?\\UNC\\")) {
      // 形如 \\?\UNC\server\share\repo\.git  →  \\server\share\repo\.git
      s = `\\\\${s.slice("\\\\?\\UNC\\".length)}`;
    } else if (s.startsWith("\\\\?\\")) {
      s = s.slice("\\\\?\\".length);
    }
    s = s.replace(/\//g, "\\");
    return s.toLowerCase();
  }
  return p.replace(/\\/g, "/");
}

/**
 * A04-FIX4 · 仓库身份退化比较用的"真实路径"纯字符串归一(不调用 fs.statSync):
 *  - 与 canonicalizePathForCompare 的关键差异:不动路径其余段的大小写,必须
 *    保留 `Repo` 与 `repo` 的区分(显示层可小写,身份层不可小写);
 *  - Windows 下统一 `/` 与 `\`,盘符字母大小写可统一(`c:` ⇒ `C:`),其余段保留原样;
 *  - 正确处理 `\\?\` 与 `\\?\UNC\` 前缀(UNC 根必须保留开头的双反斜杠);
 *  - 非 Windows 平台不主动改变大小写,只把分隔符归一为 `/`。
 *
 * 重要:此函数只对字符串做归一,不得对结果执行 stat;任何 stat 仍必须作用于
 * `realPath` + `fs.statSync(p, { bigint: true })` 拿到的真实可访问路径。
 *
 * 默认 `win32Mode = process.platform === "win32"`;测试可通过显式 `win32Mode: true`
 * 在非 Windows 上强制走 Windows 分支验证长路径 / UNC / 大小写保留行为。
 */
export function canonicalizeRealPathForIdentity(
  p: string,
  win32Mode: boolean = process.platform === "win32",
): string {
  if (win32Mode) {
    let s = p;
    if (s.startsWith("\\\\?\\UNC\\")) {
      // \\?\UNC\server\share\repo  →  \\server\share\repo(UNC 根保留双反斜杠)
      s = `\\\\${s.slice("\\\\?\\UNC\\".length)}`;
    } else if (s.startsWith("\\\\?\\")) {
      // \\?\C:\Repo  →  C:\Repo
      s = s.slice("\\\\?\\".length);
    }
    // 统一 / 与 \
    s = s.replace(/\//g, "\\");
    // 只把盘符字母变成大写(后续路径段必须保留原大小写,不得被全小写化抹平)
    if (/^[a-zA-Z]:/.test(s)) {
      s = s[0].toUpperCase() + s.slice(1);
    }
    return s;
  }
  return p.replace(/\\/g, "/");
}

/**
 * 真实路径 stat:必须作用于真实可访问的路径,不得先 lowercase 再 stat。
 * 返回值直接来自 fs.statSync 的 BigIntStats,保留 dev/ino 完整精度。
 */
function statBigInt(existingPath: string): fs.BigIntStats {
  try {
    return fs.statSync(existingPath, { bigint: true });
  } catch (e: any) {
    throw new Error(`无法 stat 路径 (${existingPath}): ${e?.message ?? e}`);
  }
}

/**
 * 把任意路径解析为真实可访问的绝对路径(realpath 解析符号链接与 `.`/`..`),
 * stat 阶段必须使用此返回值(避免小写化或长路径归一破坏 stat)。
 */
export function resolveRealPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // 路径可能不存在/无权限访问,fall back 到绝对路径
    return abs;
  }
}

/**
 * 把任意路径转成稳定可比较的规范形式:
 *  - path.resolve 取得绝对路径
 *  - fs.realpathSync 解析符号链接
 *  - Windows 去掉 `\\?\` 长路径前缀并小写(NTFS 不区分大小写),UNC 根保留双反斜杠
 *  - POSIX 保持原样(区分大小写)
 * 失败时(如路径不存在)回退到绝对路径,不抛错。
 *
 * 重要:此函数返回的是**字符串**,仅用于比较与错误展示。
 * 任何需要 stat 的调用方都应当先拿 `resolveRealPath` 取得真实路径,再 stat。
 */
export function canonicalizeFsPath(p: string): string {
  return canonicalizePathForCompare(resolveRealPath(p));
}

/**
 * 读 git common directory(对 worktree 就是主仓库的 .git,对普通仓库就是自身 .git),
 * 同时返回该 .git 目录的文件标识(dev + ino),用于跨 Windows 8.3 短路径/长路径、
 * 大小写差异、符号链接等场景的可靠比对。
 *
 * 失败抛错(由调用方收敛);不修改任何缓存/远程状态。
 *
 * A04-FIX3 关键不变量:dev/ino 直接来自 `fs.statSync(path, { bigint: true })`,
 * 不得先取普通 fs.Stats 再 BigInt(number) 转换(Windows inode 可能超过
 * Number.MAX_SAFE_INTEGER,普通 stat 已丢精度)。
 */
export interface GitCommonDirId {
  /** 真实可访问的 common dir 绝对路径(用于 stat,绝不带小写化与长路径归一)。 */
  realPath: string;
  /** canonicalizeFsPath 之后的路径字符串,仅用于比较与错误信息展示。 */
  path: string;
  /** volume serial(Windows) / dev(POSIX),统一为 bigint 便于比较。 */
  dev: bigint;
  /** file index(Windows) / inode(POSIX),统一为 bigint 便于比较。 */
  ino: bigint;
}

/**
 * A04-FIX4 · 仓库身份比较规则(纯函数,可独立测试):
 *  1. 双方都有有效文件标识(dev !== 0n 且 ino !== 0n):
 *     ⇒ 仅 dev+ino 同时精确相等才视为相同;只要文件标识不同(即使
 *        canonicalizeFsPath 后的显示 path 字符串完全相同)就必须返回 false,
 *        防止同一路径已被删除 / 替换 / 重新 clone 后被误判为原仓库。
 *  2. 任意一方没有有效文件标识:
 *     ⇒ 不得用不完整 dev/ino 比较,只能退化到 canonicalizeRealPathForIdentity
 *        对 realPath 的精确字符串比较;真实路径相同 ⇒ 相同,不同 ⇒ 不同。
 *  3. canonicalizePathForCompare 产出的全小写 path 字段只用于显示与错误信息,
 *     不得作为强身份依据;reposEqualById 不再把它当一等公民。
 *
 * 注意:上一版(A04-FIX3)把"两边 0n/0n"当作"路径相同时强行同,路径不同时强行不同"
 * 的兜底分支,会被 `{dev:0n, ino:5n}` / `{dev:5n, ino:0n}` 这类"半有效"标识穿透;
 * 也会因为 display path 字段全小写化而把 `C:\Root\Repo\.git` 与 `C:\Root\repo\.git`
 * 误判为同一仓库。本版把这两类误判都关闭。
 */
export function hasValidFileId(id: GitCommonDirId): boolean {
  return id.dev !== 0n && id.ino !== 0n;
}

export function reposEqualById(a: GitCommonDirId, b: GitCommonDirId): boolean {
  const aValid = hasValidFileId(a);
  const bValid = hasValidFileId(b);
  // 1. 双方都有有效文件标识 ⇒ 仅 dev+ino 同时精确相等才视为相同
  if (aValid && bValid) {
    return a.dev === b.dev && a.ino === b.ino;
  }
  // 2. 任意一方没有有效文件标识 ⇒ 退化到保留大小写的真实路径比较
  return canonicalizeRealPathForIdentity(a.realPath) ===
    canonicalizeRealPathForIdentity(b.realPath);
}

export async function readGitCommonDir(repoDir: string): Promise<GitCommonDirId> {
  const out = await git(repoDir, ["rev-parse", "--git-common-dir"]);
  // 关键顺序:先解析真实可访问的路径,再对真实路径 stat,最后才生成用于比较的规范化字符串。
  // 反过来(先 canonicalize 再 stat)会让 lowercase 与长路径归一破坏 stat 行为。
  const realPath = resolveRealPath(path.resolve(repoDir, out.trim()));
  const stat = statBigInt(realPath);
  const comparePath = canonicalizeFsPath(realPath);
  return { realPath, path: comparePath, dev: stat.dev, ino: stat.ino };
}

/**
 * 验证 priorWorkDir 所属 Git 仓库与 issue.repo_path 一致:
 *  - 本地仓库:分别读两者的 git common directory 的身份,通过 `reposEqualById` 比较。
 *  - URL 仓库:推导 issue.repo_path 对应的本地缓存目录 <cache>/.git,与 priorWorkDir 的 common dir 比对。
 * 不得执行 fetch / merge / 任何改变状态的操作,也不得修改 target/base。
 * 不一致 → 抛错(由 executeTask 收敛为 fail)。
 */
export async function assertResumeRepository(
  priorWorkDir: string,
  issueRepoPath: string | null,
  runnerRoot: string,
): Promise<void> {
  if (!issueRepoPath) {
    throw new Error("Resume 身份校验失败:issue.repo_path 为空,无法与 priorWorkDir 比对");
  }
  let prior: GitCommonDirId;
  try {
    prior = await readGitCommonDir(priorWorkDir);
  } catch (e: any) {
    throw new Error(`Resume 身份校验失败:priorWorkDir 不是有效 Git 仓库(${priorWorkDir}): ${e?.message ?? e}`);
  }
  let expected: GitCommonDirId;
  if (isRepoUrl(issueRepoPath)) {
    const cacheDir = repoCachePath(issueRepoPath, runnerRoot);
    // URL 缓存目录先 resolveRealPath,得到真实路径(可能还未存在则回退到绝对路径)
    const realCacheGit = resolveRealPath(path.join(cacheDir, ".git"));
    const stat = statBigInt(realCacheGit);
    expected = { realPath: realCacheGit, path: canonicalizeFsPath(realCacheGit), dev: stat.dev, ino: stat.ino };
  } else {
    try {
      expected = await readGitCommonDir(issueRepoPath);
    } catch (e: any) {
      throw new Error(`Resume 身份校验失败:issue.repo_path 不是有效 Git 仓库(${issueRepoPath}): ${e?.message ?? e}`);
    }
  }
  // 通过 reposEqualById 综合路径与 dev/ino 判定同仓库
  if (!reposEqualById(prior, expected)) {
    throw new Error(
      `Resume 仓库与 Issue repo_path 不一致:priorWorkDir=${priorWorkDir} 属于 ${prior.path} (dev=${prior.dev},ino=${prior.ino}),` +
      `而 issue.repo_path=${issueRepoPath} 指向 ${expected.path} (dev=${expected.dev},ino=${expected.ino})`,
    );
  }
}

/** 读当前分支(简写)。detached HEAD 返回 "HEAD";调用方必须把 "HEAD" 视为失败。 */
export async function readAbbrevBranch(repoDir: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

/** 把 SHA 字符串严格校验为完整 40 位 hex,非 40 位一律抛错(防短 SHA / 缩写)。 */
export function assertFullSha1(field: string, value: string): string {
  if (!SHA1_40.test(value)) {
    throw new Error(`${field} 不是完整 40 位 hex SHA-1: ${value}`);
  }
  return value.toLowerCase();
}

/** 读取某 ref 的完整 40 位 SHA-1(用 `git rev-parse <ref>`),失败或非 40 位 → 抛错。 */
export async function readFullShaOfRef(repoDir: string, ref: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--verify", ref]);
  return assertFullSha1(`ref ${ref}`, out);
}

/**
 * A04-FIX1 · 读取并验证当前 worktree HEAD:完成阶段先确认分支身份,再读完整 40 位 SHA。
 *
 * 关键不变量(代替旧版仅 `git rev-parse HEAD` 的实现):
 *  1. detached HEAD 必须明确失败,不得把"HEAD"当作合法分支;
 *  2. 若 `expectedTaskBranch` 非空,当前分支必须与之一致(防止 Agent 切换到其他分支后仍上报 complete);
 *  3. 只有分支身份通过后,才读 HEAD SHA 并校验完整 40 位 hex;
 *  4. 任何失败都抛 Error(由 executeTask 的 catch 收敛为 fail 路径,不会进入 complete)。
 *
 * 注意:不得用 `prepared.taskBranch` 对应 ref 的 SHA 代替工作树当前 HEAD —— 必须同时
 * 验证"工作树实际所在分支"和"工作树实际 HEAD SHA",避免 ref 解算绕过工作树被切换的现场。
 */
export async function readWorktreeHead(workDir: string, expectedTaskBranch?: string | null): Promise<string> {
  // 1. 先读当前明确分支,detached HEAD 立即失败
  const abbrev = await git(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = abbrev.trim();
  if (!branch || branch === "HEAD") {
    throw new Error(`worktree 处于 detached HEAD,无法读取交付 HEAD(${workDir})`);
  }
  // 2. 若传入了期望分支,必须一致(防止 Agent 切换到其他分支后上报)
  if (expectedTaskBranch != null && expectedTaskBranch !== "" && branch !== expectedTaskBranch) {
    throw new Error(`worktree 当前分支 ${branch} 与 prepared.taskBranch ${expectedTaskBranch} 不一致,放弃 complete`);
  }
  // 3. 分支身份确认后再读完整 40 位 SHA
  const out = await git(workDir, ["rev-parse", "HEAD"]);
  return assertFullSha1("worktree HEAD", out);
}

export interface PreparedWorkdir {
  workDir: string;
  /** 任务分支(形如 task/<shortId>);无 repo_path 时为 null。 */
  taskBranch: string | null;
  /** 目标分支(本地或缓存仓库当前明确分支);无 repo_path 或 detached 时为 null。 */
  targetBranch: string | null;
  /** 完整 40 位 hex baseCommit;无 repo_path 时为 null。 */
  baseCommit: string | null;
  /** true = 复用 priorWorkDir(续跑);false = 新建 worktree。 */
  resumed: boolean;
}

/** 已保存锚点(从 pkg.task 派生):用于 resume 校验。targetBranch/baseCommit 必须存在
 *  才能合法 resume;若缺失,prepareWorkdir 不得猜测,会明确失败。 */
export interface SavedAnchors {
  taskBranch: string | null;
  targetBranch: string | null;
  baseCommit: string | null;
}

async function resolveLocalRepoAnchors(repoPath: string): Promise<{ targetBranch: string; baseCommit: string }> {
  // 1. 明确读出当前分支,detached HEAD 立即失败(不能把 "HEAD" 当 targetBranch)
  const abbrev = await readAbbrevBranch(repoPath);
  if (!abbrev || abbrev === "HEAD") {
    throw new Error(`本地仓库 detached HEAD,无法固化目标分支(${repoPath})`);
  }
  // 2. 读出该分支的完整 40 位 SHA;非 40 位(短 SHA)立即失败
  const sha = await readFullShaOfRef(repoPath, abbrev);
  return { targetBranch: abbrev, baseCommit: sha };
}

async function resolveUrlRepoAnchors(cacheDir: string): Promise<{ targetBranch: string; baseCommit: string }> {
  // 缓存仓库的默认分支 = clone 下来后的当前分支。detached 同样失败。
  const abbrev = await readAbbrevBranch(cacheDir);
  if (!abbrev || abbrev === "HEAD") {
    throw new Error(`URL 缓存仓库 detached HEAD,无法固化目标分支(${cacheDir})`);
  }
  const sha = await readFullShaOfRef(cacheDir, abbrev);
  return { targetBranch: abbrev, baseCommit: sha };
}

/** A04 · 备工作区:Git 任务返回 taskBranch/targetBranch/baseCommit + resumed;
 *  普通目录任务三锚点全 null。detached HEAD、缺失锚点、非法 SHA 一律明确失败。
 *
 *  A04-FIX1 · A:无 repo_path + prior_work_dir 存在 → 直接复用目录,三锚点全 null,
 *  不要求 SavedAnchors,不伪造 Git 锚点,不因目录不是 Git 仓库而失败。
 *
 *  A04-FIX2 · 状态矩阵:
 *   A. Initial/Fresh 合法:priorWorkDir==null 且 savedAnchors 三项全 null → 全新 worktree。
 *   B. Resume 合法:priorWorkDir 非空 + 目录存在 + savedAnchors 三项齐全合法 +
 *      仓库身份一致 + worktree 分支 === saved taskBranch → resumed=true。
 *   C. 非法矛盾(任何一条不满足,执行任何 git worktree add / Start 之前明确抛错):
 *      C1. priorWorkDir 非空但目录不存在;
 *      C2. priorWorkDir 非空但 savedAnchors 缺任意一项(null/undefined);
 *      C3. priorWorkDir 为空但 savedAnchors 任意一项"已提供"(包括空字符串);
 *      C4. savedAnchors 部分"已提供"(只传 1~2 项,空字符串也算已提供);
 *      C5. priorWorkDir 所属仓库与 issue.repo_path 不一致;
 *      C6. saved taskBranch 与实际 worktree 分支不一致;
 *      C7. saved baseCommit 非完整 40 位 hex;
 *      C8. saved taskBranch/targetBranch 是空字符串或纯空白。
 *   D. 无 repo_path 普通目录:priorWorkDir 复用 + 不要求 Git 锚点;
 *      若 Task 携带任何 saved Git anchor(含空字符串)→ 明确失败(不得忽略异常锚点)。
 *
 *  A04-FIX3 · 空字符串/纯空白严格化:
 *   - hasAnySavedAnchor / areAllAnchorsPresent 严格按 null/undefined 判断,
 *     空字符串视为"已提供但非法",后续会被 C3/C4/C7/C8 拦截。
 *   - 任何 anchor 是空字符串或纯空白字符串,执行任何 git worktree add / Start 之前明确失败。 */
export async function prepareWorkdir(
  issue: Issue,
  taskId: string,
  runnerRoot: string,
  priorWorkDir: string | null,
  savedAnchors: SavedAnchors | null = null,
  repositorySnapshot: RepositorySnapshot | null = null,
): Promise<PreparedWorkdir> {
  await ensureGitAvailable();
  if (repositorySnapshot) {
    return createBoundGitWorkdir(repositorySnapshot, taskId, runnerRoot, priorWorkDir, savedAnchors);
  }
  // 第一次决定 workDir 来源(复用 vs 新建)
  const short = taskId.slice(0, 8);
  const base = path.join(runnerRoot, "worktrees");
  fs.mkdirSync(base, { recursive: true });
  const freshDir = path.join(base, short);
  const freshTaskBranch = `task/${short}`;

  // A04-FIX2 · D:无 repo_path 普通目录任务 —— 守卫:Task 不得携带任何 saved Git anchor
  if (!issue.repo_path) {
    if (hasAnySavedAnchor(savedAnchors)) {
      throw new Error(
        "无 repo_path 普通目录任务不应携带 saved Git 锚点" +
        ` (taskBranch=${savedAnchors?.taskBranch ?? "null"},` +
        ` targetBranch=${savedAnchors?.targetBranch ?? "null"},` +
        ` baseCommit=${savedAnchors?.baseCommit ?? "null"}),` +
        "请检查 Issue 配置或清空 Task 上的异常 Git 锚点",
      );
    }
    if (priorWorkDir && fs.existsSync(priorWorkDir)) {
      return { workDir: priorWorkDir, taskBranch: null, targetBranch: null, baseCommit: null, resumed: true };
    }
    // 首次普通目录任务:创建空目录,不伪造 Git 锚点
    fs.mkdirSync(freshDir, { recursive: true });
    return { workDir: freshDir, taskBranch: null, targetBranch: null, baseCommit: null, resumed: false };
  }

  // ====================================================================
  // A04-FIX2 · Git 仓库任务状态矩阵
  // ====================================================================
  const allAnchorsPresent = areAllAnchorsPresent(savedAnchors);
  const noAnchors = !hasAnySavedAnchor(savedAnchors);

  // C3 / C4 · priorWorkDir 为空但存在 saved anchor(部分或全) → 非法
  if (!priorWorkDir) {
    if (!noAnchors) {
      throw new Error(
        "非法状态:priorWorkDir 为空但 Task 存在 saved Git 锚点" +
        ` (taskBranch=${savedAnchors?.taskBranch ?? "null"},` +
        ` targetBranch=${savedAnchors?.targetBranch ?? "null"},` +
        ` baseCommit=${savedAnchors?.baseCommit ?? "null"}),` +
        "不得静默创建新 task/<id> 分支覆盖已保存锚点",
      );
    }
    // A · Initial/Fresh 合法状态
    return await createFreshGitWorkdir(issue, freshTaskBranch, freshDir, runnerRoot);
  }

  // priorWorkDir 非空 —— 进入 Resume 校验路径
  // C1 · priorWorkDir 非空但目录不存在 → 非法
  if (!fs.existsSync(priorWorkDir)) {
    throw new Error(
      `Resume worktree 不存在:priorWorkDir=${priorWorkDir}(目录已删除或路径错误),` +
      "不得静默创建新 worktree 覆盖已保存锚点",
    );
  }

  // C2 / C4 · prior 非空但 savedAnchors 不齐全(部分或全缺) → 非法
  if (!allAnchorsPresent) {
    throw new Error(
      "Resume 缺少完整的 saved Git 锚点" +
      ` (taskBranch=${savedAnchors?.taskBranch ?? "null"},` +
      ` targetBranch=${savedAnchors?.targetBranch ?? "null"},` +
      ` baseCommit=${savedAnchors?.baseCommit ?? "null"}),` +
      "不得从目标分支 HEAD 重新猜测 base",
    );
  }

  // 此时 savedAnchors 三项"均已提供"(非 null/undefined),做格式校验。
  // 注意:空字符串在这里被视作非法值,不会因为 allAnchorsPresent=true 而跳过校验。
  // C8 · taskBranch/targetBranch 不得为空字符串或纯空白字符串
  if (!savedAnchors!.taskBranch!.trim() || !savedAnchors!.targetBranch!.trim()) {
    throw new Error(
      "Resume saved Git 锚点含空字符串或纯空白" +
      ` (taskBranch=${JSON.stringify(savedAnchors!.taskBranch)},` +
      ` targetBranch=${JSON.stringify(savedAnchors!.targetBranch)},` +
      ` baseCommit=${JSON.stringify(savedAnchors!.baseCommit)})`,
    );
  }
  // C7 · baseCommit 必须为完整 40 位 hex(空字符串在此被严格拒绝)
  assertFullSha1("saved baseCommit", savedAnchors!.baseCommit!);

  // C5 · 仓库身份校验:priorWorkDir 与 issue.repo_path 必须指向同一 Git common dir
  await assertResumeRepository(priorWorkDir, issue.repo_path, runnerRoot);

  // 读 worktree 实际分支;detached HEAD 必须失败
  let actualBranch: string;
  try {
    actualBranch = await readAbbrevBranch(priorWorkDir);
  } catch {
    throw new Error(`Resume 读取 worktree 分支失败(${priorWorkDir})`);
  }
  if (!actualBranch || actualBranch === "HEAD") {
    throw new Error(`Resume worktree 处于 detached HEAD,无法继续(${priorWorkDir})`);
  }

  // C6 · saved taskBranch 与实际 worktree 分支必须一致
  if (savedAnchors!.taskBranch !== actualBranch) {
    throw new Error(
      `Resume worktree 实际分支 ${actualBranch} 与 Task 已存 task_branch ${savedAnchors!.taskBranch} 不一致,` +
      "不得用当前分支覆盖已保存锚点",
    );
  }

  // B · Resume 合法状态
  return {
    workDir: priorWorkDir,
    taskBranch: actualBranch,
    targetBranch: savedAnchors!.targetBranch!,
    baseCommit: savedAnchors!.baseCommit!.toLowerCase(),
    resumed: true,
  };
}

/** A04-FIX3 · 单字段"已提供"判定:严格按 null/undefined,空字符串视为已提供但非法。 */
export function isAnchorProvided(value: string | null | undefined): boolean {
  return value !== null && value !== undefined;
}

/** savedAnchors 任一项不是 null/undefined 视为"已提供"——用于 C3 / C4 / D 守卫。
 *  注意:空字符串也算"已提供",后续 prepareWorkdir 会按格式校验拒绝。 */
export function hasAnySavedAnchor(a: SavedAnchors | null | undefined): boolean {
  if (!a) return false;
  return isAnchorProvided(a.taskBranch) || isAnchorProvided(a.targetBranch) || isAnchorProvided(a.baseCommit);
}

/** savedAnchors 三项都不是 null/undefined 视为"齐全"——用于 B / C2 校验。
 *  "齐全"只表示字段存在,不代表合法,后续还要继续做 trim / 40 位 SHA / 仓库身份 / 分支校验。 */
export function areAllAnchorsPresent(a: SavedAnchors | null | undefined): boolean {
  if (!a) return false;
  return isAnchorProvided(a.taskBranch) && isAnchorProvided(a.targetBranch) && isAnchorProvided(a.baseCommit);
}

/** A · 全新 Git worktree:从当前 issue.repo_path 拉默认分支 + baseCommit,创建 task/<shortId>。 */
async function createFreshGitWorkdir(
  issue: Issue,
  taskBranch: string,
  freshDir: string,
  runnerRoot: string,
): Promise<PreparedWorkdir> {
  // prepareWorkdir 入口已校验 issue.repo_path 非 null,这里一定有值
  const repoPath = issue.repo_path!;
  if (isRepoUrl(repoPath)) {
    const cacheDir = await ensureRepoCache(repoPath, runnerRoot);
    const { targetBranch, baseCommit } = await resolveUrlRepoAnchors(cacheDir);
    // worktree 必须从已固化的 baseCommit 创建,不在多个命令之间重新读取浮动的 HEAD
    await git(cacheDir, ["worktree", "add", "-b", taskBranch, freshDir, baseCommit]);
    return { workDir: freshDir, taskBranch, targetBranch, baseCommit, resumed: false };
  }
  const { targetBranch, baseCommit } = await resolveLocalRepoAnchors(repoPath);
  await git(repoPath, ["worktree", "add", "-b", taskBranch, freshDir, baseCommit]);
  return { workDir: freshDir, taskBranch, targetBranch, baseCommit, resumed: false };
}

/** 绑定任务只从冻结仓库及明确目标创建新工作树；锁不跨 Agent 执行或终检。 */
async function createBoundGitWorkdir(
  snapshot: RepositorySnapshot,
  taskId: string,
  runnerRoot: string,
  priorWorkDir: string | null,
  savedAnchors: SavedAnchors | null,
): Promise<PreparedWorkdir> {
  if (priorWorkDir !== null || hasAnySavedAnchor(savedAnchors)) {
    throw new Error("绑定任务必须使用新工作树，不能继承 prior_work_dir 或旧 Git 锚点");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) throw new Error("绑定任务 ID 不能安全用于工作树和分支名");
  if (!snapshot.identity.real_path || typeof snapshot.identity.dev !== "string" || typeof snapshot.identity.ino !== "string"
    || !/^\d+$/.test(snapshot.identity.dev) || !/^\d+$/.test(snapshot.identity.ino)) {
    throw new Error("仓库身份必须包含真实路径与无损十进制文件标识");
  }
  const expected: GitCommonDirId = {
    realPath: snapshot.identity.real_path,
    path: canonicalizePathForCompare(snapshot.identity.real_path),
    dev: BigInt(snapshot.identity.dev), ino: BigInt(snapshot.identity.ino),
  };
  const checkout = snapshot.checkout_path;
  const initial = await readGitCommonDir(checkout);
  const assertIdentity = (actual: GitCommonDirId) => {
    if (!reposEqualById(actual, expected) || !reposEqualById(actual, initial)) {
      throw new Error("绑定仓库身份与 Task 原始快照不一致，禁止创建工作树");
    }
  };
  assertIdentity(initial);
  return withGitLock(initial.realPath, async () => {
    // 获取锁期间 checkout 可能被替换；任何 fetch/worktree add 前再次读取文件标识。
    assertIdentity(await readGitCommonDir(checkout));
    await git(checkout, ["check-ref-format", `refs/heads/${snapshot.target_branch}`]);
    if (snapshot.mode === "github_pr") {
      const normalized = (address: string) => address.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase();
      // 绑定阶段已以 API 稳定 ID 核对 checkout；改名后 origin 可以仍是旧地址。
      // 始终使用冻结的明确地址，既不依赖也不修改 origin。
      const effective = await git(checkout, ["ls-remote", "--get-url", snapshot.clone_url]);
      if (normalized(effective) !== normalized(snapshot.clone_url)) throw new Error("Git URL 重写与原始绑定不一致");
      await git(checkout, ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "--no-tags", "--", snapshot.clone_url, `+refs/heads/${snapshot.target_branch}:refs/remotes/origin/${snapshot.target_branch}`]);
      assertIdentity(await readGitCommonDir(checkout));
    }
    const targetRef = snapshot.mode === "github_pr" ? `refs/remotes/origin/${snapshot.target_branch}` : `refs/heads/${snapshot.target_branch}`;
    const baseCommit = await readFullShaOfRef(checkout, targetRef);
    const taskBranch = `task/${taskId}`;
    const freshDir = path.join(runnerRoot, "worktrees", taskId);
    fs.mkdirSync(path.dirname(freshDir), { recursive: true });
    assertIdentity(await readGitCommonDir(checkout));
    const startingCommit = snapshot.starting_commit ?? baseCommit;
    assertFullSha1("starting_commit", startingCommit);
    await git(checkout, ["cat-file", "-e", `${startingCommit}^{commit}`]);
    await git(checkout, ["worktree", "add", "-b", taskBranch, freshDir, startingCommit]);
    assertIdentity(await readGitCommonDir(freshDir));
    if (await readWorktreeHead(freshDir, taskBranch) !== startingCommit) throw new Error("新工作树 HEAD 与冻结起点不一致");
    return { workDir: freshDir, taskBranch, targetBranch: snapshot.target_branch, baseCommit, resumed: false };
  });
}

/** A04 · 固定 base..head diff 范围。
 *  baseCommit / headCommit 必须为完整 40 位 hex;命令失败 / 非 40 位 SHA → 直接抛错,
 *  由 executeTask 异常收敛路径处理(不伪装成合法空 diff)。无 repo_path 任务不应调用本函数。 */
export async function gitDiffStat(workDir: string, baseCommit: string, headCommit: string): Promise<string> {
  assertFullSha1("baseCommit", baseCommit);
  assertFullSha1("headCommit", headCommit);
  return await git(workDir, ["diff", "--stat", `${baseCommit}..${headCommit}`]);
}
