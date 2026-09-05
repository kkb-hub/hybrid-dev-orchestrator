// Pure ports of `Merge-HdoRepositoryConfig` and `Assert-HdoRepositoryRoutingSafety`
// (Configuration.ps1). Reading `.hdo/config.json` from disk/Git and computing its
// sha256 is a `git`/`cli` concern (see src/git/repositoryConfig.ts); this module only
// knows how to merge an already-parsed repository config object and check routing
// safety against an already-resolved config.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { findKeyIgnoreCase, getValue } from "./value.ts";
import { deepMergeConfig } from "./merge.ts";

/**
 * Matches the ordered-dictionary shape `Get-HdoRepositoryConfigSnapshot` returns
 * (same key names, same order). `value` is present while the snapshot is being
 * built/consulted, but is removed before the snapshot is embedded in the resolved
 * config (`Get-HdoConfig` does `[void]$repositoryConfig.Remove('value')`) - hence
 * optional here rather than on a separate "public" type.
 */
export interface RepositoryConfigSnapshot {
  loaded: boolean;
  ignored: boolean;
  path: string;
  revision: string;
  commit: string | null;
  blob: string | null;
  sha256: string | null;
  value?: JsonObject | null;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepCloneObject(value: JsonObject): JsonObject {
  const clone: JsonObject = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (Array.isArray(v)) clone[key] = v.slice();
    else if (isPlainObject(v)) clone[key] = deepCloneObject(v);
    else clone[key] = v;
  }
  return clone;
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * Merges a committed `.hdo/config.json` (`repositoryConfig`) onto `base`, enforcing
 * the runner routing constraints `Merge-HdoRepositoryConfig` enforces: a new runner
 * must declare `type`/`provider`/`sandbox`/`timeoutSeconds`; an existing `command`
 * runner cannot be touched at all; an existing runner's `type` cannot change; the
 * effective type must be `codex` or `claude`; and a brand-new repository runner is
 * given `command = type`, `passEnvironment = []`, `extraArgs = []` (repository config
 * never declares executables/env/args - schemas/hdo-repository-config.schema.json
 * excludes those keys entirely).
 */
export function mergeRepositoryConfig(base: JsonObject, repositoryConfig: JsonObject): JsonObject {
  const normalized = deepCloneObject(repositoryConfig);
  if (Object.prototype.hasOwnProperty.call(normalized, "$schema")) {
    delete normalized["$schema"];
  }

  const runners = normalized.runners;
  if (isPlainObject(runners)) {
    const baseRunners = isPlainObject(base.runners) ? base.runners : {};
    for (const runnerName of Object.keys(runners)) {
      const repositoryRunner = runners[runnerName];
      if (!isPlainObject(repositoryRunner)) continue;
      // `$Base.runners.Contains($runnerName)` is case-insensitive in PowerShell.
      const matchedBaseRunnerKey = findKeyIgnoreCase(baseRunners, runnerName);
      const baseRunner =
        matchedBaseRunnerKey !== undefined && isPlainObject(baseRunners[matchedBaseRunnerKey])
          ? baseRunners[matchedBaseRunnerKey]
          : null;

      if (baseRunner === null) {
        const requiredKeys = ["type", "provider", "sandbox", "timeoutSeconds"];
        const missingRunnerKeys = requiredKeys.filter(
          (key) => !Object.prototype.hasOwnProperty.call(repositoryRunner, key),
        );
        if (missingRunnerKeys.length > 0) {
          throw new Error(
            `Repository runner '${runnerName}' is new and must declare ${missingRunnerKeys.join(", ")} in .hdo/config.json.`,
          );
        }
      }

      const repositoryType = asString(getValue(repositoryRunner, "type", ""));
      const baseType = baseRunner !== null ? asString(getValue(baseRunner, "type", "")) : "";
      if (baseRunner !== null && baseType === "command") {
        throw new Error(
          `Repository configuration cannot modify command runner '${runnerName}'. Define or select command runners in user or explicit configuration.`,
        );
      }
      if (repositoryType && baseType && repositoryType !== baseType) {
        throw new Error(
          `Repository configuration cannot change runner '${runnerName}' from type '${baseType}' to '${repositoryType}'.`,
        );
      }
      const effectiveType = repositoryType || baseType;
      if (effectiveType !== "codex" && effectiveType !== "claude") {
        throw new Error(`Repository runner '${runnerName}' must use a built-in codex or claude adapter.`);
      }
      if (baseRunner === null) {
        repositoryRunner["command"] = effectiveType;
        repositoryRunner["passEnvironment"] = [];
        repositoryRunner["extraArgs"] = [];
      }
    }
  }

  return deepMergeConfig(base, normalized);
}

/**
 * Rejects a committed repository config that routes any profile/step it touches
 * (its own `activeProfile` plus every key of its own `profiles`) to a `command`
 * runner in the already-merged `config` - a repository cannot silently redirect
 * work to an arbitrary local executable.
 *
 * PowerShell builds `profileNames`/looks up `Config.profiles`/`Config.runners` via
 * hashtables, whose string-key comparisons are case-insensitive by default. A
 * profile/runner name reaching this function normally comes from schema-validated
 * (lowercase-only) config, but `deepMergeConfig` folding a case-variant key (see
 * merge.ts) or a repository config naming a profile/runner with different casing
 * than the base config can still leave differently-cased lookups here - so this
 * port uses `findKeyIgnoreCase` (value.ts) for both `Config.profiles` and
 * `Config.runners`, matching the hashtable semantics exactly rather than relying on
 * every name being lowercase.
 */
export function assertRepositoryRoutingSafety(config: JsonObject, repositoryConfig: JsonObject): void {
  const profileNames = new Set<string>();
  if (typeof repositoryConfig.activeProfile === "string") profileNames.add(repositoryConfig.activeProfile);
  const repositoryProfiles = repositoryConfig.profiles;
  if (isPlainObject(repositoryProfiles)) {
    for (const profileName of Object.keys(repositoryProfiles)) profileNames.add(profileName);
  }

  const configProfiles = isPlainObject(config.profiles) ? config.profiles : {};
  const configRunners = isPlainObject(config.runners) ? config.runners : {};

  for (const profileName of profileNames) {
    // `$Config.profiles.Contains($profileName)` is case-insensitive in PowerShell.
    const matchedProfileKey = findKeyIgnoreCase(configProfiles, profileName);
    const profile = matchedProfileKey !== undefined ? configProfiles[matchedProfileKey] : undefined;
    if (!isPlainObject(profile)) continue;
    for (const stepName of ["plan", "implement", "review", "fix"]) {
      const binding = getValue(profile, `steps.${stepName}`);
      if (binding === undefined || binding === null) continue;
      let enabled = true;
      let runnerName: string;
      if (typeof binding === "string") {
        runnerName = binding;
      } else if (isPlainObject(binding)) {
        enabled = Boolean(getValue(binding, "enabled", true));
        runnerName = asString(getValue(binding, "runner", ""));
      } else {
        continue;
      }
      // `$Config.runners.Contains($runnerName)` is case-insensitive in PowerShell.
      const matchedRunnerKey = runnerName ? findKeyIgnoreCase(configRunners, runnerName) : undefined;
      if (!enabled || !runnerName || matchedRunnerKey === undefined) continue;
      const runner = configRunners[matchedRunnerKey];
      if (isPlainObject(runner) && asString(getValue(runner, "type", "")) === "command") {
        throw new Error(
          `Repository configuration cannot route profile '${profileName}' step '${stepName}' to command runner '${runnerName}'. Select command runners only with explicit configuration or -SetStep.`,
        );
      }
    }
  }
}
