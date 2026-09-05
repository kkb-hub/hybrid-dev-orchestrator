// End-to-end test of resolveHdoConfig with in-memory sources (no filesystem/git),
// using the REAL schemas/hdo-config.schema.json and schemas/hdo-repository-config
// .schema.json (read from disk - this is a *.test.ts file, exempt from the core
// boundary rule) so schema validation is not faked away.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../contracts/schemas.ts";
import type { SchemaObject } from "../contracts/validate.ts";
import type { JsonObject } from "../contracts/types.ts";
import type { RepositoryConfigSnapshot } from "./repository.ts";
import { resolveHdoConfig, type NamedConfigSource, type ResolveConfigHost, type ResolveConfigInput } from "./resolve.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();

const host: ResolveConfigHost = {
  pathEquals: (a, b) => a === b,
  isPathWithinRoot: (child, root) => {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return child !== root && child.startsWith(prefix);
  },
  expandPath: (raw, repositoryPath) => (raw.startsWith("/") ? raw : `${repositoryPath}/${raw}`),
};

function githubBlock(): JsonObject {
  return {
    labels: {
      ready: "hdo:ready",
      skip: "hdo:skip",
      statusPrefix: "hdo:status/",
      claimed: "hdo:status/claimed",
      implementing: "hdo:status/implementing",
      review: "hdo:status/review",
      changesRequested: "hdo:status/changes-requested",
      approved: "hdo:status/approved",
      escalated: "hdo:status/blocked",
      failed: "hdo:status/failed",
      cancelled: "hdo:status/cancelled",
    },
    priorityOrder: ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"],
    writeBack: "status",
    candidateLimit: 50,
    assignOnClaim: true,
  };
}

function workflowBlock(): JsonObject {
  return { maxFixAttempts: 2, implicitFallback: false, onNoDiff: "fail", onValidationFailure: "request-changes", onMaxFixAttempts: "escalate" };
}

function baseDefaultConfig(): JsonObject {
  return {
    schemaVersion: 1,
    activeProfile: "base",
    profiles: {
      base: { steps: { plan: "review-a", implement: "impl-a", review: "review-a", fix: "impl-a" } },
      override: { steps: { plan: "review-a", implement: "impl-a", review: "review-a", fix: "impl-a" } },
    },
    runners: {
      "impl-a": {
        type: "codex",
        provider: "cloud",
        command: "codex",
        sandbox: "workspace-write",
        timeoutSeconds: 900,
        passEnvironment: [],
        extraArgs: [],
      },
      "review-a": {
        type: "codex",
        provider: "cloud",
        command: "codex",
        sandbox: "read-only",
        timeoutSeconds: 900,
        passEnvironment: [],
        extraArgs: [],
      },
    },
    github: githubBlock(),
    workflow: workflowBlock(),
    paths: { worktreeRoot: "/data/worktrees", artifactRoot: "/data/runs" },
    projectContractPath: ".hdo/project.json",
  };
}

function notLoadedSnapshot(repositoryPath: string): RepositoryConfigSnapshot {
  return {
    loaded: false,
    ignored: true,
    path: `${repositoryPath}/.hdo/config.json`,
    revision: "HEAD",
    commit: null,
    blob: null,
    sha256: null,
  };
}

function baseInput(overrides: Partial<ResolveConfigInput> = {}): ResolveConfigInput {
  return {
    defaultConfig: { origin: "default.json", value: baseDefaultConfig() },
    repositorySnapshot: notLoadedSnapshot("/repo"),
    explicitConfigs: [],
    overrides: {},
    stepOverrides: {},
    repositoryPath: "/repo",
    host,
    schemas,
    ...overrides,
  };
}

test("resolveHdoConfig with only defaults: resolvedProfile/steps come from activeProfile", () => {
  const result = resolveHdoConfig(baseInput());
  assert.equal(result.resolvedProfile, "base");
  assert.deepEqual(result.configSources, ["default.json"]);
  assert.equal((result.steps as JsonObject).implement, "impl-a");
});

test("merge order: user config overrides default", () => {
  const userConfig: NamedConfigSource = { origin: "user.json", value: { runners: { "impl-a": { model: "user-model" } } } };
  const result = resolveHdoConfig(baseInput({ userConfig }));
  assert.equal(((result.runners as JsonObject)["impl-a"] as JsonObject).model, "user-model");
  assert.deepEqual(result.configSources, ["default.json", "user.json"]);
});

