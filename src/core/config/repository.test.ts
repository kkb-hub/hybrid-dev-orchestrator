import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { assertRepositoryRoutingSafety, mergeRepositoryConfig } from "./repository.ts";

function baseConfig(): JsonObject {
  return {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: {
      default: { steps: { plan: "planner", implement: "implementer", review: "reviewer", fix: "implementer" } },
    },
    runners: {
      planner: { type: "codex", provider: "cloud", command: "codex", sandbox: "read-only", timeoutSeconds: 900, passEnvironment: [], extraArgs: [] },
      implementer: {
        type: "claude",
        provider: "cloud",
        command: "claude",
        sandbox: "workspace-write",
        timeoutSeconds: 3600,
        passEnvironment: [],
        extraArgs: [],
      },
      reviewer: { type: "codex", provider: "cloud", command: "codex", sandbox: "read-only", timeoutSeconds: 1200, passEnvironment: [], extraArgs: [] },
      "local-runner": {
        type: "command",
        provider: "custom",
        command: "pwsh",
        sandbox: "workspace-write",
        timeoutSeconds: 1800,
        passEnvironment: [],
        extraArgs: [],
      },
    },
  };
}

test("mergeRepositoryConfig strips $schema before merging", () => {
  const base = baseConfig();
  const merged = mergeRepositoryConfig(base, { $schema: "https://example/schema.json", schemaVersion: 1, activeProfile: "default" });
  assert.equal((merged as JsonObject).$schema, undefined);
  assert.equal(merged.activeProfile, "default");
});

test("mergeRepositoryConfig requires a new runner to declare type/provider/sandbox/timeoutSeconds", () => {
  const base = baseConfig();
  assert.throws(
    () => mergeRepositoryConfig(base, { schemaVersion: 1, runners: { brandNew: { type: "codex" } } }),
    /Repository runner 'brandNew' is new and must declare provider, sandbox, timeoutSeconds in \.hdo\/config\.json\./,
  );
});

test("mergeRepositoryConfig rejects modifying an existing command runner", () => {
  const base = baseConfig();
  assert.throws(
    () => mergeRepositoryConfig(base, { schemaVersion: 1, runners: { "local-runner": { type: "command" } } }),
    /Repository configuration cannot modify command runner 'local-runner'\. Define or select command runners in user or explicit configuration\./,
  );
});

test("mergeRepositoryConfig rejects changing an existing runner's type", () => {
  const base = baseConfig();
  assert.throws(
    () => mergeRepositoryConfig(base, { schemaVersion: 1, runners: { planner: { type: "claude" } } }),
    /Repository configuration cannot change runner 'planner' from type 'codex' to 'claude'\./,
  );
});

test("mergeRepositoryConfig rejects an effective type that is not codex or claude", () => {
  const base = baseConfig();
  assert.throws(
    () => mergeRepositoryConfig(base, { schemaVersion: 1, runners: { newOne: { type: "command", provider: "cloud", sandbox: "read-only", timeoutSeconds: 900 } } }),
    /Repository runner 'newOne' must use a built-in codex or claude adapter\./,
  );
});

test("mergeRepositoryConfig gives a brand-new runner command=type, empty passEnvironment/extraArgs", () => {
  const base = baseConfig();
  const merged = mergeRepositoryConfig(base, {
    schemaVersion: 1,
    runners: { fresh: { type: "codex", provider: "cloud", sandbox: "read-only", timeoutSeconds: 900 } },
  });
  const runners = merged.runners as JsonObject;
  const fresh = runners.fresh as JsonObject;
  assert.equal(fresh.command, "codex");
  assert.deepEqual(fresh.passEnvironment, []);
  assert.deepEqual(fresh.extraArgs, []);
});

test("mergeRepositoryConfig allows overriding an existing codex/claude runner's routing fields", () => {
  const base = baseConfig();
  const merged = mergeRepositoryConfig(base, {
    schemaVersion: 1,
    runners: { planner: { type: "codex", model: "gpt-x", timeoutSeconds: 500 } },
  });
  const planner = (merged.runners as JsonObject).planner as JsonObject;
  assert.equal(planner.model, "gpt-x");
  assert.equal(planner.timeoutSeconds, 500);
  assert.equal(planner.command, "codex", "unrelated fields from base survive the merge");
});

