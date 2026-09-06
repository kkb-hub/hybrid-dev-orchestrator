// End-to-end tests of `removeRunWorktree` / `isOrphanedWorktree` (Git.ps1:187-301
// port) against REAL temporary git repositories - no git/fs mocking - mirroring the
// style of src/git/index.test.ts and src/workflow/worktree.test.ts. Skipped entirely
// when `git` is not on PATH.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject } from "../core/contracts/types.ts";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { GitClient } from "../git/index.ts";
import { writeJsonFile } from "../runners/artifacts.ts";
import { isOrphanedWorktree, removeRunWorktree } from "./cleanup.ts";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const SKIP_REASON = GIT_AVAILABLE ? false : "git is not on PATH";

const platform = getPlatform();
const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-cleanup-test-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  return dir;
}

function commitAll(dir: string, message: string): void {
  runGit(["add", "-A"], dir);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], dir);
}

function headCommit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** .git can hold read-only/packed objects on Windows that need a couple of retries. */
function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function baseConfig(repositoryPath: string, worktreeRoot: string, artifactRoot: string): JsonObject {
  return { repositoryPath, paths: { worktreeRoot, artifactRoot } };
}

function writeRun(artifactRoot: string, runId: string, run: JsonObject): void {
  writeJsonFile(join(artifactRoot, runId, "run.json"), run);
}

function readRunFile(artifactRoot: string, runId: string): JsonObject {
  return JSON.parse(readFileSync(join(artifactRoot, runId, "run.json"), "utf8")) as JsonObject;
}

/** Sets up `<worktreeRoot>/<runId>` as a real, listed, clean `git worktree`. */
async function addWorktree(repositoryPath: string, worktreeRoot: string, runId: string, branch: string): Promise<string> {
  const head = headCommit(repositoryPath);
  const worktreePath = join(worktreeRoot, runId);
  await git.worktreeAdd(repositoryPath, { branch, worktreePath, baseCommit: head });
  return worktreePath;
}

test("isOrphanedWorktree: true only for <worktreeRoot>/<runId>, no .git, and a real branch", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    runGit(["branch", "hdo/orphan-branch"], dir);

    const worktreeRoot = join(root, "worktrees");
    const runId = "issue-1-run";
    const orphanDir = join(worktreeRoot, runId);
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "leftover.txt"), "x", "utf8");

    assert.equal(await isOrphanedWorktree(git, platform, orphanDir, dir, worktreeRoot, runId, "hdo/orphan-branch"), true);
    // Wrong runId (path does not match <worktreeRoot>/<runId>).
    assert.equal(await isOrphanedWorktree(git, platform, orphanDir, dir, worktreeRoot, "some-other-run", "hdo/orphan-branch"), false);
    // Branch does not exist.
    assert.equal(await isOrphanedWorktree(git, platform, orphanDir, dir, worktreeRoot, runId, "hdo/does-not-exist"), false);
    // Empty branch.
    assert.equal(await isOrphanedWorktree(git, platform, orphanDir, dir, worktreeRoot, runId, ""), false);
    // A '.git' entry present disqualifies it (it looks like a real checkout).
    writeFileSync(join(orphanDir, ".git"), "gitdir: /nowhere", "utf8");
    assert.equal(await isOrphanedWorktree(git, platform, orphanDir, dir, worktreeRoot, runId, "hdo/orphan-branch"), false);
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: throws \"Run '<id>' has no worktree path.\" when run.json has no worktree.path", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    await assert.rejects(
      removeRunWorktree({ runId, config, git, platform }),
      (error: unknown) => error instanceof Error && error.message === `Run '${runId}' has no worktree path.`,
    );
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: throws 'Refusing cleanup because worktree is outside configured root' for a worktree.path outside worktreeRoot", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  const outside = mkdtempSync(join(tmpdir(), "hdo-cleanup-outside-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const outsidePath = join(outside, "not-under-root");
    mkdirSync(outsidePath, { recursive: true });
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: outsidePath, branch: "hdo/whatever" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    await assert.rejects(
      removeRunWorktree({ runId, config, git, platform }),
      (error: unknown) =>
        error instanceof Error && error.message === `Refusing cleanup because worktree is outside configured root: ${outsidePath}`,
    );
  } finally {
    removeTree(dir);
    removeTree(root);
    removeTree(outside);
  }
});