test("merge order: repository config overrides user config", () => {
  const userConfig: NamedConfigSource = { origin: "user.json", value: { runners: { "impl-a": { model: "user-model" } } } };
  const repositorySnapshot: RepositoryConfigSnapshot = {
    loaded: true,
    ignored: false,
    path: "/repo/.hdo/config.json",
    revision: "HEAD",
    commit: "abc123",
    blob: "def456",
    sha256: "sha",
    value: { schemaVersion: 1, runners: { "impl-a": { type: "codex", model: "repo-model" } } },
  };
  const result = resolveHdoConfig(baseInput({ userConfig, repositorySnapshot }));
  assert.equal(((result.runners as JsonObject)["impl-a"] as JsonObject).model, "repo-model");
  assert.deepEqual(result.configSources, ["default.json", "user.json", "/repo/.hdo/config.json"]);
});

test("merge order: explicit -Config overrides repository config", () => {
  const repositorySnapshot: RepositoryConfigSnapshot = {
    loaded: true,
    ignored: false,
    path: "/repo/.hdo/config.json",
    revision: "HEAD",
    commit: "abc123",
    blob: "def456",
    sha256: "sha",
    value: { schemaVersion: 1, runners: { "impl-a": { type: "codex", model: "repo-model" } } },
  };
  const explicitConfigs: NamedConfigSource[] = [{ origin: "explicit.json", value: { runners: { "impl-a": { model: "explicit-model" } } } }];
  const result = resolveHdoConfig(baseInput({ repositorySnapshot, explicitConfigs }));
  assert.equal(((result.runners as JsonObject)["impl-a"] as JsonObject).model, "explicit-model");
  assert.deepEqual(result.configSources, ["default.json", "/repo/.hdo/config.json", "explicit.json"]);
});

test("merge order: programmatic overrides beat explicit -Config", () => {
  const explicitConfigs: NamedConfigSource[] = [{ origin: "explicit.json", value: { runners: { "impl-a": { model: "explicit-model" } } } }];
  const overrides: JsonObject = { runners: { "impl-a": { model: "override-model" } } };
  const result = resolveHdoConfig(baseInput({ explicitConfigs, overrides }));
  assert.equal(((result.runners as JsonObject)["impl-a"] as JsonObject).model, "override-model");
});

test("merge order: -Profile beats the merged activeProfile", () => {
  const userConfig: NamedConfigSource = { origin: "user.json", value: {} };
  const result = resolveHdoConfig(baseInput({ userConfig, profile: "override" }));
  assert.equal(result.resolvedProfile, "override");
});

test("merge order: -SetStep beats the profile-selected runner for that step only", () => {
  const explicitConfigs: NamedConfigSource[] = [
    {
      origin: "explicit.json",
      value: {
        runners: {
          "review-b": {
            type: "codex",
            provider: "cloud",
            command: "codex",
            sandbox: "read-only",
            timeoutSeconds: 900,
            passEnvironment: [],
            extraArgs: [],
          },
        },
      },
    },
  ];
  const result = resolveHdoConfig(baseInput({ explicitConfigs, stepOverrides: { review: "review-b" } }));
  const steps = result.steps as JsonObject;
  assert.equal(steps.review, "review-b");
  assert.equal(steps.implement, "impl-a", "untouched steps are unaffected by -SetStep");
});

test("an unknown -SetStep name throws", () => {
  assert.throws(() => resolveHdoConfig(baseInput({ stepOverrides: { bogus: "impl-a" } })), /Unknown step override 'bogus'\./);
});

test("repositoryConfig on the resolved config has the snapshot shape WITHOUT 'value'", () => {
  const repositorySnapshot: RepositoryConfigSnapshot = {
    loaded: true,
    ignored: false,
    path: "/repo/.hdo/config.json",
    revision: "HEAD",
    commit: "abc123",
    blob: "def456",
    sha256: "shasha",
    value: { schemaVersion: 1 },
  };
  const result = resolveHdoConfig(baseInput({ repositorySnapshot }));
  const embedded = result.repositoryConfig as JsonObject;
  assert.equal(Object.prototype.hasOwnProperty.call(embedded, "value"), false);
  assert.deepEqual(embedded, {
    loaded: true,
    ignored: false,
    path: "/repo/.hdo/config.json",
    revision: "HEAD",
    commit: "abc123",
    blob: "def456",
    sha256: "shasha",
  });
});

