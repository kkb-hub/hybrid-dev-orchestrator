// Host half of `Invoke-HdoValidation` (Runner.ps1:843-934): drives an injected
// `ProcessRunner` through the project contract's validation gates named by an
// Issue's `validationGates` list, in order, and writes the per-gate log files plus
// `result.json` into `artifactDirectory`. Every DECISION (classification, stop
// propagation, log/summary text) is delegated to the pure helpers in
// `src/core/workflow/gates.ts`; this module owns only the impure orchestration -
// directory checks via the injected `PlatformAdapter`, process execution via the
// injected `ProcessRunner`, and the two file writes - exactly like `agentStep.ts`
// does for `Invoke-HdoAgentStep` (ADR-0001 phase 5 plan §2 boundary,
// phase 6 plan §WP-E).
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import { getValue } from "../core/config/value.ts";
import { asString, hdoArrayItems } from "../core/runners/psSemantics.ts";
import { protectText } from "../core/process/redact.ts";
import { getSafeEnvironment } from "../core/process/safeEnvironment.ts";
import type { ProcessRunner } from "../core/process/types.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { writeJsonFile, writeTextFile } from "../runners/artifacts.ts";
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
  type ValidationSummary,
} from "../core/workflow/gates.ts";

export interface RunValidationOptions {
  /** Selected Issue's contract - only `validationGates` (the ordered list of gate ids to run) is read. */
  issueContract: JsonObject;
  /** Worktree copy of `.hdo/project.json` - only `validationGates` (the gate definitions) is read. */
  projectContract: JsonObject;
  worktreePath: string;
  artifactDirectory: string;
  processRunner: ProcessRunner;
  platform: PlatformAdapter;
  /** Defaults to `process.env`, matching `Get-HdoSafeEnvironment`'s ambient default. */
  ambientEnvironment?: Record<string, string | undefined>;
  now?: () => string;
}

/** True for a directory, mirroring `Test-Path -LiteralPath ... -PathType Container` (a missing path is not a container). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Port of `Invoke-HdoValidation` (Runner.ps1:843-934), with the Issue #16
 * `failureClass` addition (plan §2.6). For every gate id named by
 * `issueContract.validationGates`, in order: resolve it against
 * `projectContract.validationGates` (Runner.ps1:850, `Unknown validation gate '<id>'.`);
 * compute and validate its working directory (:859-869, all three checks run
 * regardless of whether the gate will actually execute); then either write a
 * "skipped" log/result (a previous gate already requested - or was forced into -a
 * stop) or invoke the gate's command through `processRunner` and classify the
 * outcome. `result.json` is written last, after every gate has been processed.
 */
