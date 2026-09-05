// End-to-end CLI tests: spawns `node src/cli/main.ts <command>` exactly the way a
// real caller (or the plugin-surface wrappers) would, and checks exit codes plus
// JSON shape. This is deliberately a real subprocess, not a direct function call,
// so it also proves `node <file>.ts` runs without a build step.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { REPO_ROOT, SCHEMA_FIXTURES_DIR } from "./paths.ts";

const MAIN_TS = fileURLToPath(new URL("./main.ts", import.meta.url));
const FIXTURES_DIR = join(REPO_ROOT, "poc", "typescript", "fixtures");

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [MAIN_TS, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = error as { status: number | null; stdout: string; stderr: string };
    return { exitCode: execError.status ?? 1, stdout: execError.stdout, stderr: execError.stderr };
  }
}

test("doctor --json reports node/git/config checks and exits 0 in a healthy environment", () => {
  const result = runCli(["doctor", "--json"]);
  const summary = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ name: string; status: string }> };
  assert.equal(result.exitCode, summary.ok ? 0 : 3);
  const names = summary.checks.map((check) => check.name).sort();
  assert.deepEqual(names, ["config", "git", "node-version"]);
});

test("probe --json prints a JSON object with the documented fields and exits 0", () => {
  const result = runCli(["probe", "--json"]);
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  for (const field of ["platform", "release", "nodeVersion", "pathSep", "pathDelimiter", "userConfigDir", "defaultDataDir"]) {
    assert.ok(field in report, `expected probe output to include "${field}"`);
  }
});

test("validate exits 0 for a conforming fixture and 2 for a non-conforming one", () => {
  const validResult = runCli(["validate", "review-result", join(SCHEMA_FIXTURES_DIR, "review.valid.json")]);
  assert.equal(validResult.exitCode, 0);

  const invalidResult = runCli(["validate", "review-result", join(FIXTURES_DIR, "untrusted-sample.json")]);
  assert.equal(invalidResult.exitCode, 2);
});

test("validate exits 2 with a usage message when arguments are missing", () => {
  const result = runCli(["validate"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Usage: main\.ts validate/);
});

test("config --json prints resolved absolute paths and an explicit overlay is applied", () => {
  const result = runCli(["config", "--json", "--config", join(FIXTURES_DIR, "config-overlay.sample.json")]);
  const output = JSON.parse(result.stdout) as {
    valid: boolean;
    sources: string[];
    resolvedPaths: { worktreeRoot: string; artifactRoot: string };
    config: { workflow: { maxFixAttempts: number } };
  };
  assert.equal(result.exitCode, 0);
  assert.equal(output.valid, true);
  assert.equal(output.config.workflow.maxFixAttempts, 1);
  assert.ok(!output.resolvedPaths.artifactRoot.includes("{repository}"));
  assert.ok(!output.resolvedPaths.worktreeRoot.includes("%"), "worktreeRoot must not contain an unexpanded %VAR% token");
  assert.ok(output.sources.some((source) => source.includes("config-overlay.sample.json")));
});

test("an unknown subcommand prints usage and exits 2", () => {
  const result = runCli(["not-a-real-command"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Usage: main\.ts/);
});
