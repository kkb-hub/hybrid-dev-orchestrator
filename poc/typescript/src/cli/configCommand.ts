// Composition root for AC-02's "config load" behaviour: reads config/hdo.default.json
// plus an optional user overlay and explicit --config overlays from disk (node:fs -
// deliberately NOT allowed in core), merges them with core's pure deepMergeConfig,
// validates the result against the real schemas/hdo-config.schema.json with Ajv, and
// expands paths.worktreeRoot/paths.artifactRoot through the injected platform adapter.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandPathTemplate } from "../core/config/expand.ts";
import { resolveConfigSources, type ConfigSource } from "../core/config/sources.ts";
import type { JsonObject, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { validateAgainstSchema, type ValidationResult } from "../core/contracts/validate.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { CONFIG_DEFAULT_PATH, REPO_ROOT, SCHEMAS_DIR } from "./paths.ts";

export interface LoadConfigOptions {
  configPaths: string[];
  platform: PlatformAdapter;
}

export interface LoadConfigResult {
  config: ResolvedHdoConfig;
  sources: string[];
  validation: ValidationResult;
}

async function readJsonFile(path: string): Promise<JsonObject> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as JsonObject;
}

export async function loadEffectiveConfig(options: LoadConfigOptions): Promise<LoadConfigResult> {
  const defaultConfig = await readJsonFile(CONFIG_DEFAULT_PATH);

  const overlays: ConfigSource[] = [];
  const userConfigPath = join(options.platform.userConfigDir(), "hdo", "config.json");
  if (existsSync(userConfigPath)) {
    overlays.push({ origin: userConfigPath, value: await readJsonFile(userConfigPath) });
  }
  for (const rawPath of options.configPaths) {
    const absolutePath = resolve(rawPath);
    overlays.push({ origin: absolutePath, value: await readJsonFile(absolutePath) });
  }

  const { config, sources } = resolveConfigSources({ origin: CONFIG_DEFAULT_PATH, value: defaultConfig }, overlays);

  const schema = await readJsonFile(join(SCHEMAS_DIR, "hdo-config.schema.json"));
  const validation = validateAgainstSchema(schema, config);

  const resolvedConfig = structuredClone(config) as unknown as ResolvedHdoConfig;
  const paths = resolvedConfig.paths as { worktreeRoot?: unknown; artifactRoot?: unknown } | undefined;
  if (paths) {
    for (const key of ["worktreeRoot", "artifactRoot"] as const) {
      const raw = paths[key];
      if (typeof raw === "string") {
        // This PoC treats the HDO repository itself as "the repository" for path
        // expansion (there is no separate target repository concept here - see
        // README "非目標").
        paths[key] = expandPathTemplate(raw, REPO_ROOT, options.platform);
      }
    }
  }

  return { config: resolvedConfig, sources, validation };
}
