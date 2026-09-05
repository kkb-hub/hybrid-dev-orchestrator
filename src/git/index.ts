// GitClient: a thin, typed wrapper over `git`, running every invocation through a
// `ProcessRunner` (never a shell string) - mirrors the "no shell string" runtime
// convention `Invoke-HdoGit` (Git.ps1) already follows via `Invoke-HdoProcess`.
//
// Phase 2 (ADR-0001 Migration strategy) additions on top of phase 1's read-only
// rev-parse/show wrapper: `worktreeAdd`/`worktreeList`/`worktreeRemove`/
// `worktreePrune`, brought forward from phase 3 to close Issue #25 (Windows
// long-path worktree cleanup) alongside the rest of process/platform. On Windows,
// EVERY git invocation gets `-c core.longpaths=true` prepended (a parallel
// PowerShell PR does the same in `Invoke-HdoGit`).
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ProcessRunner } from "../core/process/types.ts";
import type { PlatformAdapter } from "../platform/types.ts";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitClientOptions {
  runner: ProcessRunner;
  platform: PlatformAdapter;
  gitExecutable?: string;
  /** Seconds. Default 120, matching `Invoke-HdoGit -TimeoutSeconds` (Git.ps1). */
  timeoutSeconds?: number;
  /** Seconds. Default 300, matching `New-HdoWorktree`/`Remove-HdoRunWorktree`'s `-TimeoutSeconds 300` for worktree add/remove. */
  worktreeTimeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_WORKTREE_TIMEOUT_SECONDS = 300;

/**
 * Mirrors `Invoke-HdoProcess -ThrowOnError`'s throw text (Common.ps1) exactly:
 * `Command '<command>' failed with exit code <code>. <detail>`, where `<detail>` is
 * trimmed stderr, falling back to trimmed stdout when stderr is empty.
 */
export function formatProcessFailure(command: string, exitCode: number, stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return `Command '${command}' failed with exit code ${exitCode}. ${detail}`;
}

export interface WorktreeAddOptions {
  branch: string;
  worktreePath: string;
  baseCommit: string;
}

export interface WorktreeRemoveOptions {
  force?: boolean;
}

function parseWorktreeListPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.startsWith("worktree ")) paths.push(rawLine.slice("worktree ".length));
  }
  return paths;
}

export class GitClient {
  private readonly runner: ProcessRunner;
  private readonly platform: PlatformAdapter;
  private readonly gitExecutable: string;
  private readonly timeoutSeconds: number;
  private readonly worktreeTimeoutSeconds: number;

  constructor(options: GitClientOptions) {
    this.runner = options.runner;
    this.platform = options.platform;
    this.gitExecutable = options.gitExecutable ?? "git";
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.worktreeTimeoutSeconds = options.worktreeTimeoutSeconds ?? DEFAULT_WORKTREE_TIMEOUT_SECONDS;
  }

