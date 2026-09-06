// Composition root for the `issues` CLI subcommand: mirrors hdo.ps1's `'issues'` case
// (hdo.ps1:77-83) - `Get-HdoCliConfig`, then
// `Get-HdoIssueCandidate -Config $resolved -Repository $Repository`, then
// `if ($candidates.Count -eq 0) { exit 4 }`. `getIssueCandidate` itself loads its own
// project contract from the config it is called with (GitHub.ps1:422
// `Get-HdoProjectContract $Config`) - the composition root loads it from disk exactly
// like `selectIssue`'s `-Pick` branch does (`src/workflow/selectIssue.ts:80`).
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { IssueCandidate, ProjectContract, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { asString } from "../core/runners/psSemantics.ts";
import { GhClient } from "../github/client.ts";
import { getIssueCandidate } from "../github/issues.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { loadProjectContract } from "../workflow/projectContract.ts";
import type { ParsedArgs } from "./args.ts";
import { resolveCliConfig } from "./configCommand.ts";

export interface RunIssuesCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH via `NodeProcessRunner`. */
  git?: GitClient;
  /** Overridable for tests; defaults to a real `gh` on PATH via `NodeProcessRunner`. */
  gh?: GhClient;
}

export interface RunIssuesCommandResult {
  candidates: IssueCandidate[];
  exitCode: number;
}

/**
 * Port of hdo.ps1's `issues` case. Any failure (configuration resolution, project
 * contract loading, or `gh` errors) propagates to the caller unchanged - `main.ts`
 * catches it exactly like every other subcommand (stderr + exit 2).
 */
export async function runIssuesCommand(options: RunIssuesCommandOptions): Promise<RunIssuesCommandResult> {
  const { parsed, platform, schemas } = options;

  const processRunner = new NodeProcessRunner({ platform });
  const git = options.git ?? new GitClient({ runner: processRunner, platform });
  const gh = options.gh ?? new GhClient({ runner: processRunner });

  const config = await resolveCliConfig({ parsed, platform, schemas, git });
  const repositoryPath = asString(config.repositoryPath);
  const projectContract = loadProjectContract(asString(config.projectContractPath), schemas);

  const candidates = await getIssueCandidate(
    gh,
    git,
    schemas,
    config as unknown as ResolvedHdoConfig,
    projectContract as unknown as ProjectContract,
    repositoryPath,
    { repository: parsed.repository },
  );

  // Oracle: hdo.ps1:82, "if ($candidates.Count -eq 0) { exit 4 }"
  const exitCode = candidates.length === 0 ? 4 : 0;
  return { candidates, exitCode };
}
