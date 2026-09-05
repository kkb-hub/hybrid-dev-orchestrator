// Covers every error/warning rule in `validateConfiguration` (a rule-for-rule port
// of Test-HdoConfiguration, Configuration.ps1) at least once, starting from a
// minimal config built by mutating config/hdo.default.json (loaded from disk - this
// is a *.test.ts file, so it is exempt from the core boundary rule).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../contracts/types.ts";
import { deepMergeConfig } from "./merge.ts";
import { validateConfiguration, type ConfigHost } from "./validate.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, "config", "hdo.default.json");

function loadDefaultConfig(): JsonObject {
  return JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as JsonObject;
}

/** A minimal, resolved-looking valid config: default config + its own active profile merged in, with test-friendly absolute paths (POSIX-style; the host below is a fake, not a real filesystem). */
function buildValidConfig(): JsonObject {
  const raw = loadDefaultConfig();
  const profileName = raw.activeProfile as string;
  const profiles = raw.profiles as JsonObject;
  const merged = deepMergeConfig(raw, profiles[profileName] as JsonObject);
  return {
    ...merged,
    repositoryPath: "/repo",
    projectContractPath: "/repo/.hdo/project.json",
    paths: { worktreeRoot: "/data/worktrees", artifactRoot: "/data/runs" },
  };
}

const host: ConfigHost = {
  pathEquals: (a, b) => a === b,
  isPathWithinRoot: (child, root) => {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return child !== root && child.startsWith(prefix);
  },
};

const BASE = buildValidConfig();

test("the base fixture itself is valid (sanity check for every case below)", () => {
  const result = validateConfiguration(structuredClone(BASE), host);
  assert.deepEqual(result.errors, []);
});

interface Case {
  name: string;
  mutate: (config: JsonObject) => void;
  expectedError?: string;
  expectedWarning?: string;
}

function runners(config: JsonObject): JsonObject {
  return config.runners as JsonObject;
}
function steps(config: JsonObject): JsonObject {
  return config.steps as JsonObject;
}

