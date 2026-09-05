// Pure core of `Get-HdoConfig` (Configuration.ps1): the composition root has already
// read every file this needs (default/user/repository/explicit configs), split and
// trimmed `-Config`'s comma list, and expanded+read each explicit path in order (a
// read failure surfaces with the PowerShell message text - "JSON file was not found:
// <path>" / "Invalid JSON in '<path>': ..." - from that reading step, not from here).
// This module performs exactly the merge/validate/resolve sequence, in the same
// order PowerShell does it.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import type { SchemaRegistry } from "../contracts/schemas.ts";
import { findKeyIgnoreCase, getValue, setKeyIgnoreCase } from "./value.ts";
import { deepMergeConfig } from "./merge.ts";
import { mergeRepositoryConfig, assertRepositoryRoutingSafety, type RepositoryConfigSnapshot } from "./repository.ts";
import { validateConfiguration, type ConfigHost } from "./validate.ts";

export interface NamedConfigSource {
  origin: string;
  value: JsonObject;
}

export interface ResolveConfigHost extends ConfigHost {
  /** `Expand-HdoPath` equivalent, injected so core never touches the filesystem/env. */
  expandPath(raw: string, repositoryPath: string): string;
}

export interface ResolveConfigInput {
  defaultConfig: NamedConfigSource;
  userConfig?: NamedConfigSource;
  /** Already resolved by the composition root (`ignored`/`loaded` set correctly). */
  repositorySnapshot: RepositoryConfigSnapshot;
  /** Already read, in the exact order `-Config a,b` should apply them (left to right). */
  explicitConfigs: NamedConfigSource[];
  overrides: JsonObject;
  profile?: string;
  stepOverrides: Record<string, string>;
  repositoryPath: string;
  host: ResolveConfigHost;
  schemas: SchemaRegistry;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STEP_NAMES = ["plan", "implement", "review", "fix"];

export function resolveHdoConfig(input: ResolveConfigInput): JsonObject {
  let config: JsonObject = input.defaultConfig.value;
  const sources: string[] = [input.defaultConfig.origin];

  if (input.userConfig) {
    config = deepMergeConfig(config, input.userConfig.value);
    sources.push(input.userConfig.origin);
  }

  const repositorySnapshot = input.repositorySnapshot;
  if (repositorySnapshot.loaded && repositorySnapshot.value) {
    config = mergeRepositoryConfig(config, repositorySnapshot.value);
    assertRepositoryRoutingSafety(config, repositorySnapshot.value);
    sources.push(repositorySnapshot.path);
  }

  for (const explicitConfig of input.explicitConfigs) {
    config = deepMergeConfig(config, explicitConfig.value);
    sources.push(explicitConfig.origin);
  }

  if (Object.keys(input.overrides).length > 0) {
    config = deepMergeConfig(config, input.overrides);
  }

  const schemaValidation = input.schemas.get("hdo-config")(config);
  if (!schemaValidation.valid) {
    // PowerShell's Test-HdoJsonSchema error text differs ("Value does not conform to
    // <schemaPath>" / "Schema validation failed: <message>"); this is the documented
    // divergence noted in the phase-1 task - only the "Configuration schema
    // validation failed: " prefix is guaranteed to match, not the Ajv error tail.
    throw new Error(`Configuration schema validation failed: ${schemaValidation.errors.join("; ")}`);
  }

  const profileName = input.profile || String(getValue(config, "activeProfile", "") ?? "");
  if (!profileName) throw new Error("activeProfile or -Profile must be specified.");
  const profiles = getValue(config, "profiles");
  const matchedProfileKey = isPlainObject(profiles) ? findKeyIgnoreCase(profiles, profileName) : undefined;
  if (!isPlainObject(profiles) || matchedProfileKey === undefined) {
    throw new Error(`Profile '${profileName}' is not defined.`);
  }
  config = deepMergeConfig(config, profiles[matchedProfileKey] as JsonObject);

  if (!isPlainObject(config.steps)) config.steps = {};
  const steps = config.steps as JsonObject;
  for (const stepName of Object.keys(input.stepOverrides)) {
    // PowerShell's `-notin` is case-insensitive, so `-SetStep IMPLEMENT=...` is accepted.
    if (!STEP_NAMES.includes(stepName.toLowerCase())) throw new Error(`Unknown step override '${stepName}'.`);
    // `$config.steps[$stepName] = ...` on an OrderedDictionary replaces any existing
    // key that matches case-insensitively with the newly assigned casing, IN PLACE
    // at that key's existing position (it does not move to the end); `setKeyIgnoreCase`
    // (value.ts) is the faithful port of that assignment.
    setKeyIgnoreCase(steps, stepName, input.stepOverrides[stepName]);
  }

  config.resolvedProfile = profileName;
  config.repositoryPath = input.repositoryPath;
  config.configSources = [...sources];

  const { value: _snapshotValue, ...snapshotWithoutValue } = repositorySnapshot;
  config.repositoryConfig = snapshotWithoutValue as unknown as JsonObject;

  if (isPlainObject(config.paths)) {
    const paths = config.paths;
    for (const pathKey of ["worktreeRoot", "artifactRoot"] as const) {
      const raw = paths[pathKey];
      if (typeof raw === "string" && raw) {
        paths[pathKey] = input.host.expandPath(raw, input.repositoryPath);
      }
    }
  }
  if (typeof config.projectContractPath === "string" && config.projectContractPath) {
    config.projectContractPath = input.host.expandPath(config.projectContractPath, input.repositoryPath);
  }

  const validation = validateConfiguration(config, input.host);
  if (!validation.valid) {
    throw new Error(`Configuration is invalid:\n - ${validation.errors.join("\n - ")}`);
  }
  config.configurationWarnings = validation.warnings;

  return config;
}
