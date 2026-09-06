// End-to-end tests of worktree.ts (New-HdoWorktree / Assert-HdoWorktreeIntegrity /
// Get-HdoWorktreeProjectContract / Assert-HdoRepositoryConfigSnapshot ports) against
// REAL temporary git repositories - no git/fs mocking - mirroring the style of
// src/git/index.test.ts and src/git/repositoryConfig.test.ts. Skipped entirely when
// `git` is not on PATH.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { GitClient } from "../git/index.ts";
import { getRepositoryConfigSnapshot } from "../git/repositoryConfig.ts";
import {
  assertRepositoryConfigSnapshot,
  assertWorktreeIntegrity,
  createWorktree,
  getBaseCommit,
  getWorktreeProjectContract,
} from "./worktree.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const SKIP_REASON = GIT_AVAILABLE ? false : "git is not on PATH";

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();
const platform = getPlatform();
const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A bare git repo directory with autocrlf disabled, so committed bytes are never mangled. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-worktree-test-"));
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

/** Minimal `schemas/project-contract.schema.json`-valid contract (one required gate). */
function minimalProjectContract(): JsonObject {
  return {
    schemaVersion: 1,
    instructions: { files: [], specificationPaths: [] },
    validationGates: [
      {
        id: "gate-a",
        command: "true",
        args: [],
        required: true,
        timeoutSeconds: 60,
        exitCodes: { passed: [0], failed: [1], indeterminate: [] },
        continueAfterFailure: false,
      },
    ],
    workerPolicy: {
      networkAccess: "denied",
      oneWriterPerWorktree: true,
      allowCommit: false,
      allowPush: false,
      forbiddenCommands: [],
      protectedPaths: [],
    },
    reviewPolicy: {
      defaultViewpoints: ["correctness"],
      highRiskPaths: [],
      largeChangeLines: 500,
      onMissingViewpoint: "escalate",
      stableFindingIds: true,
      mutation: { enabled: false, oneWriterWindow: true, indeterminateIsSuccess: false },
    },
  };
}

function baseConfig(repositoryPath: string, worktreeRoot: string): JsonObject {
  return {
    repositoryPath,
    paths: { worktreeRoot },
  };
}

test("createWorktree creates <worktreeRoot>/<runId> on branch hdo/issue-<n>-<runid> at the base commit", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const baseCommit = headCommit(dir);
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-7-20260101T000000Z-abcd1234";
    const config = baseConfig(dir, worktreeRoot);

    const info = await createWorktree(git, platform, config, runId, 7, () => "2026-01-01T00:00:00.000Z");

    assert.equal(info.path, resolvePath(join(worktreeRoot, runId)));
    assert.equal(info.branch, `hdo/issue-7-${runId.toLowerCase()}`);
    assert.equal(info.baseRef, "HEAD");
    assert.equal(info.baseCommit, baseCommit);
    assert.equal(info.createdAt, "2026-01-01T00:00:00.000Z");
    assert.ok(existsSync(info.path));

    const actualBranch = execFileSync("git", ["-C", info.path, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(actualBranch, info.branch);
    assert.equal(headCommit(info.path), baseCommit);
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});

test("createWorktree throws 'Worktree path already exists' on a second call with the same runId", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-9-run";
    const config = baseConfig(dir, worktreeRoot);

    await createWorktree(git, platform, config, runId, 9, () => "2026-01-01T00:00:00.000Z");
    const expectedPath = resolvePath(join(worktreeRoot, runId));
    await assert.rejects(
      () => createWorktree(git, platform, config, runId, 9, () => "2026-01-01T00:00:01.000Z"),
      (error: unknown) => error instanceof Error && error.message === `Worktree path already exists: ${join(worktreeRoot, runId)}`,
    );
    assert.ok(existsSync(expectedPath));
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});

