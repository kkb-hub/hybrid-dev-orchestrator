// Port of `Remove-HdoRunWorktree` / `Test-HdoOrphanedWorktree` (Git.ps1:187-301). Like
// the rest of `src/workflow/**` (ADR-0001 phase 5/6 plan boundary), everything that
// touches the filesystem or spawns a process is reached only through the injected
// `GitClient`/`PlatformAdapter` (or the shared `runners/artifacts.ts` file helpers),
// and this file never imports `src/cli`.
import { existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import { asString } from "../core/runners/psSemantics.ts";
import { getValue } from "../core/config/value.ts";
import { formatProcessFailure, GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { writeJsonFile } from "../runners/artifacts.ts";
import { readRun } from "./runStore.ts";

/** True for an existing directory, matching `Test-Path -LiteralPath ... -PathType Container`. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Port of `Test-HdoOrphanedWorktree` (Git.ps1:187-209). A worktree whose `git worktree
 * remove` died on "Filename too long" (issue #25) has already lost its admin entry,
 * its gitfile and its tracked files: git no longer lists it and only the undeletable
 * subtree (typically `node_modules`) is left. This recognises that shape strictly so
 * cleanup only ever finishes HDO's own worktree slot for this run: the directory is
 * exactly `<worktreeRoot>/<runId>` (how `createWorktree` names it), the run's branch
 * still exists in this repository, and nothing inside claims to be a Git checkout of
 * its own.
 */
export async function isOrphanedWorktree(
  git: GitClient,
  platform: PlatformAdapter,
  worktreePath: string,
  repositoryPath: string,
  worktreeRoot: string,
  runId: string,
  branch: string,
): Promise<boolean> {
  const expectedPath = platform.comparableFullPath(join(worktreeRoot, runId));
  if (platform.comparableFullPath(worktreePath) !== expectedPath) return false;
  if (existsSync(join(worktreePath, ".git"))) return false;
  if (!branch) return false;
  const branchResult = await git.exec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repositoryPath);
  return branchResult.exitCode === 0;
}

export interface RemoveRunWorktreeOptions {
  runId: string;
  /** Already-resolved configuration (`resolveCliConfig`'s output): needs `paths.artifactRoot`, `paths.worktreeRoot`, `repositoryPath`. */
  config: JsonObject;
  git: GitClient;
  platform: PlatformAdapter;
  force?: boolean;
  whatIf?: boolean;
  /** Overridable for tests; defaults to `() => new Date().toISOString()` (analogous to `Get-HdoUtcTimestamp`). */
  now?: () => string;
  /**
   * Sink for the `-WhatIf` preview line (`ShouldProcess`'s own stdout output);
   * defaults to `process.stdout.write` with a trailing `\n`. Overridable for tests.
   */
  writeHostLine?: (line: string) => void;
}

export interface RemoveRunWorktreeResult {
  runId: string;
  removed: boolean;
  /** Only set when `removed` is false (the `already-missing` early return). */
  reason?: string;
  path: string;
  /** Only set when `removed` is true. */
  branchPreserved?: string;
}

function defaultWriteHostLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Port of `Remove-HdoRunWorktree` (Git.ps1:211-301). Returns `undefined` for the
 * `-WhatIf` preview (mirrors PowerShell's `$PSCmdlet.ShouldProcess(...)` returning
 * false and the function producing no output) - the caller (`runCleanupCommand`)
 * surfaces that as `null`, matching `Write-HdoCliOutput`'s `ConvertTo-Json` rendering
 * of `$null` (empirically verified, see phase 7 plan Q1).
 */
export async function removeRunWorktree(
  options: RemoveRunWorktreeOptions,
): Promise<RemoveRunWorktreeResult | undefined> {
  const { runId, git, platform, config } = options;
  const force = Boolean(options.force);
  const whatIf = Boolean(options.whatIf);
  const now = options.now ?? ((): string => new Date().toISOString());
  const writeHostLine = options.writeHostLine ?? defaultWriteHostLine;

  // Oracle: Git.ps1:222-224. Resolve once so the read (via `readRun`, which applies
  // `path.resolve` internally) and the later write of the cleanup stamp
  // (`writeJsonFile(join(artifactPath, "run.json"), ...)`) agree on the same absolute
  // path instead of one resolved and the other not (R1-2).
  const artifactRoot = asString(getValue(config, "paths.artifactRoot"));
  const resolvedArtifactRoot = resolvePath(artifactRoot);
  const artifactPath = join(resolvedArtifactRoot, runId);
  const run = readRun(resolvedArtifactRoot, runId);

  // Oracle: Git.ps1:225-226, "Run '$RunId' has no worktree path."
  const worktreePath = asString(getValue(run, "worktree.path", ""));
  if (!worktreePath) {
    throw new Error(`Run '${runId}' has no worktree path.`);
  }

  const worktreeRoot = asString(getValue(config, "paths.worktreeRoot"));
  // Oracle: Git.ps1:227-229, "Refusing cleanup because worktree is outside configured root: $worktreePath"
  if (!platform.isPathWithinRoot(worktreePath, worktreeRoot)) {
    throw new Error(`Refusing cleanup because worktree is outside configured root: ${worktreePath}`);
  }

  // Oracle: Git.ps1:230-232. This early return fires even under `-WhatIf` - PowerShell
  // runs it before `$PSCmdlet.ShouldProcess(...)` is ever consulted.
  if (!isDirectory(worktreePath)) {
    return { runId, removed: false, reason: "already-missing", path: worktreePath };
  }

  const repositoryPath = asString(getValue(config, "repositoryPath"));
  // Oracle: Git.ps1:235-239 - `git worktree list --porcelain`, compared via
  // `comparableFullPath`/`pathEquals` exactly like `GitClient.worktreeRemove`'s own
  // NB-1 pre-check (git may print forward slashes or an 8.3 short name).
  const listedPaths = await git.worktreeList(repositoryPath);
  const targetComparable = platform.comparableFullPath(worktreePath);
  const listedWorktreePath = listedPaths.find((entry) =>
    platform.pathEquals(platform.comparableFullPath(entry), targetComparable),
  );

  let orphaned = false;
  if (listedWorktreePath === undefined) {
    const branch = asString(getValue(run, "worktree.branch", ""));
    const orphan = await isOrphanedWorktree(git, platform, worktreePath, repositoryPath, worktreeRoot, runId, branch);
    if (!orphan) {
      // Oracle: Git.ps1:243, "Refusing cleanup because Git does not list the target as a worktree: $worktreePath"
      throw new Error(`Refusing cleanup because Git does not list the target as a worktree: ${worktreePath}`);
    }
    if (!force) {
      // Oracle: Git.ps1:246.
      throw new Error(
        `Refusing cleanup because Git does not list the target as a worktree: ${worktreePath}. The directory is an orphaned worktree of this repository whose Git admin entry is already gone (issue #25); re-run with -Force to delete it.`,
      );
    }
    orphaned = true;
  }

  if (!orphaned) {
    // Oracle: Git.ps1:250-254, "Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: $worktreePath"
    const dirty = await git.exec(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath);
    if (dirty.exitCode !== 0) {
      throw new Error(formatProcessFailure("git", dirty.exitCode, dirty.stdout, dirty.stderr));
    }
    if (dirty.stdout.trim() && !force) {
      throw new Error(`Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: ${worktreePath}`);
    }
  }

  // Oracle: Git.ps1:257, `$PSCmdlet.ShouldProcess($worktreePath, 'Remove HDO Git worktree')`.
  if (whatIf) {
    writeHostLine(`What if: Performing the operation "Remove HDO Git worktree" on target "${worktreePath}".`);
    return undefined;
  }

  if (orphaned) {
    // Oracle: Git.ps1:265-296's fallback, taken unconditionally for the orphan branch
    // (no `git worktree remove` call at all - `$removeResult` stays `$null`, so
    // `$gitFailure` stays empty and the eventual throw is the bare
    // "Failed to remove orphaned worktree directory." plus suffix).
    let removalError = "";
    try {
      await platform.removeTree(worktreePath);
    } catch (error) {
      removalError = (error as Error).message ?? String(error);
    }
    await git.worktreePrune(repositoryPath);
    if (existsSync(worktreePath)) {
      const suffix = removalError
        ? ` Fallback removal of '${worktreePath}' failed: ${removalError}`
        : ` Fallback removal left '${worktreePath}' in place.`;
      throw new Error(`Failed to remove orphaned worktree directory.${suffix}`);
    }
  } else {
    // `GitClient.worktreeRemove` already implements the non-orphan "listed
    // pre-check -> `git worktree remove [--force]` -> on failure, fall back to
    // `platform.removeTree` + `git worktree prune`, rethrowing the original failure
    // (plus a suffix) if the directory survives" recovery (src/git/index.ts).
    await git.worktreeRemove(repositoryPath, listedWorktreePath as string, { force });
  }

  const branchPreserved = asString(getValue(run, "worktree.branch", ""));
  // Oracle: Git.ps1:297-299 - `Save-HdoRun` (State.ps1:33-40) sets `updatedAt` too.
  run.cleanup = { worktreeRemoved: true, removedAt: now(), forced: force };
  run.updatedAt = now();
  writeJsonFile(join(artifactPath, "run.json"), run as unknown as JsonValue);

  return { runId, removed: true, path: worktreePath, branchPreserved };
}
