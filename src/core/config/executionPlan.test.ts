import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getExecutionPlan } from "./executionPlan.ts";

function baseConfig(): JsonObject {
  return {
    resolvedProfile: "default",
    repositoryPath: "/repo",
    steps: {
      plan: { enabled: false },
      implement: "implementer",
      review: { enabled: true, runner: "reviewer" },
      fix: "implementer",
    },
    runners: {
      implementer: {
        type: "claude",
        provider: "cloud",
        command: "claude",
        model: "sonnet",
        sandbox: "workspace-write",
        timeoutSeconds: 3600,
        passEnvironment: [],
        extraArgs: [],
      },
      reviewer: {
        type: "codex",
        provider: "cloud",
        command: "codex",
        sandbox: "read-only",
        timeoutSeconds: 1200,
        passEnvironment: [],
        extraArgs: [],
      },
    },
  };
}

test("getExecutionPlan carries schemaVersion/profile/repositoryPath/implicitFallback/generatedAt through", () => {
  const plan = getExecutionPlan(baseConfig(), "2026-01-01T00:00:00.000Z");
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.profile, "default");
  assert.equal(plan.repositoryPath, "/repo");
  assert.equal(plan.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(plan.implicitFallback, false);
});

test("getExecutionPlan reports a disabled step as { enabled: false, runner: null } with no other fields", () => {
  const plan = getExecutionPlan(baseConfig(), "now");
  assert.deepEqual(plan.steps.plan, { enabled: false, runner: null });
});

test("getExecutionPlan resolves an enabled step to its runner's routing fields, with null for absent optional fields", () => {
  const plan = getExecutionPlan(baseConfig(), "now");
  assert.deepEqual(plan.steps.implement, {
    enabled: true,
    runner: "implementer",
    type: "claude",
    provider: "cloud",
    model: "sonnet",
    reasoningEffort: null,
    contextTokens: null,
    sandbox: "workspace-write",
    timeoutSeconds: 3600,
  });
});

test("getExecutionPlan resolves an object-form step binding (enabled+runner)", () => {
  const plan = getExecutionPlan(baseConfig(), "now");
  assert.deepEqual(plan.steps.review, {
    enabled: true,
    runner: "reviewer",
    type: "codex",
    provider: "cloud",
    model: null,
    reasoningEffort: null,
    contextTokens: null,
    sandbox: "read-only",
    timeoutSeconds: 1200,
  });
});

test("getExecutionPlan only includes runners that are actually referenced by an enabled step", () => {
  const config = baseConfig();
  (config.runners as JsonObject).unused = {
    type: "claude",
    provider: "cloud",
    command: "claude",
    sandbox: "read-only",
    timeoutSeconds: 900,
    passEnvironment: [],
    extraArgs: [],
  };
  const plan = getExecutionPlan(config, "now");
  assert.deepEqual(Object.keys(plan.runners).sort(), ["implementer", "reviewer"]);
});

test("getExecutionPlan omits a step entirely when it is absent from config.steps", () => {
  const config = baseConfig();
  delete (config.steps as JsonObject).plan;
  const plan = getExecutionPlan(config, "now");
  assert.equal(Object.prototype.hasOwnProperty.call(plan.steps, "plan"), false);
});

test("getExecutionPlan folds a runner referenced with different casing by two steps into one entry, keyed with the LAST casing, at the FIRST position", () => {
  // "implement" references "Claude-Implementer" (checked first, in STEP_NAMES
  // order); "fix" references "claude-implementer" (same runner, different casing).
  // PowerShell's OrderedDictionary assignment folds these into a single entry at
  // the position "implement" first inserted it, keyed with "fix"'s casing (the
  // last assignment wins on casing, in place).
  const config: JsonObject = {
    resolvedProfile: "default",
    repositoryPath: "/repo",
    steps: {
      implement: "Claude-Implementer",
      review: "reviewer",
      fix: "claude-implementer",
    },
    runners: {
      "claude-implementer": {
        type: "claude",
        provider: "cloud",
        command: "claude",
        sandbox: "workspace-write",
        timeoutSeconds: 3600,
        passEnvironment: [],
        extraArgs: [],
      },
      reviewer: {
        type: "codex",
        provider: "cloud",
        command: "codex",
        sandbox: "read-only",
        timeoutSeconds: 1200,
        passEnvironment: [],
        extraArgs: [],
      },
    },
  };
  const plan = getExecutionPlan(config, "now");
  assert.deepEqual(Object.keys(plan.runners), ["claude-implementer", "reviewer"]);
});