const cases: Case[] = [
  {
    name: "schemaVersion must be 1",
    mutate: (c) => {
      c.schemaVersion = 2;
    },
    expectedError: "schemaVersion must be 1.",
  },
  {
    name: "workflow.maxFixAttempts out of range",
    mutate: (c) => {
      (c.workflow as JsonObject).maxFixAttempts = 11;
    },
    expectedError: "workflow.maxFixAttempts must be between 0 and 10.",
  },
  {
    name: "github.labels.statusPrefix must be 'hdo:status/'",
    mutate: (c) => {
      (c.github as JsonObject).labels = { ...((c.github as JsonObject).labels as JsonObject), statusPrefix: "wrong:" };
    },
    expectedError: "github.labels.statusPrefix must be 'hdo:status/'.",
  },
  {
    name: "github.labels.ready must be in the hdo: namespace",
    mutate: (c) => {
      (c.github as JsonObject).labels = { ...((c.github as JsonObject).labels as JsonObject), ready: "not-hdo" };
    },
    expectedError: "github.labels.ready must be in the hdo: namespace and outside the status prefix.",
  },
  {
    name: "github.labels.skip must be in the hdo: namespace",
    mutate: (c) => {
      (c.github as JsonObject).labels = { ...((c.github as JsonObject).labels as JsonObject), skip: "not-hdo" };
    },
    expectedError: "github.labels.skip must be in the hdo: namespace and outside the status prefix.",
  },
  {
    name: "github.labels.ready cannot use a route namespace",
    mutate: (c) => {
      (c.github as JsonObject).labels = { ...((c.github as JsonObject).labels as JsonObject), ready: "hdo:route/x" };
    },
    expectedError: "github.labels.ready cannot use a priority, risk, or route label namespace.",
  },
  {
    name: "a managed label configured more than once (ready == skip)",
    mutate: (c) => {
      const labels = (c.github as JsonObject).labels as JsonObject;
      labels.skip = labels.ready;
    },
    expectedError: "GitHub managed label 'hdo:ready' is configured more than once.",
  },
  {
    name: "github.labels.claimed must be below the status prefix",
    mutate: (c) => {
      (c.github as JsonObject).labels = { ...((c.github as JsonObject).labels as JsonObject), claimed: "hdo:other" };
    },
    expectedError: "github.labels.claimed must be a label below 'hdo:status/'.",
  },
  {
    name: "a managed label collides with a fixed catalog label",
    mutate: (c) => {
      const labels = (c.github as JsonObject).labels as JsonObject;
      labels.claimed = "hdo:priority/p0";
    },
    expectedError: "GitHub managed label 'hdo:priority/p0' collides with a fixed catalog label.",
  },
  {
    name: "a managed label collides with a generated route label",
    mutate: (c) => {
      const labels = (c.github as JsonObject).labels as JsonObject;
      const profileName = Object.keys(c.profiles as JsonObject)[0];
      labels.claimed = `hdo:route/${profileName}`;
    },
    expectedError: undefined, // route label text depends on profile name; checked separately below
  },
  {
    name: "github.priorityOrder contains an unsupported label",
    mutate: (c) => {
      (c.github as JsonObject).priorityOrder = ["hdo:priority/p9"];
    },
    expectedError: "github.priorityOrder contains unsupported label 'hdo:priority/p9'.",
  },
  {
    name: "paths.worktreeRoot is required",
    mutate: (c) => {
      (c.paths as JsonObject).worktreeRoot = "";
    },
    expectedError: "paths.worktreeRoot is required.",
  },
  {
    name: "paths.artifactRoot is required",
    mutate: (c) => {
      (c.paths as JsonObject).artifactRoot = "";
    },
    expectedError: "paths.artifactRoot is required.",
  },
  {
    name: "projectContractPath must resolve inside repositoryPath",
    mutate: (c) => {
      c.projectContractPath = "/elsewhere/.hdo/project.json";
    },
    expectedError: "projectContractPath must resolve inside repositoryPath.",
  },
  {
    name: "paths.worktreeRoot must be outside repositoryPath",
    mutate: (c) => {
      (c.paths as JsonObject).worktreeRoot = "/repo/worktrees";
    },
    expectedError: "paths.worktreeRoot must be outside repositoryPath.",
  },
  {
    name: "paths.artifactRoot must be outside repositoryPath",
    mutate: (c) => {
      (c.paths as JsonObject).artifactRoot = "/repo/runs";
    },
    expectedError: "paths.artifactRoot must be outside repositoryPath.",
  },
  {
    name: "paths.worktreeRoot and paths.artifactRoot must not overlap",
    mutate: (c) => {
      (c.paths as JsonObject).artifactRoot = (c.paths as JsonObject).worktreeRoot;
    },
    expectedError: "paths.worktreeRoot and paths.artifactRoot must not overlap.",
  },
  {
    name: "runners must be an object",
    mutate: (c) => {
      c.runners = "not-an-object" as unknown as JsonObject;
    },
    expectedError: "runners must be an object.",
  },
  {
    name: "steps must be an object",
    mutate: (c) => {
      c.steps = null as unknown as JsonObject;
    },
    expectedError: "steps must be an object.",
  },
  {
    name: "steps.implement is required",
    mutate: (c) => {
      delete (c.steps as JsonObject).implement;
    },
    expectedError: "steps.implement is required.",
  },
  {
    name: "steps.review is required",
    mutate: (c) => {
      delete (c.steps as JsonObject).review;
    },
    expectedError: "steps.review is required.",
  },
  {
    name: "steps.fix is required",
    mutate: (c) => {
      delete (c.steps as JsonObject).fix;
    },
    expectedError: "steps.fix is required.",
  },
  {
    name: "a step binding that is neither a string nor an object",
    mutate: (c) => {
      steps(c).plan = 42 as unknown as string;
    },
    expectedError: "steps.plan must be a runner name or an object.",
  },
  {
    name: "only the plan step may be disabled",
    mutate: (c) => {
      steps(c).implement = { enabled: false };
    },
    expectedError: "Only the plan step may be disabled; 'implement' is required.",
  },
  {
    name: "a step references an undefined runner",
    mutate: (c) => {
      steps(c).plan = "no-such-runner";
    },
    expectedError: "steps.plan references undefined runner 'no-such-runner'.",
  },
  {
    name: "runner has unsupported type",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).type = "bogus";
    },
    expectedError: "Runner 'claude-planner' has unsupported type 'bogus'.",
  },
  {
    name: "runner must define command",
    mutate: (c) => {
      delete (runners(c)["claude-planner"] as JsonObject).command;
    },
    expectedError: "Runner 'claude-planner' must define command.",
  },
  {
    name: "runner has unsupported provider",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).provider = "bogus";
    },
    expectedError: "Runner 'claude-planner' has unsupported provider 'bogus'.",
  },
  {
    name: "codex runner cannot use an unsupported provider",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).type = "codex";
      (runners(c)["claude-planner"] as JsonObject).provider = "custom";
    },
    expectedError: "Codex runner 'claude-planner' cannot use provider 'custom'.",
  },
  {
    name: "claude runner cannot use an unsupported provider",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).provider = "lmstudio";
      (runners(c)["claude-planner"] as JsonObject).model = "x";
    },
    expectedError: "Claude runner 'claude-planner' cannot use provider 'lmstudio'.",
  },
  {
    name: "claude runner cannot set contextTokens for a non-ollama provider",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).contextTokens = 65536;
    },
    expectedError:
      "Claude runner 'claude-planner' cannot set contextTokens for provider 'cloud'; the Claude CLI exposes no context-window argument against Anthropic's API. Set provider 'ollama' to let HDO enforce it via a derived local model instead.",
  },
  {
    name: "claude/ollama contextTokens below the usable floor",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.provider = "ollama";
      planner.model = "x";
      planner.contextTokens = 32768;
      delete planner.reasoningEffort;
    },
    expectedError:
      "Claude/Ollama runner 'claude-planner' contextTokens 32768 is below the usable floor of 57344; the Claude CLI reserves 23000 tokens of the declared window before it will send a prompt at all, so smaller windows fail every step with 'Prompt is too long'. Use 65536, or route implement/fix to a cloud runner if the GPU cannot hold that many tokens.",
  },
  {
    name: "claude runner unsupported reasoningEffort",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).reasoningEffort = "minimal";
    },
    expectedError:
      "Claude runner 'claude-planner' reasoningEffort 'minimal' is not supported; the Claude CLI --effort accepts low, medium, high, xhigh, or max and silently ignores other values.",
  },
  {
    name: "claude/ollama cannot set reasoningEffort",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.provider = "ollama";
      planner.model = "x";
      planner.reasoningEffort = "high";
    },
    expectedError: "Claude/Ollama runner 'claude-planner' cannot set reasoningEffort because Claude CLI validates --effort against its cloud model catalog.",
  },
  {
    name: "local runner must define model",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).provider = "ollama";
    },
    expectedError: "Local runner 'claude-planner' must define model.",
  },
  {
    name: "runner sandbox must be read-only or workspace-write",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).sandbox = "bogus";
    },
    expectedError: "Runner 'claude-planner' sandbox must be read-only or workspace-write.",
  },
  {
    name: "plan step must use a read-only runner",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).sandbox = "workspace-write";
    },
    expectedError: "The plan step must use a read-only runner; 'claude-planner' uses 'workspace-write'.",
  },
  {
    name: "implement step must use a workspace-write runner",
    mutate: (c) => {
      (runners(c)["claude-implementer"] as JsonObject).sandbox = "read-only";
    },
    expectedError: "The implement step must use a workspace-write runner; 'claude-implementer' uses 'read-only'.",
  },
  {
    name: "runner timeoutSeconds out of range",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).timeoutSeconds = 0;
    },
    expectedError: "Runner 'claude-planner' timeoutSeconds must be between 1 and 86400.",
  },
  {
    name: "runner declares fallback",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).fallback = ["other-runner"];
    },
    expectedError: "Runner 'claude-planner' declares fallback. Implicit provider/model fallback is not supported.",
  },
  {
    name: "claude runner may not use extraArgs",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).extraArgs = ["--foo"];
    },
    expectedError:
      "Claude runner 'claude-planner' may not use extraArgs; the Claude adapter controls the full claude argument surface. Use a 'command' runner when a custom argument layout is required.",
  },
  {
    name: "extraArgs argument containing a line break",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.type = "codex";
      planner.extraArgs = ["line1\nline2"];
    },
    expectedError: "Runner 'claude-planner' has an argument containing a line break or NUL.",
  },
  {
    name: "extraArgs forbidden argument",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.type = "codex";
      planner.extraArgs = ["--dangerously-bypass-approvals"];
    },
    expectedError: "Runner 'claude-planner' uses forbidden argument '--dangerously-bypass-approvals'.",
  },
  {
    name: "codex runner may not override an adapter-controlled argument",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.type = "codex";
      planner.extraArgs = ["--sandbox=danger-full-access-not-really"];
    },
    expectedError: "Runner 'claude-planner' may not override adapter-controlled argument '--sandbox=danger-full-access-not-really'.",
  },
  {
    name: "extraArgs appears to contain a credential literal",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.type = "codex";
      planner.extraArgs = ["ghp_abcdefghijklmnopqrstuvwxyz123456"];
    },
    expectedError: "Runner 'claude-planner' extraArgs appears to contain a credential literal.",
  },
  {
    name: "promptTransport only allowed with type command",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).promptTransport = "file";
    },
    expectedError: "Runner 'claude-planner' may use promptTransport only with type 'command'.",
  },
  {
    name: "allowedTools only allowed with type claude",
    mutate: (c) => {
      const planner = runners(c)["claude-planner"] as JsonObject;
      planner.type = "codex";
      planner.allowedTools = ["Read"];
    },
    expectedError: "Runner 'claude-planner' may use allowedTools only with type 'claude'.",
  },
  {
    name: "runner must not receive GitHub control-plane credentials",
    mutate: (c) => {
      (runners(c)["claude-planner"] as JsonObject).passEnvironment = ["GITHUB_TOKEN"];
    },
    expectedError: "Runner 'claude-planner' must not receive GitHub control-plane credentials.",
  },
];