test("removeRunWorktree: returns { removed: false, reason: 'already-missing' } when the directory does not exist, even under -WhatIf", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const missingPath = join(worktreeRoot, runId);
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: missingPath, branch: "hdo/whatever" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    const result = await removeRunWorktree({ runId, config, git, platform });
    assert.deepEqual(result, { runId, removed: false, reason: "already-missing", path: missingPath });

    // Same result under -WhatIf: PowerShell runs this check before ShouldProcess.
    let whatIfCalls = 0;
    const whatIfResult = await removeRunWorktree({
      runId,
      config,
      git,
      platform,
      whatIf: true,
      writeHostLine: () => whatIfCalls++,
    });
    assert.deepEqual(whatIfResult, { runId, removed: false, reason: "already-missing", path: missingPath });
    assert.equal(whatIfCalls, 0, "the already-missing early return must not print a What-if line");
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: throws 'Git does not list the target' when the directory exists but is neither listed nor orphaned", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = join(worktreeRoot, runId);
    // Directory exists, but is a plain directory never registered with `git worktree
    // add` - and no branch is recorded, so `isOrphanedWorktree` is false too.
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "stray.txt"), "x", "utf8");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    await assert.rejects(
      removeRunWorktree({ runId, config, git, platform }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Refusing cleanup because Git does not list the target as a worktree: ${worktreePath}`,
    );
    assert.ok(existsSync(worktreePath), "nothing should have been touched");
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: orphaned worktree without -Force throws the long issue #25 message and touches nothing", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    runGit(["branch", "hdo/issue-1-run"], dir);
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = join(worktreeRoot, runId);
    // Simulates the issue #25 end-state: the directory sits exactly at
    // <worktreeRoot>/<runId>, has no `.git`, and its branch still exists - but it was
    // never (or is no longer) registered with `git worktree add`.
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "leftover.txt"), "x", "utf8");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    await assert.rejects(
      removeRunWorktree({ runId, config, git, platform }),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          `Refusing cleanup because Git does not list the target as a worktree: ${worktreePath}. The directory is an orphaned worktree of this repository whose Git admin entry is already gone (issue #25); re-run with -Force to delete it.`,
    );
    assert.ok(existsSync(worktreePath), "nothing should have been touched");
    assert.deepEqual((readRunFile(artifactRoot, runId) as JsonObject).cleanup, undefined);
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: orphaned worktree WITH -Force deletes the directory, prunes, and writes run.cleanup", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    runGit(["branch", "hdo/issue-1-run"], dir);
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = join(worktreeRoot, runId);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "leftover.txt"), "x", "utf8");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    const result = await removeRunWorktree({ runId, config, git, platform, force: true, now: () => "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(result, { runId, removed: true, path: worktreePath, branchPreserved: "hdo/issue-1-run" });
    assert.equal(existsSync(worktreePath), false);

    const savedRun = readRunFile(artifactRoot, runId);
    assert.deepEqual(savedRun.cleanup, { worktreeRemoved: true, removedAt: "2026-01-01T00:00:00.000Z", forced: true });
    assert.equal(savedRun.updatedAt, "2026-01-01T00:00:00.000Z");
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: a dirty listed worktree without -Force throws and leaves everything intact", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  const worktreeRoot = join(root, "worktrees");
  const runId = "issue-1-run";
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const artifactRoot = join(root, "runs");
    const worktreePath = await addWorktree(dir, worktreeRoot, runId, "hdo/issue-1-run");
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted", "utf8");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    await assert.rejects(
      removeRunWorktree({ runId, config, git, platform }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: ${worktreePath}`,
    );
    assert.ok(existsSync(join(worktreePath, "dirty.txt")), "nothing should have been touched");
    assert.deepEqual((readRunFile(artifactRoot, runId) as JsonObject).cleanup, undefined);
  } finally {
    await git.worktreeRemove(dir, join(worktreeRoot, runId), { force: true }).catch(() => undefined);
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: a dirty listed worktree WITH -Force removes it and writes run.cleanup(forced: true)", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = await addWorktree(dir, worktreeRoot, runId, "hdo/issue-1-run");
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted", "utf8");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    const result = await removeRunWorktree({ runId, config, git, platform, force: true });
    assert.deepEqual(result, { runId, removed: true, path: worktreePath, branchPreserved: "hdo/issue-1-run" });
    assert.equal(existsSync(worktreePath), false);

    const savedRun = readRunFile(artifactRoot, runId);
    assert.equal((savedRun.cleanup as JsonObject).forced, true);
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: -WhatIf on a clean listed worktree prints the ShouldProcess line, changes nothing, and returns undefined", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = await addWorktree(dir, worktreeRoot, runId, "hdo/issue-1-run");
    const originalRun = { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } };
    writeRun(artifactRoot, runId, originalRun);
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    const lines: string[] = [];
    const result = await removeRunWorktree({ runId, config, git, platform, whatIf: true, writeHostLine: (line) => lines.push(line) });

    assert.equal(result, undefined);
    assert.deepEqual(lines, [`What if: Performing the operation "Remove HDO Git worktree" on target "${worktreePath}".`]);
    assert.ok(existsSync(worktreePath), "the worktree must survive a -WhatIf preview");
    const listedAfter = await git.worktreeList(dir);
    assert.ok(
      listedAfter.some((p) => platform.pathEquals(platform.comparableFullPath(p), platform.comparableFullPath(worktreePath))),
      "the worktree must still be listed after -WhatIf",
    );
    assert.deepEqual(readRunFile(artifactRoot, runId), originalRun, "run.json must be untouched by -WhatIf");
  } finally {
    await git.worktreeRemove(dir, join(root, "worktrees", "issue-1-run"), { force: true }).catch(() => undefined);
    removeTree(dir);
    removeTree(root);
  }
});

test("removeRunWorktree: successful non-orphan removal deletes the worktree and writes run.cleanup(forced: false)", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanup-root-"));
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const runId = "issue-1-run";
    const worktreePath = await addWorktree(dir, worktreeRoot, runId, "hdo/issue-1-run");
    writeRun(artifactRoot, runId, { schemaVersion: 1, id: runId, worktree: { path: worktreePath, branch: "hdo/issue-1-run" } });
    const config = baseConfig(dir, worktreeRoot, artifactRoot);

    const result = await removeRunWorktree({ runId, config, git, platform, now: () => "2026-02-02T00:00:00.000Z" });
    assert.deepEqual(result, { runId, removed: true, path: worktreePath, branchPreserved: "hdo/issue-1-run" });
    assert.equal(existsSync(worktreePath), false);

    const listedAfter = await git.worktreeList(dir);
    assert.ok(!listedAfter.some((p) => platform.pathEquals(platform.comparableFullPath(p), platform.comparableFullPath(worktreePath))));

    const savedRun = readRunFile(artifactRoot, runId);
    assert.deepEqual(savedRun.cleanup, { worktreeRemoved: true, removedAt: "2026-02-02T00:00:00.000Z", forced: false });
    assert.equal(savedRun.updatedAt, "2026-02-02T00:00:00.000Z");
  } finally {
    removeTree(dir);
    removeTree(root);
  }
});
