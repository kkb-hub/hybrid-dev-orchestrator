import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import {
  buildGateMap,
  buildGateResult,
  classifyGateOutcome,
  findGate,
  formatGateLog,
  formatSkippedGateLog,
  resolveGateInvocation,
  shouldStopRemaining,
  skippedGateResult,
  summarizeGates,
  type GateProcessOutcome,
  type GateResult,
} from "./gates.ts";

// --- classifyGateOutcome: §2.6 classification order, rows 1-5 -------------

test("classifyGateOutcome: a process runner that threw is 'indeterminate'/'setup' (#16 AC-01/AC-02)", () => {
  const outcome: GateProcessOutcome = { kind: "threw", message: "Command was not found: does-not-exist" };
  assert.deepEqual(classifyGateOutcome(outcome, [0], []), { status: "indeterminate", failureClass: "setup" });
});

test("classifyGateOutcome: timedOut is 'indeterminate'/'timeout' even when the exit code is itself in exitCodes.passed", () => {
  // §2.6 rule 2 runs BEFORE rule 3: a hanging process that the OS eventually reports
  // with an exit code that happens to be listed as 'passed' must still classify as a
  // timeout, not a pass - the gate never actually completed on its own.
  const outcome: GateProcessOutcome = { kind: "exited", exitCode: 124, timedOut: true, stdout: "", stderr: "", durationMs: 900_000 };
  assert.deepEqual(classifyGateOutcome(outcome, [0, 124], []), { status: "indeterminate", failureClass: "timeout" });
});

test("classifyGateOutcome: exit code 0 in exitCodes.passed is 'pass'/null", () => {
  const outcome: GateProcessOutcome = { kind: "exited", exitCode: 0, timedOut: false, stdout: "ok", stderr: "", durationMs: 12 };
  assert.deepEqual(classifyGateOutcome(outcome, [0], []), { status: "pass", failureClass: null });
});

test("classifyGateOutcome: exit code 1 in exitCodes.failed is 'fail'/'product'", () => {
  const outcome: GateProcessOutcome = { kind: "exited", exitCode: 1, timedOut: false, stdout: "", stderr: "assertion failed", durationMs: 30 };
  assert.deepEqual(classifyGateOutcome(outcome, [0], [1]), { status: "fail", failureClass: "product" });
});

test("classifyGateOutcome: an exit code in neither list is 'indeterminate'/'unclassified'", () => {
  const outcome: GateProcessOutcome = { kind: "exited", exitCode: 3, timedOut: false, stdout: "", stderr: "", durationMs: 5 };
  assert.deepEqual(classifyGateOutcome(outcome, [0], [1]), { status: "indeterminate", failureClass: "unclassified" });
});

test("classifyGateOutcome: exit codes are compared as numbers, not their string form", () => {
  // exitCodes.passed comes from schema-valid JSON (numbers); a naive string
  // comparison would fail to match here if either side were coerced inconsistently.
  const outcome: GateProcessOutcome = { kind: "exited", exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs: 1 };
  assert.deepEqual(classifyGateOutcome(outcome, [0], []).status, "pass");
  const unclassified: GateProcessOutcome = { kind: "exited", exitCode: 10, timedOut: false, stdout: "", stderr: "", durationMs: 1 };
  assert.deepEqual(classifyGateOutcome(unclassified, [0], [1]).status, "indeterminate");
});

// --- shouldStopRemaining: #16 truth table ----------------------------------

test("shouldStopRemaining: 'setup' always stops, even with continueAfterFailure=true (#16 AC-02)", () => {
  assert.equal(shouldStopRemaining("indeterminate", "setup", true), true);
  assert.equal(shouldStopRemaining("indeterminate", "setup", false), true);
});

test("shouldStopRemaining: 'product' (fail) with continueAfterFailure=true does not stop (#16 AC-03)", () => {
  assert.equal(shouldStopRemaining("fail", "product", true), false);
});

test("shouldStopRemaining: 'product' (fail) with continueAfterFailure=false stops", () => {
  assert.equal(shouldStopRemaining("fail", "product", false), true);
});