test("assertRepositoryRoutingSafety rejects routing a touched profile's step to a command runner", () => {
  // assertRepositoryRoutingSafety reads the step->runner mapping from the ALREADY
  // -MERGED `config` (as Merge-HdoRepositoryConfig would have produced it just
  // before this check runs); `repositoryConfig` here only supplies which
  // profile names were touched (its own activeProfile/profiles keys).
  const config = baseConfig();
  ((config.profiles as JsonObject).default as JsonObject).steps = { implement: "local-runner" };
  const repositoryConfig: JsonObject = {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: { default: { steps: { implement: "local-runner" } } },
  };
  assert.throws(
    () => assertRepositoryRoutingSafety(config, repositoryConfig),
    /Repository configuration cannot route profile 'default' step 'implement' to command runner 'local-runner'\. Select command runners only with explicit configuration or -SetStep\./,
  );
});

test("assertRepositoryRoutingSafety allows routing to a non-command runner", () => {
  const config = baseConfig();
  const repositoryConfig: JsonObject = {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: { default: { steps: { implement: "implementer" } } },
  };
  assert.doesNotThrow(() => assertRepositoryRoutingSafety(config, repositoryConfig));
});

test("assertRepositoryRoutingSafety ignores profiles the repository config never mentions", () => {
  const config = baseConfig();
  // repositoryConfig touches nothing (no activeProfile, no profiles) - even though
  // config.profiles.default routes to nothing risky, this proves untouched profiles
  // are never inspected at all.
  assert.doesNotThrow(() => assertRepositoryRoutingSafety(config, { schemaVersion: 1 }));
});

test("assertRepositoryRoutingSafety skips a disabled step binding", () => {
  const config = baseConfig();
  (config.profiles as JsonObject).default = { steps: { implement: { enabled: false } } };
  const repositoryConfig: JsonObject = { schemaVersion: 1, activeProfile: "default" };
  assert.doesNotThrow(() => assertRepositoryRoutingSafety(config, repositoryConfig));
});

// PowerShell's `$dict.Contains($name)`/`$dict[$name]` on an OrderedDictionary/Hashtable
// is case-insensitive regardless of platform; these two tests exercise the
// case-insensitive lookups ported into mergeRepositoryConfig/assertRepositoryRoutingSafety.

test("mergeRepositoryConfig matches an existing base runner case-insensitively (not treated as brand-new)", () => {
  const base = baseConfig();
  const runners = base.runners as JsonObject;
  runners.Planner = runners.planner;
  delete runners.planner;
  // No type/provider/sandbox/timeoutSeconds declared here - if this were (incorrectly)
  // treated as a brand-new runner it would throw "is new and must declare ...".
  const merged = mergeRepositoryConfig(base, {
    schemaVersion: 1,
    runners: { planner: { model: "gpt-y" } },
  });
  const mergedRunners = merged.runners as JsonObject;
  // `Merge-HdoHashtable` folds a case-variant override key into the base entry's
  // OrderedDictionary slot using the OVERRIDE's casing - there is exactly one
  // runner key here ('planner', not 'Planner'), carrying both the base runner's
  // untouched fields and the override's new field. Its position is wherever the
  // fixture's own `delete runners.planner; runners.Planner = ...` left it (last -
  // that manual rename is itself an append, same as a PowerShell
  // `$dict.Remove()`+`$dict.Add()` pair would be), not the base config's original
  // position.
  assert.deepEqual(Object.keys(mergedRunners), ["implementer", "reviewer", "local-runner", "planner"]);
  const planner = mergedRunners.planner as JsonObject;
  assert.equal(planner.type, "codex");
  assert.equal(planner.command, "codex");
  assert.equal(planner.model, "gpt-y");
});

test("assertRepositoryRoutingSafety matches profile/runner names case-insensitively", () => {
  const config = baseConfig();
  const profiles = config.profiles as JsonObject;
  profiles.Default = profiles.default;
  delete profiles.default;
  ((profiles.Default as JsonObject).steps as JsonObject) = { implement: "Local-Runner" };
  const runners = config.runners as JsonObject;
  runners["Local-Runner"] = runners["local-runner"];
  delete runners["local-runner"];
  const repositoryConfig: JsonObject = {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: { default: { steps: { implement: "local-runner" } } },
  };
  assert.throws(
    () => assertRepositoryRoutingSafety(config, repositoryConfig),
    /Repository configuration cannot route profile 'default' step 'implement' to command runner 'Local-Runner'\. Select command runners only with explicit configuration or -SetStep\./,
  );
});
