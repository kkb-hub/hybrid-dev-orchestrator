// GitClient: a thin, typed wrapper over `git` built on top of ProcessRunner (never a
// shell string). Mirrors the subset of Git.ps1 needed by this PoC: rev-parse HEAD,
// worktree add/list/remove, and the tracked+untracked diff building blocks.
import { statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { ProcessRunner } from "../core/process/types.ts";
import type { PlatformAdapter } from "../platform/types.ts";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

export interface GitClientOptions {
  runner: ProcessRunner;
  platform: PlatformAdapter;
  gitExecutable?: string;
  timeoutSeconds?: number;
}

export class GitClient {
  private readonly runner: ProcessRunner;
  private readonly platform: PlatformAdapter;
  private readonly gitExecutable: string;
  private readonly timeoutSeconds: number;

  constructor(options: GitClientOptions) {
    this.runner = options.runner;
    this.platform = options.platform;
    this.gitExecutable = options.gitExecutable ?? "git";
    this.timeoutSeconds = options.timeoutSeconds ?? 120;
  }

  private async exec(args: string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.runner.run({
      command: this.gitExecutable,
      args,
      cwd,
      timeoutSeconds: this.timeoutSeconds,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  private async execOrThrow(args: string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.exec(args, cwd);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return result;
  }

  async revParseHead(repositoryPath: string, ref = "HEAD"): Promise<string> {
    const result = await this.execOrThrow(["rev-parse", "--verify", `${ref}^{commit}`], repositoryPath);
    return result.stdout.trim();
  }

  async worktreeAdd(repositoryPath: string, worktreePath: string, branch: string, commit: string): Promise<void> {
    await this.execOrThrow(["worktree", "add", "-b", branch, worktreePath, commit], repositoryPath);
  }

  async worktreeList(repositoryPath: string): Promise<WorktreeEntry[]> {
    const result = await this.execOrThrow(["worktree", "list", "--porcelain"], repositoryPath);
    return parseWorktreePorcelain(result.stdout);
  }

  async worktreeRemove(repositoryPath: string, worktreePath: string, force: boolean): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    await this.execOrThrow(args, repositoryPath);
  }

  async lsFilesOthers(worktreePath: string): Promise<string[]> {
    const result = await this.execOrThrow(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath);
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
  }

  async diffBinary(worktreePath: string, base: string): Promise<string> {
    const result = await this.execOrThrow(["diff", "--binary", "--no-ext-diff", base, "--"], worktreePath);
    return result.stdout;
  }

  /**
   * True only if `worktreePath` is under `root` AND Git itself lists it as a worktree
   * of `repositoryPath` - mirroring the two independent checks `Remove-HdoRunWorktree`
   * performs before allowing cleanup (configured-root containment, then Git's own
   * bookkeeping) rather than trusting either alone.
   */
  async isContainedWorktree(repositoryPath: string, worktreePath: string, root: string): Promise<boolean> {
    if (!this.isPathWithinRoot(worktreePath, root)) return false;
    const worktrees = await this.worktreeList(repositoryPath);
    return worktrees.some((entry) => this.worktreePathEquals(entry.path, worktreePath));
  }

  /**
   * Compare a path reported by `git worktree list --porcelain` with a caller-supplied
   * path. Both go through `comparableFullPath` first: on Windows, `%TEMP%` (and therefore
   * `os.tmpdir()`) may be an 8.3 short name such as `C:\Users\RUNNER~1\...` while Git
   * reports the long form `C:/Users/runneradmin/...` (observed on GitHub-hosted
   * windows-latest runners). Plain string comparison fails there; `realpathSync.native`
   * expands the short name via the Win32 final path, mirroring
   * `Get-HdoComparableFullPath` (`Git.ps1`) which HDO uses for the same reason.
   */
  worktreePathEquals(gitReportedPath: string, candidate: string): boolean {
    return this.platform.pathEquals(
      comparableFullPath(this.platform, gitReportedPath),
      comparableFullPath(this.platform, candidate),
    );
  }

  private isPathWithinRoot(candidate: string, root: string): boolean {
    return isPathWithinRoot(this.platform, candidate, root);
  }
}

/**
 * F-03: `path.resolve()` collapses `..` segments algebraically before anything else
 * runs, so `<root>/a/../../evil` can no longer masquerade as a string that merely
 * *starts with* `<root>` while a naive prefix check is fooled by the literal `..`
 * text (the original bug: a candidate that does not exist made `realpath` fail, and
 * the un-resolved `..`-laden string was then compared as-is). On top of that,
 * `comparableFullPath` mirrors `Get-HdoComparableFullPath`: it walks up to the
 * nearest *existing* ancestor, resolves that ancestor through `platform.realPath`
 * (so a symlinked root or an intermediate symlink cannot desync the comparison), and
 * re-appends the non-existent tail unresolved. Unlike the PowerShell version - which
 * only does this ancestor/realpath dance on Windows (packaged-app LocalAppData
 * redirection) and just normalizes on POSIX - this PoC applies it on both platforms,
 * since resolving symlinks before the containment check is exactly what closes the
 * symlink-escape variant of this bug everywhere.
 *
 * A candidate equal to `root` itself returns false, matching
 * `Test-HdoPathWithinRoot`'s `StartsWith(root + separator)` semantics (which requires
 * a strict, separator-delimited descendant, not equality).
 *
 * Exported standalone (not just via `GitClient`) so it can be unit tested directly;
 * see git/index.test.ts.
 */
export function isPathWithinRoot(platform: PlatformAdapter, candidate: string, root: string): boolean {
  const resolvedCandidate = comparableFullPath(platform, candidate);
  const resolvedRoot = comparableFullPath(platform, root);
  // H-03: for an ordinary root, a candidate equal to root already fails the
  // separator-prefixed `startsWith` check below. But when `root` is itself a
  // filesystem root (`C:\`, `/`), `comparableFullPath` leaves it separator-terminated
  // (G-04), so `prefix` below equals `resolvedRoot` verbatim and a candidate equal to
  // that same root would otherwise satisfy `startsWith(prefix)` - contradicting the
  // "equality is never containment" contract documented below. Reject equality
  // up front so it holds for every root, filesystem-root or not.
  const rootsAreEqual =
    platform.name === "windows"
      ? resolvedCandidate.toLowerCase() === resolvedRoot.toLowerCase()
      : resolvedCandidate === resolvedRoot;
  if (rootsAreEqual) return false;
  const boundary = platform.name === "windows" ? "\\" : "/";
  // G-04: a root that is itself a filesystem root (`C:\`, `/`) is already
  // separator-terminated after `comparableFullPath`/`normalizeNoTrailingSep` (which
  // now leaves roots alone instead of collapsing them to a drive-relative path). Do
  // not append a second separator in that case, or the prefix ("C:\\", "//") would
  // never match any real path.
  const prefix = resolvedRoot.endsWith(boundary) ? resolvedRoot : `${resolvedRoot}${boundary}`;
  if (platform.name === "windows") {
    return resolvedCandidate.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolvedCandidate.startsWith(prefix);
}

/**
 * Resolve `rawPath` to an absolute, `..`-collapsed path, then canonicalize the
 * deepest *existing* ancestor via `platform.realPath` and re-append any non-existent
 * tail segments unresolved. Exported for direct unit testing (see git/index.test.ts).
 */
export function comparableFullPath(platform: PlatformAdapter, rawPath: string): string {
  const full = normalizeNoTrailingSep(resolve(rawPath));

  const missingSegments: string[] = [];
  let existing = full;
  while (!pathExists(existing)) {
    const leaf = basename(existing);
    const parent = dirname(existing);
    if (!leaf || parent === existing) break;
    missingSegments.unshift(leaf);
    existing = parent;
  }
  if (!pathExists(existing)) return full;

  let resolvedExisting: string;
  try {
    resolvedExisting = platform.realPath(existing);
  } catch {
    return full;
  }
  let result = resolvedExisting;
  for (const segment of missingSegments) result = join(result, segment);
  return normalizeNoTrailingSep(result);
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * G-04: a filesystem root (`C:\`, `/`) must be left as-is - stripping its trailing
 * separator turns `C:\` into the drive-*relative* path `C:`, which Node resolves
 * against `process.cwd()`'s current drive instead of the drive root, silently
 * widening any containment check that uses this as `root`. `path.parse(p).root === p`
 * is true only for an actual root (POSIX `/`, or a Windows drive/UNC root), never for
 * an ordinary directory whose path happens to end in a separator, so this guard does
 * not change behaviour for any other input.
 */
function normalizeNoTrailingSep(p: string): string {
  if (parse(p).root === p) return p;
  return p.length > sep.length && p.endsWith(sep) ? p.slice(0, -sep.length) : p;
}

function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine === "") {
      if (current?.path) {
        entries.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
          bare: current.bare ?? false,
          detached: current.detached ?? false,
        });
      }
      current = null;
      continue;
    }
    if (!current) current = {};
    if (rawLine.startsWith("worktree ")) current.path = rawLine.slice("worktree ".length);
    else if (rawLine.startsWith("HEAD ")) current.head = rawLine.slice("HEAD ".length);
    else if (rawLine.startsWith("branch ")) current.branch = rawLine.slice("branch ".length);
    else if (rawLine === "bare") current.bare = true;
    else if (rawLine === "detached") current.detached = true;
  }
  if (current?.path) {
    entries.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
  }
  return entries;
}