test("assertWorktreeIntegrity passes right after creation, then throws once the worktree HEAD moves", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-3-run";
    const config = baseConfig(dir, worktreeRoot);
    const info = await createWorktree(git, platform, config, runId, 3, () => "2026-01-01T00:00:00.000Z");

    await assert.doesNotReject(() => assertWorktreeIntegrity(git, platform, info.path, info.baseCommit));

    writeFileSync(join(info.path, "new-file.txt"), "changed\n", "utf8");
    runGit(["add", "-A"], info.path);
    runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "agent committed anyway"], info.path);
    const newHead = headCommit(info.path);
    assert.notEqual(newHead, info.baseCommit);

    await assert.rejects(
      () => assertWorktreeIntegrity(git, platform, info.path, info.baseCommit),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `Worktree HEAD changed from fixed base '${info.baseCommit}' to '${newHead}'. Agents must leave changes uncommitted.`,
    );
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});

test("assertWorktreeIntegrity throws when the given path no longer resolves to itself as the worktree root", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-4-run";
    const config = baseConfig(dir, worktreeRoot);
    const info = await createWorktree(git, platform, config, runId, 4, () => "2026-01-01T00:00:00.000Z");

    const nestedDir = join(info.path, "nested", "deeper");
    mkdirSync(nestedDir, { recursive: true });

    await assert.rejects(
      () => assertWorktreeIntegrity(git, platform, nestedDir, info.baseCommit),
      (error: unknown) =>
        error instanceof Error &&
        // `git rev-parse --show-toplevel` reports the long (non-8.3) spelling, so compare
        // against realpathSync.native(info.path) (GitHub windows-latest: `C:\Users\RUNNER~1`).
        error.message === `Agent working directory no longer resolves to the expected worktree: ${realpathSync.native(info.path)}`,
    );
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});

test("getWorktreeProjectContract resolves .hdo/project.json from inside the worktree", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    mkdirSync(join(dir, ".hdo"));
    const contract = minimalProjectContract();
    writeFileSync(join(dir, ".hdo", "project.json"), JSON.stringify(contract), "utf8");
    commitAll(dir, "add project contract");
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-5-run";
    const config: JsonObject = {
      ...baseConfig(dir, worktreeRoot),
      projectContractPath: join(dir, ".hdo", "project.json"),
    };
    const info = await createWorktree(git, platform, config, runId, 5, () => "2026-01-01T00:00:00.000Z");

    const loaded = getWorktreeProjectContract(config, info.path, schemas);
    assert.equal(loaded.schemaVersion, 1);
    assert.ok(Array.isArray(loaded.validationGates));
    assert.equal((loaded.validationGates as unknown[]).length, 1);
    // Sanity: the file really was read from the WORKTREE copy, not the original checkout.
    assert.ok(existsSync(join(info.path, ".hdo", "project.json")));
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});

test("getWorktreeProjectContract throws for a projectContractPath outside the repository", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const outsideParent = mkdtempSync(join(tmpdir(), "hdo-worktree-outside-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const config: JsonObject = {
      repositoryPath: dir,
      projectContractPath: join(outsideParent, "project.json"),
    };
    assert.throws(
      () => getWorktreeProjectContract(config, join(dir, "does-not-matter"), schemas),
      (error: unknown) => error instanceof Error && error.message === "projectContractPath must be inside the target repository.",
    );
  } finally {
    removeTree(dir);
    removeTree(outsideParent);
  }
});

test("assertRepositoryConfigSnapshot is a no-op when repositoryConfig is not an object, or is ignored", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");

    await assert.doesNotReject(() => assertRepositoryConfigSnapshot(git, schemas, { repositoryPath: dir }, dir));
    await assert.doesNotReject(() =>
      assertRepositoryConfigSnapshot(git, schemas, { repositoryPath: dir, repositoryConfig: { ignored: true, loaded: true, blob: "x", sha256: "y" } }, dir),
    );
  } finally {
    removeTree(dir);
  }
});