for (const testCase of cases) {
  if (!testCase.expectedError) continue;
  test(`validateConfiguration: ${testCase.name}`, () => {
    const config = structuredClone(BASE);
    testCase.mutate(config);
    const result = validateConfiguration(config, host);
    assert.ok(
      result.errors.includes(testCase.expectedError as string),
      `expected error not found for '${testCase.name}'.\nExpected: ${testCase.expectedError}\nGot: ${JSON.stringify(result.errors, null, 2)}`,
    );
  });
}

test("validateConfiguration: a managed label collides with a generated route label", () => {
  const config = structuredClone(BASE);
  const labels = (config.github as JsonObject).labels as JsonObject;
  const profileName = Object.keys(config.profiles as JsonObject)[0];
  labels.claimed = `hdo:route/${profileName}`;
  const result = validateConfiguration(config, host);
  assert.ok(result.errors.includes(`GitHub managed label 'hdo:route/${profileName}' collides with a generated route label.`));
});

test("validateConfiguration: warns (does not error) when a runner explicitly receives a sensitive env var", () => {
  const config = structuredClone(BASE);
  (runners(config)["claude-planner"] as JsonObject).passEnvironment = ["MY_API_KEY"];
  const result = validateConfiguration(config, host);
  assert.equal(result.valid, true, `expected only a warning, got errors: ${JSON.stringify(result.errors)}`);
  assert.ok(result.warnings.includes("Runner 'claude-planner' explicitly receives sensitive environment variable 'MY_API_KEY'."));
});