export async function runValidation(options: RunValidationOptions): Promise<ValidationSummary> {
  const { issueContract, projectContract, worktreePath, artifactDirectory, processRunner, platform } = options;
  const ambientEnvironment = options.ambientEnvironment ?? process.env;
  const now = options.now ?? ((): string => new Date().toISOString());

  // Oracle: Runner.ps1:851.
  mkdirSync(artifactDirectory, { recursive: true });

  const gateMap = buildGateMap(projectContract);
  const worktreeFullPath = resolve(worktreePath);
  const results: GateResult[] = [];
  let stopRemaining = false;
  let stoppedBySetupFailure = false;

  for (const gateIdValue of hdoArrayItems(getValue(issueContract, "validationGates", []))) {
    const gateId = asString(gateIdValue);
    // Oracle: Runner.ps1:857, `if (-not $gateMap.ContainsKey([string]$gateId)) { throw ... }`.
    const gate = findGate(gateMap, gateId);
    if (!gate) throw new Error(`Unknown validation gate '${gateId}'.`);

    // Oracle: Runner.ps1:859-869 - the working-directory checks run for every named
    // gate, whether or not it will actually be invoked (a stop request is only
    // consulted afterward, at :875).
    const relativeWorkingDirectory = asString(getValue(gate, "workingDirectory", "."), ".");
    const gateWorkingDirectory = resolve(join(worktreePath, relativeWorkingDirectory));
    if (
      !platform.pathEquals(gateWorkingDirectory, worktreeFullPath) &&
      !platform.isPathWithinRoot(gateWorkingDirectory, worktreePath)
    ) {
      throw new Error(`Validation gate '${gateId}' workingDirectory escapes the worktree.`);
    }
    if (!isDirectory(gateWorkingDirectory)) {
      throw new Error(`Validation gate '${gateId}' workingDirectory does not exist or is not a directory.`);
    }
    if (platform.isReparsePointInPath(gateWorkingDirectory, worktreePath)) {
      throw new Error(`Validation gate '${gateId}' workingDirectory contains a junction or symbolic-link boundary.`);
    }

    // Oracle: Runner.ps1:870-874.
    const invocation = resolveGateInvocation(gate, worktreePath);
    const command = [invocation.artifactCommand, ...invocation.artifactArguments];
    const logPath = join(artifactDirectory, `${gateId}.log`);

    // Oracle: Runner.ps1:875-889 - a gate that never runs because an earlier gate
    // already requested (or forced) a stop.
    if (stopRemaining) {
      writeTextFile(logPath, formatSkippedGateLog(stoppedBySetupFailure));
      results.push(skippedGateResult(gateId, invocation.required, command, logPath));
      continue;
    }

    // Oracle: Runner.ps1:891-904.
    let outcome: GateProcessOutcome;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let durationMs = 0;
    try {
      const processResult = await processRunner.run({
        command: invocation.command,
        arguments: invocation.args,
        workingDirectory: gateWorkingDirectory,
        timeoutSeconds: invocation.timeoutSeconds,
        environment: getSafeEnvironment(ambientEnvironment),
      });
      stdout = processResult.stdout;
      stderr = processResult.stderr;
      exitCode = processResult.exitCode;
      timedOut = processResult.timedOut;
      durationMs = processResult.durationMs;
      outcome = { kind: "exited", exitCode, timedOut, stdout, stderr, durationMs };
    } catch (error) {
      // Oracle: Runner.ps1:901-903 - the process runner itself threw (command not
      // found, `ProcessStartInfo` failure, ...) before a process result could exist;
      // `stderr` is the redacted exception message, `durationMs`/`exitCode`/`timedOut`
      // stay at their zero/null/false defaults.
      const message = protectText(error instanceof Error ? error.message : String(error));
      stderr = message;
      outcome = { kind: "threw", message };
    }

    // Oracle: Runner.ps1:894-899, with the #16 `failureClass` addition (plan §2.6).
    const { status, failureClass } = classifyGateOutcome(outcome, invocation.passedCodes, invocation.failedCodes);

    // Oracle: Runner.ps1:905-907 - the whole composed log text is redacted again here
    // (idempotent over the already-redacted `stderr` from the `threw` branch above),
    // matching `Protect-HdoText` being applied to the full string, not just `stderr`.
    const log = protectText(
      formatGateLog(invocation.artifactCommand, invocation.artifactArguments, exitCode, status, failureClass, stdout, stderr),
    );
    writeTextFile(logPath, log);

    results.push(
      buildGateResult({
        id: gateId,
        required: invocation.required,
        status,
        failureClass,
        command,
        exitCode,
        timedOut,
        durationMs,
        artifact: logPath,
      }),
    );

    // Oracle: Runner.ps1:919, with the #16 fix (`setup` always stops) applied.
    if (shouldStopRemaining(status, failureClass, invocation.continueAfterFailure)) {
      stopRemaining = true;
      stoppedBySetupFailure = failureClass === "setup";
    }
  }

  // Oracle: Runner.ps1:923-932.
  const summary = summarizeGates(results, now());
  writeJsonFile(join(artifactDirectory, "result.json"), summary as unknown as JsonValue);
  return summary;
}
