// End-to-end tests of getRepositoryConfigSnapshot (Get-HdoRepositoryConfigSnapshot
// port) against REAL temporary git repositories - no git/fs mocking - so the actual
// `git rev-parse`/`git show` interplay this module depends on is exercised for real.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { GitClient } from "./index.ts";
import { getRepositoryConfigSnapshot } from "./repositoryConfig.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();
const git = new GitClient();

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A bare git repo directory with autocrlf disabled, so committed bytes are never mangled. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-repoconfig-test-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  return dir;
}

function commitAll(dir: string, message: string): void {
  runGit(["add", "-A"], dir);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], dir);
}

function removeRepo(dir: string): void {
  // .git can hold read-only/packed objects on Windows that need a couple of retries.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("no commits, no .hdo/config.json: loaded=false, commit=null", async () => {
  const dir = initRepo();
  try {
    const snapshot = await getRepositoryConfigSnapshot(git, schemas, dir);
    assert.equal(snapshot.loaded, false);
    assert.equal(snapshot.commit, null);
    assert.equal(snapshot.blob, null);
    assert.equal(snapshot.sha256, null);
    // `snapshot.path` is built from `git rev-parse --show-toplevel`'s output, which
    // git resolves to a long-form path even when `dir` (from `mkdtempSync(tmpdir())`)
    // is an 8.3 short name (e.g. GitHub Actions' `windows-latest`, where `%TEMP%` is
    // `C:\Users\RUNNER~1\...`) - see docs/architecture.md 16.4 item 9. Canonicalize
    // `dir` the same way before comparing so this assertion is short-name-robust.
    assert.equal(snapshot.path, join(realpathSync.native(dir), ".hdo", "config.json"));
  } finally {
    removeRepo(dir);
  }
});

test("no commits + an UNCOMMITTED .hdo/config.json throws (HEAD is not a readable commit)", async () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
    await assert.rejects(
      () => getRepositoryConfigSnapshot(git, schemas, dir),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "Repository configuration exists but 'HEAD' is not a readable commit. Commit .hdo/config.json before HDO can trust it.",
    );
  } finally {
    removeRepo(dir);
  }
});

test("a commit exists but no .hdo/config.json (ever): loaded=false, commit=<sha>", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    const snapshot = await getRepositoryConfigSnapshot(git, schemas, dir);
    assert.equal(snapshot.loaded, false);
    assert.match(snapshot.commit as string, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.blob, null);
    assert.equal(snapshot.sha256, null);
  } finally {
    removeRepo(dir);
  }
});

test("a commit exists + an UNCOMMITTED .hdo/config.json throws (must be committed)", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
    commitAll(dir, "initial commit");
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
    await assert.rejects(
      () => getRepositoryConfigSnapshot(git, schemas, dir),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Repository configuration must be committed before HDO can load it automatically: .hdo/config.json",
    );
  } finally {
    removeRepo(dir);
  }
});

test("a committed, schema-valid .hdo/config.json: loaded=true, blob/sha256 present and correct, value parsed", async () => {
  const dir = initRepo();
  try {
    const content = JSON.stringify({ schemaVersion: 1, activeProfile: "claude-only" });
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), content, "utf8");
    commitAll(dir, "add repository config");

    const snapshot = await getRepositoryConfigSnapshot(git, schemas, dir);
    assert.equal(snapshot.loaded, true);
    assert.match(snapshot.commit as string, /^[0-9a-f]{40}$/);
    assert.match(snapshot.blob as string, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.sha256, sha256Hex(content));
    assert.deepEqual(snapshot.value, { schemaVersion: 1, activeProfile: "claude-only" });
  } finally {
    removeRepo(dir);
  }
});

test("a committed, schema-invalid .hdo/config.json throws with the documented message prefix", async () => {
  const dir = initRepo();
  try {
    // "command" is not a permitted property of a repository runner (schemas/
    // hdo-repository-config.schema.json's $defs/runner has additionalProperties:false
    // and does not list "command" - repository config may never declare executables).
    const content = JSON.stringify({ schemaVersion: 1, runners: { x: { type: "codex", command: "evil" } } });
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), content, "utf8");
    commitAll(dir, "add invalid repository config");

    await assert.rejects(
      () => getRepositoryConfigSnapshot(git, schemas, dir),
      (error: unknown) => error instanceof Error && error.message.startsWith("Repository configuration schema validation failed for '"),
    );
  } finally {
    removeRepo(dir);
  }
});

test("a committed, malformed-JSON .hdo/config.json throws mentioning 'Invalid JSON'", async () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, ".hdo"));
    writeFileSync(join(dir, ".hdo", "config.json"), "{not valid json", "utf8");
    commitAll(dir, "add malformed repository config");

    await assert.rejects(
      () => getRepositoryConfigSnapshot(git, schemas, dir),
      (error: unknown) => error instanceof Error && error.message.includes("Invalid JSON"),
    );
  } finally {
    removeRepo(dir);
  }
});

test("a non-git directory throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-repoconfig-test-notgit-"));
  try {
    await assert.rejects(() => getRepositoryConfigSnapshot(git, schemas, dir));
  } finally {
    removeRepo(dir);
  }
});