test("shouldStopRemaining: 'timeout' follows continueAfterFailure like any other non-setup failure (#16 AC-04)", () => {
  assert.equal(shouldStopRemaining("indeterminate", "timeout", true), false);
  assert.equal(shouldStopRemaining("indeterminate", "timeout", false), true);
});

test("shouldStopRemaining: 'unclassified' follows continueAfterFailure", () => {
  assert.equal(shouldStopRemaining("indeterminate", "unclassified", true), false);
  assert.equal(shouldStopRemaining("indeterminate", "unclassified", false), true);
});

test("shouldStopRemaining: 'pass' never stops, regardless of continueAfterFailure", () => {
  assert.equal(shouldStopRemaining("pass", null, false), false);
  assert.equal(shouldStopRemaining("pass", null, true), false);
});

// --- resolveGateInvocation --------------------------------------------------

test("resolveGateInvocation expands {worktree} in args and redacts password=... for the artifact copy", () => {
  const gate: JsonObject = {
    id: "gate-secret",
    command: "pwsh",
    args: ["--path={worktree}/foo", "--password=secret123"],
    workingDirectory: "sub",
    timeoutSeconds: 30,
    required: false,
    continueAfterFailure: false,
    exitCodes: { passed: [0, 2], failed: [1] },
  };
  const invocation = resolveGateInvocation(gate, "C:\\repo");
  assert.equal(invocation.command, "pwsh");
  assert.deepEqual(invocation.args, ["--path=C:\\repo/foo", "--password=secret123"]);
  assert.equal(invocation.artifactCommand, "pwsh");
  assert.deepEqual(invocation.artifactArguments, ["--path=C:\\repo/foo", "--password=[REDACTED]"]);
  assert.equal(invocation.workingDirectoryRelative, "sub");
  assert.equal(invocation.timeoutSeconds, 30);
  assert.deepEqual(invocation.passedCodes, [0, 2]);
  assert.deepEqual(invocation.failedCodes, [1]);
  assert.equal(invocation.required, false);
  assert.equal(invocation.continueAfterFailure, false);
});

test("resolveGateInvocation applies every §2.6 default when the gate omits the optional fields", () => {
  const gate: JsonObject = { id: "gate-defaults", command: "pwsh", args: [] };
  const invocation = resolveGateInvocation(gate, "C:\\repo");
  assert.equal(invocation.workingDirectoryRelative, ".");
  assert.equal(invocation.timeoutSeconds, 900);
  assert.deepEqual(invocation.passedCodes, [0]);
  assert.deepEqual(invocation.failedCodes, []);
  assert.equal(invocation.required, true);
  assert.equal(invocation.continueAfterFailure, true);
});

// --- buildGateResult / skippedGateResult / summarizeGates -------------------

function passResult(id: string, required: boolean): GateResult {
  return buildGateResult({ id, required, status: "pass", failureClass: null, command: [id], exitCode: 0, timedOut: false, durationMs: 10, artifact: `${id}.log` });
}

test("buildGateResult never marks a run gate as skipped, and places failureClass right after status", () => {
  const result = buildGateResult({
    id: "gate-fail",
    required: true,
    status: "fail",
    failureClass: "product",
    command: ["pwsh", "-File", "gate.ps1"],
    exitCode: 1,
    timedOut: false,
    durationMs: 42,
    artifact: "gate-fail.log",
  });
  assert.equal(result.skipped, false);
  assert.deepEqual(Object.keys(result), ["id", "required", "status", "failureClass", "command", "exitCode", "timedOut", "skipped", "durationMs", "artifact"]);
});

test("skippedGateResult produces the fixed indeterminate/skipped shape", () => {
  const result = skippedGateResult("gate-after", true, ["pwsh"], "gate-after.log");
  assert.deepEqual(result, {
    id: "gate-after",
    required: true,
    status: "indeterminate",
    failureClass: "skipped",
    command: ["pwsh"],
    exitCode: null,
    timedOut: false,
    skipped: true,
    durationMs: 0,
    artifact: "gate-after.log",
  });
});

