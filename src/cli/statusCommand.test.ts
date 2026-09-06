// End-to-end tests of `runStatusCommand` against the REAL environment (real git,
// real filesystem, this repository's default config) - mirrors hdo.ps1's `status`
// case (hdo.ps1:129-131) and the `doctorCommand.test.ts` pattern (a `-Config` overlay
// pointing `paths.artifactRoot` at a temp directory, `-RepositoryPath` at this repo).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";
import { runStatusCommand } from "./statusCommand.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

const platform = getPlatform();
const schemas = loadSchemaRegistry();

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "hdo-statusCommand-test-"));
}

test("runStatusCommand: throws 'status requires -RunId.' when -RunId is missing", async () => {
  const parsed = parseArgs(["status", "-RepositoryPath", REPO_ROOT]);
  await assert.rejects(
    runStatusCommand({ parsed, platform, schemas }),
    (error: unknown) => error instanceof Error && error.message === "status requires -RunId.",
  );
});

test("runStatusCommand: reads run.json from the resolved paths.artifactRoot", async () => {
  const dir = makeTempDir();
  try {
    const artifactRoot = join(dir, "runs");
    const overlayPath = join(dir, "overlay.json");
    writeFileSync(overlayPath, JSON.stringify({ paths: { artifactRoot } }), "utf8");

    const runId = "issue-7-20260101T000000Z-abcdef01";
    const runDir = join(artifactRoot, runId);
    mkdirSync(runDir, { recursive: true });
    const run = { schemaVersion: 1, id: runId, state: "APPROVED", iteration: 1 };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(run), "utf8");

    const parsed = parseArgs(["status", "-RunId", runId, "-Config", overlayPath, "-RepositoryPath", REPO_ROOT]);
    const result = await runStatusCommand({ parsed, platform, schemas });
    assert.deepEqual(result, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatusCommand: propagates the 'JSON file was not found' text for an unknown -RunId", async () => {
  const dir = makeTempDir();
  try {
    const artifactRoot = join(dir, "runs");
    const overlayPath = join(dir, "overlay.json");
    writeFileSync(overlayPath, JSON.stringify({ paths: { artifactRoot } }), "utf8");

    const parsed = parseArgs(["status", "-RunId", "issue-7-does-not-exist", "-Config", overlayPath, "-RepositoryPath", REPO_ROOT]);
    await assert.rejects(runStatusCommand({ parsed, platform, schemas }), /JSON file was not found: .*issue-7-does-not-exist.*run\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
