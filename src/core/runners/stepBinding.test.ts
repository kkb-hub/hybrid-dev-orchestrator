// No run-tests.ps1 coverage exists for `Get-HdoStepBinding` directly (it is exercised
// only indirectly, through `Get-HdoExecutionPlan`); every assertion below is derived
// straight from the PowerShell source (Runner.ps1:1-16) instead, cited by line.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getStepBinding } from "./stepBinding.ts";

function config(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    steps: {
      plan: "claude-planner",
      implement: { enabled: true, runner: "Claude-Implementer" },
      review: { enabled: false, runner: "claude-reviewer" },
      fix: { enabled: true },
    },
    runners: {
      "claude-planner": { type: "claude" },
      "claude-implementer": { type: "claude" },
      "claude-reviewer": { type: "claude" },
    },
    ...overrides,
  };
}

// Oracle: Runner.ps1:7, "if (-not $Config.steps.Contains($Step)) { return [ordered]@{ enabled = $false; runnerName = $null; runner = $null } }".
test("missing step returns { enabled: false, runnerName: null, runner: null }", () => {
  assert.deepEqual(getStepBinding(config(), "cleanup"), { enabled: false, runnerName: null, runner: null });
});

// Oracle: Runner.ps1:9, "if ($binding -is [string]) { $enabled = $true; $runnerName = $binding }".
test("a string binding is enabled and names its runner", () => {
  assert.deepEqual(getStepBinding(config(), "plan"), {
    enabled: true,
    runnerName: "claude-planner",
    runner: { type: "claude" },
  });
});

// Oracle: Runner.ps1:14, "runner = if ($enabled) { ... } else { $null }" - runnerName is
// NOT forced to null when the object binding itself is disabled.
test("a disabled object binding keeps its runnerName but reports runner: null", () => {
  assert.deepEqual(getStepBinding(config(), "review"), {
    enabled: false,
    runnerName: "claude-reviewer",
    runner: null,
  });
});

// Oracle: Runner.ps1:10, "$runnerName = [string](Get-HdoValue $binding 'runner' '')"
// (note: '', not null, when the object binding declares no `runner`).
test("an enabled object binding without a `runner` key resolves runnerName to '' and runner to null", () => {
  assert.deepEqual(getStepBinding(config(), "fix"), { enabled: true, runnerName: "", runner: null });
});

// Oracle: Runner.ps1:7, `$Config.steps.Contains($Step)` is case-insensitive on a
// PowerShell `[ordered]` dictionary (ADR-0001 phase 5 plan §7 risk 1).
test("the step name lookup is case-insensitive ('Plan' resolves the 'plan' key)", () => {
  assert.deepEqual(getStepBinding(config(), "Plan"), getStepBinding(config(), "plan"));
});

// Oracle: Runner.ps1:14, `$Config.runners[$runnerName]` is case-insensitive on a
// PowerShell `[ordered]` dictionary (ADR-0001 phase 5 plan §7 risk 1) - a runner
// referenced as `Claude-Implementer` resolves the `claude-implementer` definition.
test("the runner name lookup is case-insensitive ('Claude-Implementer' resolves 'claude-implementer')", () => {
  assert.deepEqual(getStepBinding(config(), "implement"), {
    enabled: true,
    runnerName: "Claude-Implementer",
    runner: { type: "claude" },
  });
});

test("an enabled binding naming an unknown runner resolves runner to null", () => {
  assert.deepEqual(getStepBinding(config({ steps: { plan: "no-such-runner" } }), "plan"), {
    enabled: true,
    runnerName: "no-such-runner",
    runner: null,
  });
});

test("missing steps/runners containers are treated as empty (no throw)", () => {
  assert.deepEqual(getStepBinding({}, "plan"), { enabled: false, runnerName: null, runner: null });
});