test("assertRepositoryConfigSnapshot passes when expected.loaded=false and the worktree has no committed .hdo/config.json", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const config: JsonObject = { repositoryPath: dir, repositoryConfig: { loaded: false, ignored: false, blob: null, sha256: null } };
    await assert.doesNotReject(() => assertRepositoryConfigSnapshot(git, schemas, config, dir));
  } finally {
    removeTree(dir);
  }
});

test("assertRepositoryConfigSnapshot throws 'presence changed' when expected.loaded=false but a config IS committed at HEAD", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
    commitAll(dir, "add repository config");
    const config: JsonObject = { repositoryPath: dir, repositoryConfig: { loaded: false, ignored: false, blob: null, sha256: null } };
    await assert.rejects(
      () => assertRepositoryConfigSnapshot(git, schemas, config, dir),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "The repository configuration presence changed between configuration resolution and worktree creation.",
    );
  } finally {
    removeTree(dir);
  }
});

test("assertRepositoryConfigSnapshot throws 'differs...Retry from a stable HEAD' when expected.blob/sha256 mismatch the committed config", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
    commitAll(dir, "add repository config");
    const config: JsonObject = {
      repositoryPath: dir,
      repositoryConfig: { loaded: true, ignored: false, blob: "0".repeat(40), sha256: "0".repeat(64) },
    };
    await assert.rejects(
      () => assertRepositoryConfigSnapshot(git, schemas, config, dir),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "The repository configuration in the fixed base commit differs from the configuration resolved before worktree creation. Retry from a stable HEAD.",
    );
  } finally {
    removeTree(dir);
  }
});

test("assertRepositoryConfigSnapshot passes when expected.blob/sha256 match the actual committed config", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    const content = JSON.stringify({ schemaVersion: 1 });
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), content, "utf8");
    commitAll(dir, "add repository config");

    const actual = await getRepositoryConfigSnapshot(git, schemas, dir, "HEAD");
    const config: JsonObject = {
      repositoryPath: dir,
      repositoryConfig: { loaded: true, ignored: false, blob: actual.blob, sha256: actual.sha256 },
    };
    await assert.doesNotReject(() => assertRepositoryConfigSnapshot(git, schemas, config, dir));
  } finally {
    removeTree(dir);
  }
});

test("getBaseCommit returns the trimmed rev-parse output and throws formatProcessFailure's text for an unknown ref", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const head = headCommit(dir);
    assert.equal(await getBaseCommit(git, dir), head);
    assert.equal(await getBaseCommit(git, dir, "HEAD"), head);
    await assert.rejects(
      () => getBaseCommit(git, dir, "does-not-exist"),
      (error: unknown) => error instanceof Error && /^Command 'git' failed with exit code \d+\. /.test(error.message),
    );
  } finally {
    removeTree(dir);
  }
});

/**
 * `realpathSync.native` guards against 8.3 short names in temp paths (e.g. GitHub
 * Actions windows-latest's `%TEMP%` under `C:\Users\RUNNER~1\...`, see
 * docs/architecture.md 16.4 item 9) - mirrors src/git/repositoryConfig.test.ts's use
 * of the same helper for the same reason.
 */
test("createWorktree's returned path survives an 8.3-short-name worktreeRoot", { skip: SKIP_REASON }, async () => {
  const dir = initRepo();
  const worktreeRootParent = mkdtempSync(join(tmpdir(), "hdo-worktree-root-"));
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const worktreeRoot = join(worktreeRootParent, "worktrees");
    const runId = "issue-11-run";
    const config = baseConfig(dir, worktreeRoot);
    const info = await createWorktree(git, platform, config, runId, 11, () => "2026-01-01T00:00:00.000Z");
    assert.equal(realpathSync.native(info.path), realpathSync.native(join(worktreeRoot, runId)));
  } finally {
    removeTree(dir);
    removeTree(worktreeRootParent);
  }
});
