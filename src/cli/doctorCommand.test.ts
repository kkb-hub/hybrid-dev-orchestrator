// End-to-end tests of `runDoctorCommand` against the REAL environment (real git,
// real gh/claude/codex if present on PATH, real filesystem) - no process/platform
// mocking. Mirrors the exit-code cases `tests/run-tests.ps1`/`tests/test-cli.ps1`
// assert against the PowerShell oracle: a config overlay pointing a runner command at
// something that cannot possibly resolve (test-cli.ps1:19-23,:41), and a
// `-RepositoryPath` outside any Git repository (test-cli.ps1:42).
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { runDoctorCommand } from "./doctorCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

const platform = getPlatform();
const schemas = loadSchemaRegistry();

test("runDoctorCommand: exit code 3 when a config overlay points a runner command at something unresolvable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-doctorCommand-test-"));
  try {
    const overlayPath = join(dir, "missing-runner.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ runners: { "claude-planner": { command: "hdo-command-that-does-not-exist" } } }),
      "utf8",
    );
    const parsed = parseArgs(["doctor", "-Config", overlayPath, "-DryRun", "-Json", "-RepositoryPath", REPO_ROOT]);
    const { result, exitCode } = await runDoctorCommand({ parsed, platform, schemas });
    assert.equal(exitCode, 3);
    assert.equal(result.ok, false);
    const runnerCheck = result.checks.find((check) => check.name === "runner:claude-planner");
    assert.equal(runnerCheck?.status, "fail");
    assert.equal(runnerCheck?.message, "Runner command 'hdo-command-that-does-not-exist' was not found.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctorCommand: exit code 3 for a -RepositoryPath outside any Git repository", async () => {
  const nonGitDirectory = mkdtempSync(join(tmpdir(), "hdo-doctor-non-git-"));
  try {
    const parsed = parseArgs(["doctor", "-DryRun", "-Json", "-RepositoryPath", nonGitDirectory]);
    const { result, exitCode } = await runDoctorCommand({ parsed, platform, schemas });
    assert.equal(exitCode, 3);
    assert.equal(result.ok, false);
    const gitCheck = result.checks.find((check) => check.name === "git:repository");
    assert.equal(gitCheck?.status, "fail");
  } finally {
    rmSync(nonGitDirectory, { recursive: true, force: true });
  }
});

test("runDoctorCommand: default config against this repository parses as JSON with schemaVersion 1", async () => {
  const parsed = parseArgs(["doctor", "-DryRun", "-Json", "-RepositoryPath", REPO_ROOT]);
  const { result } = await runDoctorCommand({ parsed, platform, schemas });
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.readOnly, true);
  assert.ok(Array.isArray(json.checks) && json.checks.length > 0);
});
