// Pure port of `Get-HdoExecutionPlan` (Configuration.ps1). `generatedAt` is injected
// so this stays pure (no `node:` timestamp source) - the caller passes an ISO 8601
// UTC string in the same format as `Get-HdoUtcTimestamp`
// (`[DateTimeOffset]::UtcNow.ToString('o')`, e.g. `2026-09-05T13:27:06.1581406+00:00`).
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { findKeyIgnoreCase, getValue, setKeyIgnoreCase } from "./value.ts";

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

export interface ExecutionPlanStep {
  enabled: boolean;
  runner: string | null;
  type?: string;
  provider?: string;
  model?: JsonValue;
  reasoningEffort?: JsonValue;
  contextTokens?: JsonValue;
  sandbox?: JsonValue;
  timeoutSeconds?: JsonValue;
}

export interface ExecutionPlan {
  schemaVersion: 1;
  profile: JsonValue;
  repositoryPath: JsonValue;
  generatedAt: string;
  implicitFallback: false;
  steps: Record<string, ExecutionPlanStep>;
  runners: Record<string, JsonObject>;
}

export function getExecutionPlan(config: JsonObject, generatedAt: string): ExecutionPlan {
  const resolvedSteps: Record<string, ExecutionPlanStep> = {};
  const referencedRunners: Record<string, JsonObject> = {};

  const steps = isPlainObject(config.steps) ? config.steps : {};
  const runners = isPlainObject(config.runners) ? config.runners : {};

  for (const stepName of ["plan", "implement", "review", "fix"]) {
    // See validate.ts: `$steps.Contains(...)`/`$steps[...]` are case-insensitive on
    // PowerShell's OrderedDictionary, and -SetStep can leave a differently-cased key.
    const matchedStepKey = findKeyIgnoreCase(steps, stepName);
    if (matchedStepKey === undefined) continue;
    const binding = steps[matchedStepKey];
    let enabled = true;
    let runnerName: string | null = null;
    if (typeof binding === "string") {
      runnerName = binding;
    } else if (isPlainObject(binding)) {
      enabled = Boolean(getValue(binding, "enabled", true));
      runnerName = asString(getValue(binding, "runner", ""));
    }
    if (!enabled) {
      resolvedSteps[stepName] = { enabled: false, runner: null };
      continue;
    }
    // `-SetStep` can reference a runner with different casing than its definition;
    // `$runners[$runnerName]` on PowerShell's OrderedDictionary resolves that
    // case-insensitively, so this lookup must too.
    const matchedRunnerKey = runnerName ? findKeyIgnoreCase(runners, runnerName) : undefined;
    const runner =
      matchedRunnerKey !== undefined && isPlainObject(runners[matchedRunnerKey]) ? (runners[matchedRunnerKey] as JsonObject) : {};
    resolvedSteps[stepName] = {
      enabled: true,
      runner: runnerName,
      type: asString(runner.type),
      provider: asString(getValue(runner, "provider", "cloud"), "cloud"),
      // Get-HdoValue's default is $null, and ConvertTo-Json keeps a null-valued key;
      // JSON.stringify instead DROPS an `undefined`-valued key entirely, so `null`
      // must be the explicit fallback here (not `getValue`'s own `undefined`
      // default) to keep these keys present in the JSON output like PowerShell does.
      model: getValue(runner, "model") ?? null,
      reasoningEffort: getValue(runner, "reasoningEffort") ?? null,
      contextTokens: getValue(runner, "contextTokens") ?? null,
      sandbox: runner.sandbox,
      timeoutSeconds: runner.timeoutSeconds,
    };
    // `$plan.runners[$runnerName] = $runner` on PowerShell's OrderedDictionary: a
    // runner referenced by an earlier step under one casing and a later step under
    // another casing folds into a SINGLE entry, at the FIRST-referenced position,
    // keyed with the LAST-assigned casing (an in-place rename, not a move) - see
    // setKeyIgnoreCase (value.ts).
    if (runnerName) setKeyIgnoreCase(referencedRunners, runnerName, runner);
  }

  return {
    schemaVersion: 1,
    profile: config.resolvedProfile ?? null,
    repositoryPath: config.repositoryPath ?? null,
    generatedAt,
    implicitFallback: false,
    steps: resolvedSteps,
    runners: referencedRunners,
  };
}