test("summarizeGates: allRequiredPassed is false when any REQUIRED gate is non-pass, regardless of optional gates", () => {
  const results: GateResult[] = [
    passResult("gate-a", true),
    buildGateResult({ id: "gate-b", required: true, status: "fail", failureClass: "product", command: ["gate-b"], exitCode: 1, timedOut: false, durationMs: 5, artifact: "gate-b.log" }),
    buildGateResult({ id: "gate-c", required: false, status: "fail", failureClass: "product", command: ["gate-c"], exitCode: 1, timedOut: false, durationMs: 5, artifact: "gate-c.log" }),
    skippedGateResult("gate-d", true, ["gate-d"], "gate-d.log"),
  ];
  const summary = summarizeGates(results, "2026-09-06T00:00:00.000Z");
  assert.equal(summary.allRequiredPassed, false);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.indeterminate, 1);
  assert.equal(summary.gates.length, 4);
  assert.equal(summary.completedAt, "2026-09-06T00:00:00.000Z");
});

test("summarizeGates: allRequiredPassed is true when every required gate passed (optional gates may fail)", () => {
  const results: GateResult[] = [
    passResult("gate-a", true),
    buildGateResult({ id: "gate-c", required: false, status: "fail", failureClass: "product", command: ["gate-c"], exitCode: 1, timedOut: false, durationMs: 5, artifact: "gate-c.log" }),
  ];
  const summary = summarizeGates(results, "2026-09-06T00:00:00.000Z");
  assert.equal(summary.allRequiredPassed, true);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.indeterminate, 0);
});

// --- formatGateLog / formatSkippedGateLog -----------------------------------

test("formatGateLog composes the §2.6 log text with failureClass right after status, and adds no newline beyond what stderr itself supplies", () => {
  const log = formatGateLog("pwsh", ["-File", "gate.ps1"], 1, "fail", "product", "building...", "error: boom");
  assert.equal(
    log,
    ["command: pwsh -File gate.ps1", "exitCode: 1", "status: fail", "failureClass: product", "", "STDOUT", "building...", "STDERR", "error: boom"].join("\n"),
  );
  assert.equal(log.endsWith("\n"), false);
});

test("formatGateLog renders a null exitCode as empty text (PS interpolates $null as empty)", () => {
  const log = formatGateLog("cmd-not-found", [], null, "indeterminate", "setup", "", "Command was not found: cmd-not-found");
  assert.equal(log.startsWith("command: cmd-not-found \n"), true);
  assert.equal(log.includes("exitCode: \n"), true);
  assert.equal(log.includes("failureClass: setup\n"), true);
});

test("formatGateLog: a null failureClass (a passing gate) renders an empty failureClass line", () => {
  const log = formatGateLog("pwsh", [], 0, "pass", null, "ok", "");
  assert.equal(log.includes("\nfailureClass: \n"), true);
});

test("formatSkippedGateLog distinguishes 'requested stop' from 'failed to start' (#16 AC-05/AC-06)", () => {
  assert.equal(formatSkippedGateLog(false), "status: indeterminate\nfailureClass: skipped\nreason: skipped after a previous gate requested stop");
  assert.equal(formatSkippedGateLog(true), "status: indeterminate\nfailureClass: skipped\nreason: skipped after a previous gate failed to start");
});

// --- buildGateMap / findGate -------------------------------------------------

test("buildGateMap indexes gates by id, and findGate looks them up case-insensitively", () => {
  const projectContract: JsonObject = {
    validationGates: [
      { id: "Gate-Pass", command: "pwsh", args: [] },
      { id: "gate-fail", command: "pwsh", args: [] },
    ],
  };
  const map = buildGateMap(projectContract);
  assert.equal(map.size, 2);
  assert.notEqual(findGate(map, "gate-pass"), undefined);
  assert.equal((findGate(map, "GATE-PASS") as JsonObject).id, "Gate-Pass");
  assert.equal(findGate(map, "gate-missing"), undefined);
});

test("buildGateMap defaults to an empty map when validationGates is absent", () => {
  const map = buildGateMap({});
  assert.equal(map.size, 0);
});
