// Pure port of `Get-HdoStepBinding` (Runner.ps1:1-16): resolves which runner (if any)
// a profile's `steps.<name>` entry points at, without touching the filesystem or
// spawning anything - hosts use the result to look up the runner adapter to invoke.
import type { JsonObject } from "../contracts/types.ts";
import { findKeyIgnoreCase, getValue } from "../config/value.ts";
import { asString, isPlainObject, isTruthy } from "./psSemantics.ts";

export interface StepBinding {
  enabled: boolean;
  runnerName: string | null;
  runner: JsonObject | null;
}

/**
 * `$Config.steps.Contains($Step)`/`$Config.steps[$Step]` and `$Config.runners[$runnerName]`
 * are both case-insensitive on PowerShell's `[ordered]` dictionaries (ADR-0001 phase 5
 * plan §7 risk 1) - `findKeyIgnoreCase` (value.ts) mirrors that for both lookups here,
 * exactly like `executionPlan.ts:47-70`.
 */
export function getStepBinding(config: JsonObject, step: string): StepBinding {
  const steps = isPlainObject(config.steps) ? config.steps : {};
  const runners = isPlainObject(config.runners) ? config.runners : {};

  // Oracle: Runner.ps1:7, missing step -> `{ enabled = $false; runnerName = $null; runner = $null }`.
  const matchedStepKey = findKeyIgnoreCase(steps, step);
  if (matchedStepKey === undefined) {
    return { enabled: false, runnerName: null, runner: null };
  }

  const binding = steps[matchedStepKey];
  let enabled = true;
  let runnerName = "";
  // Oracle: Runner.ps1:9, a string binding is shorthand for an enabled binding naming
  // that runner. `Get-HdoValue` on a non-string binding falls back to its own defaults
  // when the binding isn't a dictionary (`true`/`''`), so calling it unconditionally on
  // any non-string binding (object, number, array, ...) reproduces Runner.ps1:10 exactly
  // without a separate "is this a plain object" branch.
  if (typeof binding === "string") {
    runnerName = binding;
  } else {
    // Oracle: Runner.ps1:10, "$enabled = [bool](Get-HdoValue $binding 'enabled' $true)";
    // "$runnerName = [string](Get-HdoValue $binding 'runner' '')" (note: '', not null).
    enabled = isTruthy(getValue(binding, "enabled", true));
    runnerName = asString(getValue(binding, "runner", ""));
  }

  if (!enabled) {
    // Oracle: Runner.ps1:14, "runner = if ($enabled) { ... } else { $null }" - runnerName
    // itself is NOT forced to null here, only the runner lookup is skipped.
    return { enabled: false, runnerName, runner: null };
  }

  // Oracle: Runner.ps1:14, "$Config.runners[$runnerName]" - PS indexer returns $null for
  // an unknown key, and case-insensitively for a known one (see function doc comment).
  const matchedRunnerKey = findKeyIgnoreCase(runners, runnerName);
  const runner = matchedRunnerKey !== undefined && isPlainObject(runners[matchedRunnerKey]) ? (runners[matchedRunnerKey] as JsonObject) : null;
  return { enabled: true, runnerName, runner };
}
