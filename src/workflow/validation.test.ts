// Tests for `runValidation` (`Invoke-HdoValidation` host half, Runner.ps1:843-934),
// exercising the §2.6/Issue #16 classification order end to end through the
// `NodeProcessRunner` (for the pass/fail/redaction cases, real `pwsh`, skipped when
// unavailable) and through a scripted `FakeProcessRunner` (for the setup-failure,
// stop-propagation, and timeout cases, which need control a real process cannot
// reliably provide). Per the phase-6 plan §WP-E fixture note, the shared
// `tests/fixtures/workflow/tools/gate-pass.ps1`/`gate-fail.ps1` scripts are owned by a
// concurrently-running package and may not exist yet, so this file writes its own
// tiny pwsh scripts into its own temp directory (or reuses the existing
// `tests/fixtures/runtime/validation-pass.ps1`) instead of depending on them.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../core/contracts/types.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { runValidation } from "./validation.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const VALIDATION_PASS_PS1 = resolvePath(REPO_ROOT, "tests", "fixtures", "runtime", "validation-pass.ps1");
const platform = getPlatform();

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

// --- fixture helpers --------------------------------------------------------

interface Dirs {
  worktreePath: string;
  artifactDirectory: string;
}

function withTempDirs(fn: (dirs: Dirs) => void | Promise<void>): Promise<void> | void {
  const worktreePath = mkdtempSync(join(tmpdir(), "hdo-validation-worktree-"));
  const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-validation-artifacts-"));
  const cleanup = (): void => {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(artifactDirectory, { recursive: true, force: true });
  };
  const result = fn({ worktreePath, artifactDirectory });
  if (result instanceof Promise) {
    return result.then(cleanup, (error) => {
      cleanup();
      throw error;
    });
  }
  cleanup();
  return undefined;
}

function issueContract(gateIds: string[]): JsonObject {
  return { validationGates: gateIds };
}

function projectContract(gates: JsonObject[]): JsonObject {
  return { validationGates: gates };
}

function gate(id: string, overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    id,
    command: "does-not-run-directly",
    args: [],
    workingDirectory: ".",
    timeoutSeconds: 30,
    required: true,
    exitCodes: { passed: [0], failed: [], indeterminate: [2, 124, 125, 126, 127] },
    continueAfterFailure: true,
    ...overrides,
  };
}

function readLog(artifactDirectory: string, id: string): string {
  return readFileSync(join(artifactDirectory, `${id}.log`), "utf8");
}

function readResult(artifactDirectory: string): JsonObject {
  return JSON.parse(readFileSync(join(artifactDirectory, "result.json"), "utf8")) as JsonObject;
}

// --- FakeProcessRunner (setup-failure / stop-propagation / timeout branches) ----

class FakeProcessRunner implements ProcessRunner {
  calls: ProcessRunOptions[] = [];
  private readonly behavior: (options: ProcessRunOptions, callIndex: number) => ProcessResult | Promise<ProcessResult>;
  constructor(behavior: (options: ProcessRunOptions, callIndex: number) => ProcessResult | Promise<ProcessResult>) {
    this.behavior = behavior;
  }
  async run(options: ProcessRunOptions): Promise<ProcessResult> {
    const callIndex = this.calls.length;
    this.calls.push(options);
    return this.behavior(options, callIndex);
  }
}

function fakeResult(options: ProcessRunOptions, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: options.command,
    arguments: options.arguments ?? [],
    exitCode: 0,
    timedOut: false,
    outputLimitExceeded: false,
    outputLimitStream: "",
    outputDrainTimedOut: false,
    maximumOutputBytes: 33554432,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: "",
    stderrPath: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

/** A `ProcessRunner` that must never be invoked - used for the checks that throw before any gate ever runs. */
const NEVER_RUN: ProcessRunner = {
  async run(): Promise<ProcessResult> {
    throw new Error("this gate must never actually run");
  },
};

// --- pre-invocation throws (unknown gate id / escaping / missing directory) ----

test("runValidation: unknown gate id throws before any process runs", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    await assert.rejects(
      runValidation({
        issueContract: issueContract(["ghost-gate"]),
        projectContract: projectContract([]),
        worktreePath,
        artifactDirectory,
        processRunner: NEVER_RUN,
        platform,
      }),
      /Unknown validation gate 'ghost-gate'\./,
    );
  }));

test("runValidation: a workingDirectory that escapes the worktree throws", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    await assert.rejects(
      runValidation({
        issueContract: issueContract(["escaping"]),
        projectContract: projectContract([gate("escaping", { workingDirectory: ".." })]),
        worktreePath,
        artifactDirectory,
        processRunner: NEVER_RUN,
        platform,
      }),
      /Validation gate 'escaping' workingDirectory escapes the worktree\./,
    );
  }));

test("runValidation: a workingDirectory that does not exist throws", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    await assert.rejects(
      runValidation({
        issueContract: issueContract(["missing-dir"]),
        projectContract: projectContract([gate("missing-dir", { workingDirectory: "does-not-exist" })]),
        worktreePath,
        artifactDirectory,
        processRunner: NEVER_RUN,
        platform,
      }),
      /Validation gate 'missing-dir' workingDirectory does not exist or is not a directory\./,
    );
  }));

