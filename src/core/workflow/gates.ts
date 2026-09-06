// Pure port of the gate-classification half of `Invoke-HdoValidation`
// (Runner.ps1:843-934), plus the Issue #16 fix ("setup failure always stops
// remaining gates, regardless of `continueAfterFailure`") that lands in TS and
// PowerShell together (ADR-0001 phase 6 plan §2.6, "Validation result"). The
// host half (`src/workflow/validation.ts`) drives an actual `ProcessRunner`
// through the gate list, calls these pure helpers for every decision, and
// writes the files; nothing here touches the filesystem, a clock, or a
// process.
//
// Classification order (plan §2.6, both implementations; Runner.ps1:889-899
// pre-#16, with the fix applied):
//   1. the process runner threw before a process could start (command not
//      found, ProcessStartInfo failure, ...)              -> indeterminate / setup
//   2. the process started but timed out                  -> indeterminate / timeout
//   3. exit code is in `exitCodes.passed` (default [0])    -> pass / null
//   4. exit code is in `exitCodes.failed` (default [])     -> fail / product
//   5. otherwise                                           -> indeterminate / unclassified
//   6. a gate that never ran because a previous gate
//      requested (or forced) a stop                        -> indeterminate / skipped
// `failureClass: 'setup'` (case 1) always stops the remaining gates, even when
// the gate's own `continueAfterFailure` is `true` (Issue #16 AC-02) - a setup
// failure means HDO could not even determine whether the product is broken,
// so continuing would run later gates against an unverified worktree/tooling
// state. Every other non-passing status (timeout, product, unclassified)
// keeps following `continueAfterFailure` exactly like the pre-#16 runtime
// (AC-03, AC-04).
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import { asNumber, asString, equalsIgnoreCase, hdoArrayItems, isPlainObject, isTruthy } from "../runners/psSemantics.ts";
import { expandArgumentTemplate } from "../runners/argumentTemplate.ts";
import { protectText } from "../process/redact.ts";

export type GateStatus = "pass" | "fail" | "indeterminate";
export type GateFailureClass = "product" | "setup" | "timeout" | "unclassified" | "skipped" | null;

export interface GateResult {
  id: string;
  required: boolean;
  status: GateStatus;
  failureClass: GateFailureClass;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  skipped: boolean;
  durationMs: number;
  artifact: string;
}

export interface ValidationSummary {
  allRequiredPassed: boolean;
  passed: number;
  failed: number;
  indeterminate: number;
  gates: GateResult[];
  completedAt: string;
}

/**
 * Oracle: Runner.ps1:852-853, `foreach ($gate in @(Get-HdoValue $ProjectContract
 * 'validationGates' @())) { $gateMap[[string]$gate.id] = $gate }`. A JS `Map` (unlike
 * the PowerShell hashtable it mirrors) compares keys by exact string identity, so a
 * lookup against a possibly differently-cased gate id (an Issue's `validationGates`
 * entry) must go through `findGate`, not `map.get(id)`.
 */
export function buildGateMap(projectContract: JsonObject): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const gate of hdoArrayItems(getValue(projectContract, "validationGates", []))) {
    if (isPlainObject(gate)) {
      map.set(asString(gate.id), gate);
    }
  }
  return map;
}

/** Case-insensitive `$gateMap.ContainsKey(...)`/`$gateMap[...]` lookup (PS hashtable keys are case-insensitive). */
export function findGate(map: Map<string, JsonObject>, id: string): JsonObject | undefined {
  for (const [key, value] of map) {
    if (equalsIgnoreCase(key, id)) return value;
  }
  return undefined;
}

function toNumberArray(value: JsonValue | undefined): number[] {
  return hdoArrayItems(value).map((entry) => asNumber(entry, 0));
}

export interface GateInvocation {
  command: string;
  args: string[];
  artifactCommand: string;
  artifactArguments: string[];
  timeoutSeconds: number;
  workingDirectoryRelative: string;
  passedCodes: number[];
  failedCodes: number[];
  required: boolean;
  continueAfterFailure: boolean;
}

/**
 * Resolves everything Runner.ps1:857-874 and :892-896, :910, :919 compute from a
 * gate definition before invoking it: the raw command/args used to actually spawn the
 * process, the redacted `artifactCommand`/`artifactArguments` used for the result
 * object and the log file, and the gate's own policy knobs (all schema-defaulted the
 * same way `Get-HdoValue` defaults them).
 */
