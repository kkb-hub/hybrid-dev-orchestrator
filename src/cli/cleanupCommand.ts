// Composition root for the `cleanup` CLI subcommand: mirrors hdo.ps1's `'cleanup'`
// case (hdo.ps1:133-145) - `if (-not $RunId) { throw 'cleanup requires -RunId.' }`,
// then `Remove-HdoRunWorktree -RunId $RunId -RepositoryPath ... -ConfigPath ...
// -Profile ... -IgnoreRepositoryConfig:... -Force:$Force -Confirm:$false
// -WhatIf:$WhatIf`. `removeRunWorktree` (WP-C, `src/workflow/cleanup.ts`) is the
// config-free remainder (Git.ps1:211-301), given the already-resolved config exactly
// like `status`/`run` hand `readRun`/`runWorkflow` their own resolved config.
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import type { RemoveRunWorktreeResult } from "../workflow/cleanup.ts";
import { removeRunWorktree } from "../workflow/cleanup.ts";
import type { ParsedArgs } from "./args.ts";
import { resolveCliConfig } from "./configCommand.ts";

export interface RunCleanupCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH. */
  git?: GitClient;
  now?: () => string;
  /** `-WhatIf` preview line sink; defaults to `process.stdout.write`. Overridable for tests. */
  writeHostLine?: (line: string) => void;
}

/**
 * Port of hdo.ps1's `cleanup` case. Any failure (missing `-RunId`, configuration
 * resolution, or any of `removeRunWorktree`'s own guards) propagates to the caller
 * unchanged - `main.ts` catches it exactly like every other subcommand (stderr + exit
 * 2, mirroring hdo.ps1's top-level `catch`).
 *
 * Returns `undefined` for the `-WhatIf` preview (see `removeRunWorktree`'s own doc
 * comment); `main.ts` prints that as `null`, matching PowerShell's observed
 * `-WhatIf` output (phase 7 plan Q1).
 */
export async function runCleanupCommand(options: RunCleanupCommandOptions): Promise<RemoveRunWorktreeResult | undefined> {
  const { parsed, platform, schemas } = options;

  // Oracle: hdo.ps1:134, "cleanup requires -RunId."
  if (!parsed.runId) throw new Error("cleanup requires -RunId.");

  const git = options.git ?? new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
  const resolvedConfig = await resolveCliConfig({ parsed, platform, schemas, git });

  return removeRunWorktree({
    runId: parsed.runId,
    config: resolvedConfig,
    git,
    platform,
    force: parsed.force,
    whatIf: parsed.whatIf,
    now: options.now,
    writeHostLine: options.writeHostLine,
  });
}