// --- classification via FakeProcessRunner -----------------------------------

test("runValidation: a process runner that throws classifies as indeterminate/setup and stops remaining gates regardless of continueAfterFailure (#16 AC-02/AC-06)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner(() => {
      throw new Error("Command was not found: does-not-exist-fake-cmd");
    });
    const summary = await runValidation({
      issueContract: issueContract(["setup-fails", "never-reached"]),
      projectContract: projectContract([
        gate("setup-fails", { command: "does-not-exist-fake-cmd", continueAfterFailure: true }),
        gate("never-reached", { continueAfterFailure: true }),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    assert.equal(summary.indeterminate, 2);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.allRequiredPassed, false);
    assert.deepEqual(
      summary.gates.map((result) => ({ id: result.id, status: result.status, failureClass: result.failureClass, skipped: result.skipped })),
      [
        { id: "setup-fails", status: "indeterminate", failureClass: "setup", skipped: false },
        { id: "never-reached", status: "indeterminate", failureClass: "skipped", skipped: true },
      ],
    );
    assert.equal(summary.gates[0].exitCode, null);
    assert.equal(summary.gates[1].exitCode, null);
    // Only one process invocation ever happened - the second gate never ran.
    assert.equal(runner.calls.length, 1);

    const setupLog = readLog(artifactDirectory, "setup-fails");
    assert.match(setupLog, /status: indeterminate/);
    assert.match(setupLog, /failureClass: setup/);
    const skippedLog = readLog(artifactDirectory, "never-reached");
    assert.match(skippedLog, /reason: skipped after a previous gate failed to start/);

    const result = readResult(artifactDirectory);
    assert.equal(result.completedAt, "2026-01-01T00:00:00.000Z");
  }));