export function resolveGateInvocation(gate: JsonObject, worktreePath: string): GateInvocation {
  // Oracle: Runner.ps1:872, `[string]$gate.command`.
  const command = asString(gate.command);
  // Oracle: Runner.ps1:870-871, `$tokens = [ordered]@{ worktree = $WorktreePath }`;
  // `$arguments = @((Get-HdoValue $gate 'args' @()) | ForEach-Object { Expand-HdoArgumentTemplate ([string]$_) $tokens })`.
  const args = hdoArrayItems(getValue(gate, "args", [])).map((entry) =>
    expandArgumentTemplate(asString(entry), { worktree: worktreePath }),
  );
  // Oracle: Runner.ps1:872-873, `Protect-HdoText` applied to the command and each expanded argument.
  const artifactCommand = protectText(command);
  const artifactArguments = args.map((entry) => protectText(entry));
  // Oracle: Runner.ps1:874, `$timeout = [int](Get-HdoValue $gate 'timeoutSeconds' 900)`.
  const timeoutSeconds = Math.trunc(asNumber(getValue(gate, "timeoutSeconds", 900), 900));
  // Oracle: Runner.ps1:859, `$relativeWorkingDirectory = [string](Get-HdoValue $gate 'workingDirectory' '.')`.
  const workingDirectoryRelative = asString(getValue(gate, "workingDirectory", "."), ".");
  // Oracle: Runner.ps1:894-895, `@(Get-HdoValue $gate 'exitCodes.passed' @(0))` / `'exitCodes.failed' @()`.
  const passedCodes = toNumberArray(getValue(gate, "exitCodes.passed", [0]));
  const failedCodes = toNumberArray(getValue(gate, "exitCodes.failed", []));
  // Oracle: Runner.ps1:880, :910, `[bool](Get-HdoValue $gate 'required' $true)`.
  const required = isTruthy(getValue(gate, "required", true));
  // Oracle: Runner.ps1:919, `[bool](Get-HdoValue $gate 'continueAfterFailure' $true)`.
  const continueAfterFailure = isTruthy(getValue(gate, "continueAfterFailure", true));
  return {
    command,
    args,
    artifactCommand,
    artifactArguments,
    timeoutSeconds,
    workingDirectoryRelative,
    passedCodes,
    failedCodes,
    required,
    continueAfterFailure,
  };
}

/**
 * The two shapes a gate invocation can end in: `threw` when the process runner
 * itself failed before (or instead of) producing a process result (command not
 * found, `ProcessStartInfo` failure, or any other exception - Runner.ps1:901-903's
 * `catch` block), or `exited` for a normal `Invoke-HdoProcess` result, timed out or
 * not.
 */
export type GateProcessOutcome =
  | { kind: "threw"; message: string }
  | { kind: "exited"; exitCode: number; timedOut: boolean; stdout: string; stderr: string; durationMs: number };

/**
 * Classification order (plan §2.6 rules 1-5; the Issue #16 fix over
 * Runner.ps1:896-899's pre-fix `if ($processResult.timedOut) { ... } elseif ... else
 * { 'indeterminate' }`, which used to fold "process runner threw" into the same
 * generic `indeterminate` bucket as "unclassified exit code" with no distinct
 * `failureClass`): a thrown/unstartable process is `setup`, independent of exit
 * codes; only once a process actually started and finished (or timed out) do exit
 * codes get consulted.
 */
export function classifyGateOutcome(
  outcome: GateProcessOutcome,
  passedCodes: number[],
  failedCodes: number[],
): { status: GateStatus; failureClass: GateFailureClass } {
  if (outcome.kind === "threw") {
    return { status: "indeterminate", failureClass: "setup" };
  }
  if (outcome.timedOut) {
    return { status: "indeterminate", failureClass: "timeout" };
  }
  if (passedCodes.includes(outcome.exitCode)) {
    return { status: "pass", failureClass: null };
  }
  if (failedCodes.includes(outcome.exitCode)) {
    return { status: "fail", failureClass: "product" };
  }
  return { status: "indeterminate", failureClass: "unclassified" };
}

/**
 * Issue #16 AC-02/AC-03/AC-04: a `setup` failure always stops the remaining gates,
 * regardless of `continueAfterFailure`; every other non-passing status (`timeout`,
 * `product`, `unclassified`) follows the gate's own `continueAfterFailure` exactly
 * like the pre-#16 runtime (Runner.ps1:919's `if ($status -ne 'pass' -and -not
 * [bool](Get-HdoValue $gate 'continueAfterFailure' $true)) { $stopRemaining = $true }`).
 */
