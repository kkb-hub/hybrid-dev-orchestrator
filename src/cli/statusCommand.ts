// Composition root for the `status` CLI subcommand: mirrors hdo.ps1's `'status'`
// case (hdo.ps1:129-131) - `if (-not $RunId) { throw 'status requires -RunId.' }`,
// then `Get-HdoRun -RunId $RunId -RepositoryPath ... -ConfigPath ... -Profile ...
// -IgnoreRepositoryConfig:...`. `Get-HdoRun` itself resolves configuration (exactly
// like `config`/`doctor` do) only to read `paths.artifactRoot`; `readRun` (WP-C,
// `src/workflow/runStore.ts`) is the config-free remainder (State.ps1:78-95).
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import { asString } from "../core/runners/psSemantics.ts";
import { getValue } from "../core/config/value.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { readRun } from "../workflow/runStore.ts";
import type { ParsedArgs } from "./args.ts";
import { resolveCliConfig } from "./configCommand.ts";

export interface RunStatusCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH via `resolveCliConfig`. */
  git?: GitClient;
}

/**
 * Port of hdo.ps1's `status` case. Any failure (missing `-RunId`, configuration
 * resolution, or a missing `run.json`) propagates to the caller unchanged - `main.ts`
 * catches it exactly like every other subcommand (stderr + exit 2, mirroring
 * hdo.ps1's top-level `catch`); `status` never produces the exit 3/5/6 codes that
 * `run` does.
 */
export async function runStatusCommand(options: RunStatusCommandOptions): Promise<JsonObject> {
  const { parsed, platform, schemas } = options;
  // Oracle: hdo.ps1:130, "status requires -RunId."
  if (!parsed.runId) throw new Error("status requires -RunId.");

  const resolvedConfig = await resolveCliConfig({ parsed, platform, schemas, git: options.git });
  const artifactRoot = asString(getValue(resolvedConfig, "paths.artifactRoot"));
  return readRun(artifactRoot, parsed.runId);
}