test("runValidation: a product failure with continueAfterFailure=false stops remaining gates with a 'requested stop' skipped log (#16 AC-03)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => fakeResult(options, { exitCode: 1 }));
    const summary = await runValidation({
      issueContract: issueContract(["product-fails", "never-reached"]),
      projectContract: projectContract([
        gate("product-fails", { exitCodes: { passed: [0], failed: [1] }, continueAfterFailure: false }),
        gate("never-reached"),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.deepEqual(
      summary.gates.map((result) => ({ id: result.id, status: result.status, failureClass: result.failureClass, skipped: result.skipped })),
      [
        { id: "product-fails", status: "fail", failureClass: "product", skipped: false },
        { id: "never-reached", status: "indeterminate", failureClass: "skipped", skipped: true },
      ],
    );
    assert.equal(runner.calls.length, 1);
    const skippedLog = readLog(artifactDirectory, "never-reached");
    assert.match(skippedLog, /reason: skipped after a previous gate requested stop/);
  }));

test("runValidation: continueAfterFailure=true product failure does NOT stop remaining gates (#16 AC-03)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options, index) => fakeResult(options, { exitCode: index === 0 ? 1 : 0 }));
    const summary = await runValidation({
      issueContract: issueContract(["product-fails", "runs-anyway"]),
      projectContract: projectContract([
        gate("product-fails", { exitCodes: { passed: [0], failed: [1] }, continueAfterFailure: true }),
        gate("runs-anyway"),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(runner.calls.length, 2);
    assert.deepEqual(
      summary.gates.map((result) => ({ id: result.id, status: result.status, skipped: result.skipped })),
      [
        { id: "product-fails", status: "fail", skipped: false },
        { id: "runs-anyway", status: "pass", skipped: false },
      ],
    );
  }));

test("runValidation: a timed-out gate classifies as indeterminate/timeout, following continueAfterFailure like any other non-setup failure (#16 AC-04)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) =>
      fakeResult(options, { exitCode: 124, timedOut: true, durationMs: 900_000 }),
    );
    const summary = await runValidation({
      issueContract: issueContract(["hangs"]),
      projectContract: projectContract([gate("hangs", { exitCodes: { passed: [0, 124], failed: [] } })]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.gates.length, 1);
    assert.equal(summary.gates[0].status, "indeterminate");
    assert.equal(summary.gates[0].failureClass, "timeout");
    assert.equal(summary.gates[0].timedOut, true);
    assert.equal(summary.gates[0].exitCode, 124);
  }));

test("runValidation: an exit code in neither exitCodes list classifies as indeterminate/unclassified", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => fakeResult(options, { exitCode: 3 }));
    const summary = await runValidation({
      issueContract: issueContract(["odd-exit"]),
      projectContract: projectContract([gate("odd-exit", { exitCodes: { passed: [0], failed: [1] } })]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.gates[0].status, "indeterminate");
    assert.equal(summary.gates[0].failureClass, "unclassified");
  }));

test("runValidation: getSafeEnvironment is applied to the gate's environment (GH_TOKEN is stripped, an explicitly allowed variable is not)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => fakeResult(options));
    await runValidation({
      issueContract: issueContract(["env-gate"]),
      projectContract: projectContract([gate("env-gate")]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
      ambientEnvironment: { GH_TOKEN: "ghp_secret", PATH: "/usr/bin", HDO_HARMLESS_VAR: "kept" },
    });
    assert.equal(runner.calls.length, 1);
    const environment = runner.calls[0].environment ?? {};
    assert.equal("GH_TOKEN" in environment, false);
    assert.equal(environment.PATH, "/usr/bin");
    assert.equal(environment.HDO_HARMLESS_VAR, "kept");
  }));

test("runValidation: allRequiredPassed is true when only a non-required gate fails", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => fakeResult(options, { exitCode: 1 }));
    const summary = await runValidation({
      issueContract: issueContract(["optional-fails"]),
      projectContract: projectContract([
        gate("optional-fails", { required: false, exitCodes: { passed: [0], failed: [1] } }),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.allRequiredPassed, true);
    assert.equal(summary.failed, 1);
  }));

// --- real pwsh (skipped when unavailable) -----------------------------------

test("runValidation: a real passing pwsh gate classifies as pass/null", { skip: SKIP_REASON }, () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new NodeProcessRunner({ platform });
    const summary = await runValidation({
      issueContract: issueContract(["real-pass"]),
      projectContract: projectContract([
        gate("real-pass", { command: "pwsh", args: ["-NoProfile", "-File", VALIDATION_PASS_PS1] }),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.gates.length, 1);
    assert.equal(summary.gates[0].status, "pass");
    assert.equal(summary.gates[0].failureClass, null);
    assert.equal(summary.gates[0].exitCode, 0);
    assert.equal(summary.gates[0].skipped, false);
    assert.equal(summary.allRequiredPassed, true);
    const log = readLog(artifactDirectory, "real-pass");
    assert.match(log, /status: pass/);
    assert.match(log, /failureClass: \n/);
  }));

test("runValidation: a real failing pwsh gate classifies as fail/product", { skip: SKIP_REASON }, () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const scriptDir = mkdtempSync(join(tmpdir(), "hdo-validation-scripts-"));
    const failScript = join(scriptDir, "gate-fail.ps1");
    writeFileSync(failScript, "Write-Output 'validation failed'\nexit 1\n", "utf8");
    try {
      const runner = new NodeProcessRunner({ platform });
      const summary = await runValidation({
        issueContract: issueContract(["real-fail"]),
        projectContract: projectContract([
          gate("real-fail", {
            command: "pwsh",
            args: ["-NoProfile", "-File", failScript],
            exitCodes: { passed: [0], failed: [1] },
          }),
        ]),
        worktreePath,
        artifactDirectory,
        processRunner: runner,
        platform,
      });
      assert.equal(summary.gates[0].status, "fail");
      assert.equal(summary.gates[0].failureClass, "product");
      assert.equal(summary.gates[0].exitCode, 1);
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }));

test("runValidation: gate command arguments are redacted from both result.json and the .log artifact", { skip: SKIP_REASON }, () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new NodeProcessRunner({ platform });
    await runValidation({
      issueContract: issueContract(["redaction"]),
      projectContract: projectContract([
        gate("redaction", {
          command: "pwsh",
          args: ["-NoProfile", "-File", VALIDATION_PASS_PS1, "-Value", "password=validation-secret"],
        }),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    const resultText = readFileSync(join(artifactDirectory, "result.json"), "utf8");
    assert.doesNotMatch(resultText, /validation-secret/);
    const logText = readLog(artifactDirectory, "redaction");
    assert.doesNotMatch(logText, /validation-secret/);
  }));

test("runValidation: a workingDirectory equal to the worktree root itself (not just a subdirectory) is accepted", { skip: SKIP_REASON }, () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new NodeProcessRunner({ platform });
    const summary = await runValidation({
      issueContract: issueContract(["at-root"]),
      projectContract: projectContract([
        gate("at-root", { workingDirectory: ".", command: "pwsh", args: ["-NoProfile", "-File", VALIDATION_PASS_PS1] }),
      ]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.gates[0].status, "pass");
  }));

test("runValidation: a gate id defined in the project contract with different case still resolves (case-insensitive gate map)", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => fakeResult(options));
    const summary = await runValidation({
      issueContract: issueContract(["Gate-One"]),
      projectContract: projectContract([gate("gate-one")]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    assert.equal(summary.gates.length, 1);
    assert.equal(summary.gates[0].id, "Gate-One");
    assert.equal(summary.gates[0].status, "pass");
  }));

test("runValidation: creates the artifact directory if it does not already exist", () =>
  withTempDirs(async ({ worktreePath, artifactDirectory }) => {
    rmSync(artifactDirectory, { recursive: true, force: true });
    const runner = new FakeProcessRunner((options) => fakeResult(options));
    await runValidation({
      issueContract: issueContract(["gate-a"]),
      projectContract: projectContract([gate("gate-a")]),
      worktreePath,
      artifactDirectory,
      processRunner: runner,
      platform,
    });
    // If the directory did not get (re-)created, this read would throw.
    const result = readResult(artifactDirectory);
    assert.equal((result.gates as unknown[]).length, 1);
  }));