// Note: "activeProfile or -Profile must be specified." (Configuration.ps1's
// Get-HdoConfig) is unreachable through resolveHdoConfig's public entry point in
// practice: schemas/hdo-config.schema.json requires `activeProfile` as a non-empty,
// pattern-matched top-level property, and that schema check runs BEFORE this
// resolve.ts reaches its own profile-name check - so a config that would trip this
// message always fails schema validation first instead. The check is still ported
// faithfully (mirroring the PowerShell source exactly) for defensive-depth/future
// schema changes; it is simply not independently exercisable end-to-end today.

test("an undefined profile name throws", () => {
  assert.throws(() => resolveHdoConfig(baseInput({ profile: "no-such-profile" })), /Profile 'no-such-profile' is not defined\./);
});

test("schema-invalid merged config throws with the documented message prefix", () => {
  // assert.throws() matches a RegExp against the thrown value's own String() form
  // ("Error: <message>"), not bare `.message` - a plain callback predicate is used
  // here instead so the prefix can be anchored to the actual message text.
  const userConfig: NamedConfigSource = { origin: "user.json", value: { extraTopLevelPropertyNotInSchema: true } };
  assert.throws(
    () => resolveHdoConfig(baseInput({ userConfig })),
    (error: unknown) => error instanceof Error && error.message.startsWith("Configuration schema validation failed: "),
  );
});

// PowerShell's `$profiles.Contains($profileName)`/`$runners.Contains($runnerName)` are
// case-insensitive; these three tests exercise the case-insensitive lookups ported
// into resolveHdoConfig (profile selection, -SetStep, and runner references it writes).

test("-Profile 'Claude-Only' resolves case-insensitively and echoes the typed casing in resolvedProfile", () => {
  const defaultConfig: NamedConfigSource = {
    origin: "default.json",
    value: {
      ...baseDefaultConfig(),
      profiles: {
        ...(baseDefaultConfig().profiles as JsonObject),
        "claude-only": { steps: { plan: "review-a", implement: "impl-a", review: "review-a", fix: "impl-a" } },
      },
    },
  };
  const result = resolveHdoConfig(baseInput({ defaultConfig, profile: "Claude-Only" }));
  assert.equal(result.resolvedProfile, "Claude-Only");
});

test("-SetStep IMPLEMENT=impl-a is accepted case-insensitively and stored under the typed step name", () => {
  const result = resolveHdoConfig(baseInput({ stepOverrides: { IMPLEMENT: "impl-a" } }));
  const steps = result.steps as JsonObject;
  assert.equal(steps.IMPLEMENT, "impl-a");
  assert.equal(Object.prototype.hasOwnProperty.call(steps, "implement"), false, "the lowercase key must not survive alongside it");
});

test("-SetStep IMPLEMENT=impl-a keeps the entry at its original position (OrderedDictionary in-place rename)", () => {
  // baseDefaultConfig's "base" profile defines steps plan/implement/review/fix, in
  // that order; -SetStep IMPLEMENT=... must rewrite the "implement" entry's key
  // text without moving it to the end.
  const result = resolveHdoConfig(baseInput({ stepOverrides: { IMPLEMENT: "impl-a" } }));
  const steps = result.steps as JsonObject;
  assert.deepEqual(Object.keys(steps), ["plan", "IMPLEMENT", "review", "fix"]);
});

test("a runner reference with different casing than its definition still validates", () => {
  // "plan" requires a read-only runner; "REVIEW-A" is "review-a" (read-only) with
  // different casing, so this only exercises the case-insensitive runner lookup
  // (not a sandbox mismatch).
  const result = resolveHdoConfig(baseInput({ stepOverrides: { plan: "REVIEW-A" } }));
  const steps = result.steps as JsonObject;
  assert.equal(steps.plan, "REVIEW-A");
});

test("semantically invalid resolved config throws 'Configuration is invalid:' with each error on its own line", () => {
  // paths.worktreeRoot === repositoryPath is schema-valid (the schema only requires
  // a non-empty string) but semantically invalid - exercising validateConfiguration
  // itself rather than Ajv's schema check.
  const defaultConfig: NamedConfigSource = {
    origin: "default.json",
    value: { ...baseDefaultConfig(), paths: { worktreeRoot: "/repo", artifactRoot: "/data/runs" } },
  };
  assert.throws(
    () => resolveHdoConfig(baseInput({ defaultConfig })),
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith("Configuration is invalid:\n - paths.worktreeRoot must be outside repositoryPath."),
  );
});
