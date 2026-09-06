// Composition root for the `labels` CLI subcommand: mirrors hdo.ps1's `'labels'` case
// (hdo.ps1:147-150) - `$resolved = Get-HdoCliConfig` (a config resolve with no
// `-RunId`/`-Issue`-specific options, i.e. `resolveCliConfig` with only the shared
// options), then `Sync-HdoLabels -Config $resolved -Repository $Repository
// -Apply:$Apply -WhatIf:$WhatIf`. `config/labels.json` is read here (the composition
// root), matching `syncLabels`'s "core/github never touch the filesystem directly"
// convention (`src/github/labels.ts`'s own doc comment) - PowerShell reads the
// equivalent file itself inside `Sync-HdoLabels` via `$script:HdoRepositoryRoot`
// (GitHub.ps1:674), a difference that does not change observable behaviour.
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { asString } from "../core/runners/psSemantics.ts";
import { getValue } from "../core/config/value.ts";
import type { LabelCatalog, LabelSyncResult, ResolvedHdoConfig } from "../core/contracts/types.ts";
import type { ConfigHost } from "../core/config/validate.ts";
import { GhClient } from "../github/client.ts";
import { syncLabels } from "../github/labels.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import type { ParsedArgs } from "./args.ts";
import { readJsonFile, resolveCliConfig } from "./configCommand.ts";
import { LABELS_CATALOG_PATH } from "./paths.ts";

export interface RunLabelsCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH. */
  git?: GitClient;
  /** Overridable for tests; defaults to a real `gh` on PATH. */
  gh?: GhClient;
  /** `-WhatIf` preview line sink; defaults to `process.stdout.write`. Overridable for tests. */
  shouldProcessSink?: (line: string) => void;
}

/**
 * Port of hdo.ps1's `labels` case. Any failure (configuration resolution, invalid
 * configuration, or a `gh` failure) propagates to the caller unchanged - `main.ts`
 * catches it exactly like every other subcommand (stderr + exit 2, mirroring
 * hdo.ps1's top-level `catch`).
 */
export async function runLabelsCommand(options: RunLabelsCommandOptions): Promise<LabelSyncResult> {
  const { parsed, platform, schemas } = options;

  const processRunner = new NodeProcessRunner({ platform });
  const git = options.git ?? new GitClient({ runner: processRunner, platform });
  const gh = options.gh ?? new GhClient({ runner: processRunner });

  const resolvedConfig = await resolveCliConfig({ parsed, platform, schemas, git });
  const catalog = readJsonFile(LABELS_CATALOG_PATH) as unknown as LabelCatalog;

  const host: ConfigHost = {
    pathEquals: (a, b) => platform.pathEquals(a, b),
    isPathWithinRoot: (child, root) => platform.isPathWithinRoot(child, root),
  };
  const workingDirectory = asString(getValue(resolvedConfig, "repositoryPath"));

  return syncLabels(gh, git, resolvedConfig as unknown as ResolvedHdoConfig, host, catalog, workingDirectory, {
    repository: parsed.repository,
    apply: parsed.apply,
    whatIf: parsed.whatIf,
    shouldProcessSink: options.shouldProcessSink,
  });
}