export function shouldStopRemaining(status: GateStatus, failureClass: GateFailureClass, continueAfterFailure: boolean): boolean {
  return status !== "pass" && (failureClass === "setup" || !continueAfterFailure);
}

/** Builds the `GateResult` for a gate that actually ran (`skipped: false` always - see `skippedGateResult` for the other case). */
export function buildGateResult(params: {
  id: string;
  required: boolean;
  status: GateStatus;
  failureClass: GateFailureClass;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  artifact: string;
}): GateResult {
  // Oracle: Runner.ps1:908-918, key order `id, required, status, command, exitCode,
  // timedOut, skipped, durationMs, artifact`, with `failureClass` (#16) inserted right
  // after `status` per plan §2.6.
  return {
    id: params.id,
    required: params.required,
    status: params.status,
    failureClass: params.failureClass,
    command: params.command,
    exitCode: params.exitCode,
    timedOut: params.timedOut,
    skipped: false,
    durationMs: params.durationMs,
    artifact: params.artifact,
  };
}

/** Oracle: Runner.ps1:877-888, the entry recorded for a gate that never ran because a previous gate requested a stop. */
export function skippedGateResult(id: string, required: boolean, command: string[], artifact: string): GateResult {
  return {
    id,
    required,
    status: "indeterminate",
    failureClass: "skipped",
    command,
    exitCode: null,
    timedOut: false,
    skipped: true,
    durationMs: 0,
    artifact,
  };
}

/**
 * Oracle: Runner.ps1:906, `Protect-HdoText "command: $artifactCommand
 * $($artifactArguments -join ' ')`n exitCode: $($processResult.exitCode)`n status:
 * $status`n`nSTDOUT`n$($processResult.stdout)`nSTDERR`n$($processResult.stderr)"`,
 * with a `failureClass:` line (#16) inserted right after `status:` per plan §2.6. The
 * caller (host `validation.ts`) applies `protectText` to the whole returned string -
 * this function only composes the text, matching stdout/stderr not yet being
 * redacted at this point in the PowerShell oracle. `exitCode: ` interpolates `$null`
 * as the empty string, mirrored here as `exitCode === null ? "" : String(exitCode)`.
 * Joining an empty `artifactArguments` array with the command still leaves the
 * trailing space PowerShell's `"$artifactCommand $(... -join ' ')"` produces.
 */
export function formatGateLog(
  artifactCommand: string,
  artifactArguments: string[],
  exitCode: number | null,
  status: GateStatus,
  failureClass: GateFailureClass,
  stdout: string,
  stderr: string,
): string {
  const exitCodeText = exitCode === null ? "" : String(exitCode);
  const failureClassText = failureClass === null ? "" : failureClass;
  return [
    `command: ${artifactCommand} ${artifactArguments.join(" ")}`,
    `exitCode: ${exitCodeText}`,
    `status: ${status}`,
    `failureClass: ${failureClassText}`,
    "",
    "STDOUT",
    stdout,
    "STDERR",
    stderr,
  ].join("\n");
}

/**
 * Oracle: Runner.ps1:877 writes the single-quoted (and therefore literally-broken,
 * per plan §5 item 15) string `'status: indeterminate`nreason: skipped after a
 * previous gate requested stop'`; WP-P fixes the PowerShell side to a real newline
 * while touching the block for #16, and this TS port never reproduces the bug (plan
 * §2.6/§5 item 15). `afterSetupFailure` distinguishes the two reasons #16 AC-06
 * requires: a gate skipped because an earlier gate's OWN `continueAfterFailure` was
 * `false` reads "requested stop"; a gate skipped because an earlier gate suffered a
 * `setup` failure (which always stops, AC-02) reads "failed to start".
 */
export function formatSkippedGateLog(afterSetupFailure: boolean): string {
  const reason = afterSetupFailure
    ? "skipped after a previous gate failed to start"
    : "skipped after a previous gate requested stop";
  return ["status: indeterminate", "failureClass: skipped", `reason: ${reason}`].join("\n");
}

/**
 * Oracle: Runner.ps1:923-931. `allRequiredPassed` is true iff no REQUIRED gate has a
 * non-`pass` status (a non-required gate never affects it, whatever its status);
 * `completedAt` is injected by the host caller (`src/core/**` never reads the clock).
 */
export function summarizeGates(results: GateResult[], completedAt: string): ValidationSummary {
  const requiredFailures = results.filter((result) => result.required && result.status !== "pass");
  return {
    allRequiredPassed: requiredFailures.length === 0,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    indeterminate: results.filter((result) => result.status === "indeterminate").length,
    gates: results,
    completedAt,
  };
}
