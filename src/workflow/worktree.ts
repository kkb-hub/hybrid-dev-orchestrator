// Port of `Get-HdoBaseCommit` / `New-HdoWorktree` / `Assert-HdoWorktreeIntegrity`
// (Git.ps1:67-124), `Get-HdoWorktreeProjectContract` (Workflow.ps1:189-200) and
// `Assert-HdoRepositoryConfigSnapshot` (Configuration.ps1:138-154). `src/workflow/**`
// is a host module (ADR-0001 phase 5 plan §2 boundary): everything that touches the
// filesystem or spawns a process is reached only through the injected `GitClient`/
// `PlatformAdapter`, and this file never imports `src/cli`.
import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { JsonObject } from "../core/contracts/types.ts";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { getValue } from "../core/config/value.ts";
import { asString, isPlainObject, isTruthy } from "../core/runners/psSemantics.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { formatProcessFailure, GitClient } from "../git/index.ts";
import { getRepositoryConfigSnapshot } from "../git/repositoryConfig.ts";
import { loadProjectContract } from "./projectContract.ts";

/**
 * Port of `Get-HdoBaseCommit` (Git.ps1:67-75): `git rev-parse --verify
 * <baseRef>^{commit}`, throwing `formatProcessFailure`'s text on a non-zero exit code
 * (mirroring `Invoke-HdoGit @('rev-parse','--verify',...) -ThrowOnError`), returning
 * trimmed stdout otherwise.
 */
export async function getBaseCommit(git: GitClient, repositoryPath: string, baseRef = "HEAD"): Promise<string> {
  const result = await git.revParseVerify(repositoryPath, `${baseRef}^{commit}`);
  if (result.exitCode !== 0) {
    throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
  }
  return result.stdout.trim();
}

/** Shape of `New-HdoWorktree`'s return value / `run.json`'s `worktree` object (Git.ps1:117-123). */
export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
}

/**
 * Port of `New-HdoWorktree` (Git.ps1:95-124). `platform` is accepted for signature
 * symmetry with `assertWorktreeIntegrity` (both take the full `GitClient`/
 * `PlatformAdapter` pair a worktree-lifecycle function needs) even though this
 * particular PowerShell body never consults a `Test-HdoPathWithinRoot`-style
 * predicate.
 *
 * `baseRef` = `[string](Get-HdoValue $Config 'git.baseRef' 'HEAD')`; `baseCommit` =
 * `Get-HdoBaseCommit $repositoryPath $baseRef`; `worktreeRoot` = `[string]
 * $Config.paths.worktreeRoot` (`New-Item -ItemType Directory -Force`, :106); the
 * worktree path is `Join-Path $worktreeRoot $RunId` - `Test-Path` (:108) throws
 * `Worktree path already exists: <path>` before git ever runs. The branch name
 * lower-cases the run id and replaces every character outside
 * `[A-Za-z0-9._-]` with `-` (:110). `git worktree add -b <branch> <worktreePath>
 * <baseCommit>` (:112) has its OWN failure text (:113-114) - NOT
 * `GitClient.worktreeAdd`'s `formatProcessFailure`, and NOT `GitClient.worktreeAdd`
 * itself, whose throw text differs.
 */