  /**
   * Runs `git <args>` in `cwd` and always resolves (never rejects) with the exit
   * code and captured output - `NodeProcessRunner.run` itself only throws when the
   * `git` executable cannot be resolved at all or fails to start, neither of which
   * this method catches, matching phase 1's contract of "callers inspect exitCode"
   * for every other kind of git failure.
   */
  async exec(args: string[], cwd: string, timeoutSeconds: number = this.timeoutSeconds): Promise<GitCommandResult> {
    const finalArgs = this.platform.name === "windows" ? ["-c", "core.longpaths=true", ...args] : args;
    const result = await this.runner.run({
      command: this.gitExecutable,
      arguments: finalArgs,
      workingDirectory: cwd,
      timeoutSeconds,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  /** `git rev-parse --verify <ref>` - never throws; callers inspect `exitCode`. */
  async revParseVerify(repositoryPath: string, ref: string): Promise<GitCommandResult> {
    return this.exec(["rev-parse", "--verify", ref], repositoryPath);
  }

  /** `git show <object>` - never throws; callers inspect `exitCode`. */
  async show(repositoryPath: string, objectName: string): Promise<GitCommandResult> {
    return this.exec(["show", objectName], repositoryPath);
  }

  /**
   * Mirrors `Get-HdoRepositoryRoot` (Git.ps1): `git rev-parse --show-toplevel`,
   * throwing on failure, then normalizing the result to a native full path
   * (`[System.IO.Path]::GetFullPath`) so forward slashes Git may emit on Windows
   * become the platform's native separator.
   */
  async repositoryRoot(path: string): Promise<string> {
    const result = await this.exec(["rev-parse", "--show-toplevel"], path);
    if (result.exitCode !== 0) {
      // Invoke-HdoGit always passes the literal command name 'git' to
      // Invoke-HdoProcess, regardless of the resolved executable path - so the
      // message text does too, not `this.gitExecutable` (which may be overridden
      // for tests).
      throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
    }
    return resolvePath(result.stdout.trim());
  }

  /** `git worktree add -b <branch> <worktreePath> <baseCommit>`. Throws on failure. */
  async worktreeAdd(repositoryPath: string, options: WorktreeAddOptions): Promise<void> {
    const result = await this.exec(
      ["worktree", "add", "-b", options.branch, options.worktreePath, options.baseCommit],
      repositoryPath,
      this.worktreeTimeoutSeconds,
    );
    if (result.exitCode !== 0) {
      throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
    }
  }

  /** `git worktree list --porcelain`, parsed down to just the `worktree <path>` lines. Throws on failure. */
  async worktreeList(repositoryPath: string): Promise<string[]> {
    const result = await this.exec(["worktree", "list", "--porcelain"], repositoryPath);
    if (result.exitCode !== 0) {
      throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
    }
    return parseWorktreeListPaths(result.stdout);
  }

  /**
   * `git worktree remove [--force] <worktreePath>`. Mirrors `Remove-HdoRunWorktree`
   * (Git.ps1) exactly for the "git refused/failed" shape, MINUS its orphan-recovery
   * branch (`Test-HdoOrphanedWorktree` + `-Force`, for a worktree whose admin entry is
   * ALREADY gone before this method is ever called) - that belongs to a future
   * `cleanup` command (phase 3+), not here.
   *
   * NB-1: the target must be listed by `git worktree list --porcelain` BEFORE the
   * removal is attempted (compared via `platform.comparableFullPath`/`pathEquals`,
   * since git may print forward slashes or an 8.3 short name); otherwise this throws
   * `Refusing cleanup because Git does not list the target as a worktree: <path>` -
   * the same guard `Remove-HdoRunWorktree` applies - and touches nothing. Without
   * that pre-check, any directory git rejects with "is not a working tree" (an
   * unrelated directory, a worktree of ANOTHER repository, a nonexistent path) would
   * by definition be "not listed" after the failure and the fallback below would
   * delete it.
   *
   * On a non-zero exit code, this does NOT assume the fallback applies: it re-runs
   * `git worktree list --porcelain` and compares against the resolved worktree path.
   *
   * - Still listed (git genuinely refused - dirty tree without `--force`, a locked
   *   worktree, submodules, ...): throws the ORIGINAL git failure unchanged. Nothing
   *   on disk is touched.
   * - No longer listed (observed on this machine: with NO `core.longpaths` set
   *   anywhere, `git worktree remove --force` on a sufficiently deep path fails with
   *   "Filename too long", exit 255, AFTER already deleting the worktree's admin entry
   *   (`.git/worktrees/<id>`), gitfile and tracked files - only the undeletable subtree
   *   remains and `git worktree list` no longer shows it. `exec`'s `-c
   *   core.longpaths=true` fixes this in the common case, but a GLOBAL or system git
   *   config FILE setting `core.longpaths=false` is cached by Git while it reads
   *   config files and wins over a later `-c` flag, so the same failure shape can
   *   still occur on a machine configured that way; `core.longpaths` only ever
   *   affects Git's own object database/index paths in any case, never every Win32
   *   file API call `remove` makes internally): falls back to `platform.removeTree`
   *   (long-path-safe `fs.rm`) followed by `git worktree prune` to clear Git's own
   *   bookkeeping. If the directory still exists even after that, throws the ORIGINAL
   *   git failure (not a new error about the fallback) with a suffix describing what
   *   the fallback did, matching PowerShell's `$gitFailure + $suffix` / bare
   *   fallback-failure text.
   */
  async worktreeRemove(repositoryPath: string, worktreePath: string, options: WorktreeRemoveOptions = {}): Promise<void> {
    const resolvedWorktreePath = resolvePath(repositoryPath, worktreePath);
    const targetComparable = this.platform.comparableFullPath(resolvedWorktreePath);
    const isListed = async (): Promise<boolean> => {
      const listed = await this.worktreeList(repositoryPath);
      return listed.some((entry) => this.platform.pathEquals(this.platform.comparableFullPath(entry), targetComparable));
    };
    if (!(await isListed())) {
      throw new Error(`Refusing cleanup because Git does not list the target as a worktree: ${resolvedWorktreePath}`);
    }

    const args = ["worktree", "remove"];
    if (options.force) args.push("--force");
    args.push(worktreePath);
    const result = await this.exec(args, repositoryPath, this.worktreeTimeoutSeconds);
    if (result.exitCode === 0) return;

    const originalFailure = formatProcessFailure("git", result.exitCode, result.stdout, result.stderr);
    if (await isListed()) throw new Error(originalFailure);

    let removalError = "";
    try {
      await this.platform.removeTree(resolvedWorktreePath);
    } catch (error) {
      removalError = (error as Error).message ?? String(error);
    }
    await this.worktreePrune(repositoryPath);

    if (existsSync(resolvedWorktreePath)) {
      const suffix = removalError
        ? ` Fallback removal of '${resolvedWorktreePath}' failed: ${removalError}`
        : ` Fallback removal left '${resolvedWorktreePath}' in place.`;
      throw new Error(originalFailure + suffix);
    }
  }

  /** `git worktree prune`. Throws on failure. */
  async worktreePrune(repositoryPath: string): Promise<void> {
    const result = await this.exec(["worktree", "prune"], repositoryPath, this.worktreeTimeoutSeconds);
    if (result.exitCode !== 0) {
      throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
    }
  }
}
