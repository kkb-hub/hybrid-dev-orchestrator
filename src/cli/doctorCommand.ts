// Composition root for the `doctor` CLI subcommand: mirrors hdo.ps1's `'doctor'`
// case (hdo.ps1:60-66) - resolves configuration the same way the `config` subcommand
// does (`resolveCliConfig`), then runs `runPreflight` (the `Test-HdoEnvironment`
// port, src/workflow/preflight.ts) with `-ReadOnly` bound to `-DryRun`.
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { GhClient } from "../github/client.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { runPreflight, type PreflightResult } from "../workflow/preflight.ts";
import type { ParsedArgs } from "./args.ts";
import { resolveCliConfig } from "./configCommand.ts";

export interface RunDoctorCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git`/`gh` on PATH via `NodeProcessRunner`. */
  git?: GitClient;
  gh?: GhClient;
}

export interface DoctorCommandOutput {
  result: PreflightResult;
  /** `0` when `result.ok`, else `3` - mirrors hdo.ps1's `if (-not $result.ok) { exit 3 }`. */
  exitCode: number;
}

/**
 * Resolves configuration exactly like `resolveCliConfig` does for `config`, then
 * runs `runPreflight` with `readOnly: parsed.dryRun` (`Test-HdoEnvironment -ReadOnly:$DryRun`).
 * Any failure while resolving configuration or running preflight propagates to the
 * caller (mirrors hdo.ps1's top-level `catch`, which exits 2 - see `main.ts`).
 */
export async function runDoctorCommand(options: RunDoctorCommandOptions): Promise<DoctorCommandOutput> {
  const { parsed, platform, schemas } = options;
  const processRunner = new NodeProcessRunner({ platform });
  const git = options.git ?? new GitClient({ runner: processRunner, platform });
  const gh = options.gh ?? new GhClient({ runner: processRunner });

  const resolvedConfig = await resolveCliConfig({ parsed, platform, schemas, git });
  const result = await runPreflight({
    config: resolvedConfig,
    readOnly: parsed.dryRun,
    platform,
    processRunner,
    git,
    gh,
    schemas,
  });
  return { result, exitCode: result.ok ? 0 : 3 };
}