export async function createWorktree(
  git: GitClient,
  platform: PlatformAdapter,
  config: JsonObject,
  runId: string,
  issueNumber: number,
  now: () => string,
): Promise<WorktreeInfo> {
  void platform;
  const repositoryPath = asString(config.repositoryPath);
  const baseRef = asString(getValue(config, "git.baseRef", "HEAD"));
  const baseCommit = await getBaseCommit(git, repositoryPath, baseRef);
  const worktreeRoot = asString(getValue(config, "paths.worktreeRoot"));
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = join(worktreeRoot, runId);
  if (existsSync(worktreePath)) {
    // Oracle: Git.ps1:108, "Worktree path already exists: $worktreePath"
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const branchSuffix = runId.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
  const branch = `hdo/issue-${issueNumber}-${branchSuffix}`;
  const result = await git.exec(["worktree", "add", "-b", branch, worktreePath, baseCommit], repositoryPath, 300);
  if (result.exitCode !== 0) {
    // Oracle: Git.ps1:114, "Failed to create worktree '$worktreePath': $($result.stderr.Trim())"
    throw new Error(`Failed to create worktree '${worktreePath}': ${result.stderr.trim()}`);
  }

  return {
    path: resolve(worktreePath),
    branch,
    baseRef,
    baseCommit,
    createdAt: now(),
  };
}

/**
 * Port of `Assert-HdoWorktreeIntegrity` (Git.ps1:77-93): checks that
 * `worktreePath` still resolves to itself as a repository root (guards against the
 * agent `cd`-ing out of the worktree or the worktree having been removed/replaced),
 * then that its `HEAD` is still exactly `baseCommit` (the contract that agents leave
 * changes uncommitted).
 */
export async function assertWorktreeIntegrity(
  git: GitClient,
  platform: PlatformAdapter,
  worktreePath: string,
  baseCommit: string,
): Promise<void> {
  const actualRoot = await git.repositoryRoot(worktreePath);
  if (!platform.pathEquals(platform.comparableFullPath(actualRoot), platform.comparableFullPath(worktreePath))) {
    // Oracle: Git.ps1:86, "Agent working directory no longer resolves to the expected worktree: $actualRoot"
    throw new Error(`Agent working directory no longer resolves to the expected worktree: ${actualRoot}`);
  }
  const head = await getBaseCommit(git, worktreePath, "HEAD");
  if (head !== baseCommit) {
    // Oracle: Git.ps1:90, "Worktree HEAD changed from fixed base '$BaseCommit' to '$head'. Agents must leave changes uncommitted."
    throw new Error(`Worktree HEAD changed from fixed base '${baseCommit}' to '${head}'. Agents must leave changes uncommitted.`);
  }
}

/**
 * Port of `Get-HdoWorktreeProjectContract` (Workflow.ps1:189-200): re-resolves the
 * project contract from INSIDE the worktree (rather than the original repository
 * checkout) at the fixed base commit, using the same relative path from
 * `repositoryPath` to `projectContractPath` that was validated during config
 * resolution. `[System.IO.Path]::GetRelativePath` is case-insensitive on Windows,
 * ordinal elsewhere - matched here by `node:path`'s `relative`, which exhibits the
 * same platform-dependent case sensitivity (verified: `path.relative` on win32
 * resolves `C:\repo` vs `C:\REPO\.hdo\project.json` to `.hdo\project.json`, matching
 * `GetRelativePath`).
 */
export function getWorktreeProjectContract(config: JsonObject, worktreePath: string, schemas: SchemaRegistry): JsonObject {
  const repositoryPath = asString(config.repositoryPath);
  const projectContractPath = asString(config.projectContractPath);
  const relativePath = relative(repositoryPath, projectContractPath);
  if (relativePath.startsWith("..")) {
    // Oracle: Workflow.ps1:196, "projectContractPath must be inside the target repository."
    throw new Error("projectContractPath must be inside the target repository.");
  }
  const worktreeContractPath = resolve(join(worktreePath, relativePath));
  return loadProjectContract(worktreeContractPath, schemas);
}

/**
 * Port of `Assert-HdoRepositoryConfigSnapshot` (Configuration.ps1:138-154): compares
 * the `repositoryConfig` snapshot embedded in the already-resolved `config` (taken
 * before the worktree existed) against a freshly-read snapshot of the worktree's own
 * `HEAD` - guarding against a TOCTOU race where `.hdo/config.json` changed between
 * config resolution and worktree creation. A no-op when `config.repositoryConfig` is
 * not an object, or is marked `ignored`.
 */
export async function assertRepositoryConfigSnapshot(
  git: GitClient,
  schemas: SchemaRegistry,
  config: JsonObject,
  worktreePath: string,
): Promise<void> {
  const expected = getValue(config, "repositoryConfig");
  if (!isPlainObject(expected) || isTruthy(getValue(expected, "ignored", false))) {
    return;
  }
  const actual = await getRepositoryConfigSnapshot(git, schemas, worktreePath, "HEAD");
  const expectedLoaded = isTruthy(getValue(expected, "loaded"));
  if (expectedLoaded !== actual.loaded) {
    // Oracle: Configuration.ps1:148, "The repository configuration presence changed between configuration resolution and worktree creation."
    throw new Error("The repository configuration presence changed between configuration resolution and worktree creation.");
  }
  if (expectedLoaded) {
    const expectedBlob = asString(getValue(expected, "blob"));
    const expectedSha256 = asString(getValue(expected, "sha256"));
    const actualBlob = actual.blob ?? "";
    const actualSha256 = actual.sha256 ?? "";
    if (expectedBlob !== actualBlob || expectedSha256 !== actualSha256) {
      // Oracle: Configuration.ps1:151, "The repository configuration in the fixed base commit differs from the configuration resolved before worktree creation. Retry from a stable HEAD."
      throw new Error(
        "The repository configuration in the fixed base commit differs from the configuration resolved before worktree creation. Retry from a stable HEAD.",
      );
    }
  }
}
