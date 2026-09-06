// End-to-end tests of `runCleanupCommand` against the REAL environment (real git,
// real filesystem) - mirrors hdo.ps1's `cleanup` case (hdo.ps1:133-145) and the
// `statusCommand.test.ts` pattern (a `-Config` overlay pointing `paths.artifactRoot`/
// `paths.worktreeRoot` at a temp directory, `-RepositoryPath` at a throwaway temp git
// repository so `git worktree add/remove/prune` are free to run for real).
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatform } from "../platform/index.ts";
import { GitClient } from "../git/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { writeJsonFile } from "../runners/artifacts.ts";
import { runCleanupCommand } from "./cleanupCommand.ts";
import { parseArgs } from "./args.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const SKIP_REASON = GIT_AVAILABLE ? false : "git is not on PATH";

const platform = getPlatform();
const schemas = loadSchemaRegistry();
const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-cleanupCommand-test-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "a.txt"), "x", "utf8");
  runGit(["add", "-A"], dir);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], dir);
  return dir;
}

function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function headCommit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("runCleanupCommand: throws 'cleanup requires -RunId.' when -RunId is missing", async () => {
  const repo = initRepo();
  try {
    const parsed = parseArgs(["cleanup", "-RepositoryPath", repo]);
    await assert.rejects(
      runCleanupCommand({ parsed, platform, schemas }),
      (error: unknown) => error instanceof Error && error.message === "cleanup requires -RunId.",
    );
  } finally {
    removeTree(repo);
  }
});

test("runCleanupCommand: resolves config, removes a clean listed worktree, and writes run.cleanup", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanupCommand-root-"));
  try {
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const overlayPath = join(root, "overlay.json");
    writeFileSync(overlayPath, JSON.stringify({ paths: { worktreeRoot, artifactRoot } }), "utf8");

    const runId = "issue-9-run";
    const head = headCommit(repo);
    const worktreePath = join(worktreeRoot, runId);
    await git.worktreeAdd(repo, { branch: "hdo/issue-9-run", worktreePath, baseCommit: head });
    writeJsonFile(join(artifactRoot, runId, "run.json"), {
      schemaVersion: 1,
      id: runId,
      worktree: { path: worktreePath, branch: "hdo/issue-9-run" },
    });

    const parsed = parseArgs(["cleanup", "-RunId", runId, "-Config", overlayPath, "-RepositoryPath", repo]);
    const result = await runCleanupCommand({ parsed, platform, schemas });

    assert.deepEqual(result, { runId, removed: true, path: worktreePath, branchPreserved: "hdo/issue-9-run" });
    assert.equal(existsSync(worktreePath), false);
  } finally {
    removeTree(repo);
    removeTree(root);
  }
});

test("runCleanupCommand: threads -Force through to an orphaned worktree, and -WhatIf produces no side effects", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  const root = mkdtempSync(join(tmpdir(), "hdo-cleanupCommand-root-"));
  try {
    const worktreeRoot = join(root, "worktrees");
    const artifactRoot = join(root, "runs");
    const overlayPath = join(root, "overlay.json");
    writeFileSync(overlayPath, JSON.stringify({ paths: { worktreeRoot, artifactRoot } }), "utf8");

    const runId = "issue-10-run";
    const head = headCommit(repo);
    const worktreePath = join(worktreeRoot, runId);
    await git.worktreeAdd(repo, { branch: "hdo/issue-10-run", worktreePath, baseCommit: head });
    writeJsonFile(join(artifactRoot, runId, "run.json"), {
      schemaVersion: 1,
      id: runId,
      worktree: { path: worktreePath, branch: "hdo/issue-10-run" },
    });

    // -WhatIf: nothing removed, the ShouldProcess line is written to the injected sink.
    const lines: string[] = [];
    const parsedWhatIf = parseArgs(["cleanup", "-RunId", runId, "-Config", overlayPath, "-RepositoryPath", repo, "-WhatIf"]);
    const whatIfResult = await runCleanupCommand({
      parsed: parsedWhatIf,
      platform,
      schemas,
      writeHostLine: (line) => lines.push(line),
    });
    assert.equal(whatIfResult, undefined);
    assert.deepEqual(lines, [`What if: Performing the operation "Remove HDO Git worktree" on target "${worktreePath}".`]);
    assert.ok(existsSync(worktreePath), "the worktree must survive -WhatIf");

    // -Force threads through: dirty the worktree, confirm plain cleanup refuses, then
    // -Force succeeds.
    writeFileSync(join(worktreePath, "dirty.txt"), "uncommitted", "utf8");
    const parsedPlain = parseArgs(["cleanup", "-RunId", runId, "-Config", overlayPath, "-RepositoryPath", repo]);
    await assert.rejects(
      runCleanupCommand({ parsed: parsedPlain, platform, schemas }),
      (error: unknown) => error instanceof Error && error.message.startsWith("Worktree has uncommitted changes."),
    );

    const parsedForce = parseArgs(["cleanup", "-RunId", runId, "-Config", overlayPath, "-RepositoryPath", repo, "-Force"]);
    const forcedResult = await runCleanupCommand({ parsed: parsedForce, platform, schemas });
    assert.deepEqual(forcedResult, { runId, removed: true, path: worktreePath, branchPreserved: "hdo/issue-10-run" });
    assert.equal(existsSync(worktreePath), false);
  } finally {
    removeTree(repo);
    removeTree(root);
  }
});