// PowerShell string operators (-eq/-ne/-match/-notmatch/-like/-notlike) are
// case-insensitive; these overlays exercise every case-insensitivity fix ported into
// validateConfiguration (statusPrefix comparison, namespace/priority regexes, the
// 'below the status prefix' equality check, and the codex adapter-controlled-argument
// regex).

test("validateConfiguration: statusPrefix 'HDO:Status/' is accepted case-insensitively", () => {
  const config = structuredClone(BASE);
  const labels = (config.github as JsonObject).labels as JsonObject;
  labels.statusPrefix = "HDO:Status/";
  const result = validateConfiguration(config, host);
  assert.ok(
    !result.errors.includes("github.labels.statusPrefix must be 'hdo:status/'."),
    `unexpected statusPrefix error: ${JSON.stringify(result.errors)}`,
  );
});

test("validateConfiguration: priorityOrder 'hdo:priority/P0' is accepted case-insensitively", () => {
  const config = structuredClone(BASE);
  (config.github as JsonObject).priorityOrder = ["hdo:priority/P0"];
  const result = validateConfiguration(config, host);
  assert.ok(
    !result.errors.some((e) => e.includes("github.priorityOrder contains unsupported label")),
    `unexpected priorityOrder error: ${JSON.stringify(result.errors)}`,
  );
});

test("validateConfiguration: github.labels.ready 'HDO:Priority/x' is rejected case-insensitively", () => {
  const config = structuredClone(BASE);
  const labels = (config.github as JsonObject).labels as JsonObject;
  labels.ready = "HDO:Priority/x";
  const result = validateConfiguration(config, host);
  assert.ok(result.errors.includes("github.labels.ready cannot use a priority, risk, or route label namespace."));
});

test("validateConfiguration: github.labels.claimed 'HDO:STATUS/' is rejected (equal to statusPrefix, not below it)", () => {
  const config = structuredClone(BASE);
  const labels = (config.github as JsonObject).labels as JsonObject;
  labels.claimed = "HDO:STATUS/";
  const result = validateConfiguration(config, host);
  assert.ok(result.errors.includes("github.labels.claimed must be a label below 'hdo:status/'."));
});

test("validateConfiguration: error message echoes the statusPrefix casing as typed, not lowercased", () => {
  const config = structuredClone(BASE);
  const labels = (config.github as JsonObject).labels as JsonObject;
  labels.statusPrefix = "HDO:Status/";
  labels.claimed = "hdo:status/";
  const result = validateConfiguration(config, host);
  assert.ok(
    result.errors.some((e) => e.includes("'HDO:Status/'")),
    `expected an error mentioning the typed statusPrefix casing, got: ${JSON.stringify(result.errors)}`,
  );
});

test("validateConfiguration: codex extraArgs '-c' and '--SANDBOX=x' are rejected as adapter-controlled case-insensitively", () => {
  const config = structuredClone(BASE);
  const planner = runners(config)["claude-planner"] as JsonObject;
  planner.type = "codex";
  planner.extraArgs = ["-c", "--SANDBOX=x"];
  const result = validateConfiguration(config, host);
  assert.ok(result.errors.includes("Runner 'claude-planner' may not override adapter-controlled argument '-c'."));
  assert.ok(result.errors.includes("Runner 'claude-planner' may not override adapter-controlled argument '--SANDBOX=x'."));
});
