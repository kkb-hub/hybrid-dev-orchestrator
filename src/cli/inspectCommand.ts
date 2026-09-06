// Composition root for the `inspect` CLI subcommand: mirrors hdo.ps1's `'inspect'`
// case (hdo.ps1:84-90) - `if ($Issue -le 0) { throw 'inspect requires -Issue
// <number>.' }`, `Get-HdoCliConfig`, `Get-HdoIssue -Number $Issue -Config $resolved
// -Repository $Repository`, `ConvertTo-HdoIssueContract`, then
// `Test-HdoIssueContract -Contract $contract -Config $resolved -RequireReady`
// (notably WITHOUT `-ProjectContract` - `inspect` never loads the project contract,
// unlike `issues`/`run`). Output key order mirrors PS's
// `[ordered]@{ issue = ...; contract = ...; validation = ... }`.
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { GithubIssue, IssueContract, IssueContractValidationResult, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { getIssue, GhClient } from "../github/client.ts";
import { testIssueContract } from "../github/contractValidation.ts";
import { convertToIssueContract } from "../github/normalize.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import type { ParsedArgs } from "./args.ts";
import { resolveCliConfig } from "./configCommand.ts";

export interface RunInspectCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH via `NodeProcessRunner`. */
  git?: GitClient;
  /** Overridable for tests; defaults to a real `gh` on PATH via `NodeProcessRunner`. */
  gh?: GhClient;
}

export interface RunInspectCommandResult {
  issue: GithubIssue;
  contract: IssueContract;
  validation: IssueContractValidationResult;
}

/**
 * Port of hdo.ps1's `inspect` case. Any failure (missing `-Issue`, configuration
 * resolution, or `gh` errors) propagates to the caller unchanged - `main.ts` catches
 * it exactly like every other subcommand (stderr + exit 2).
 */
export async function runInspectCommand(options: RunInspectCommandOptions): Promise<RunInspectCommandResult> {
  const { parsed, platform, schemas } = options;

  // Oracle: hdo.ps1:85, "inspect requires -Issue <number>."
  if ((parsed.issue ?? 0) <= 0) throw new Error("inspect requires -Issue <number>.");

  const processRunner = new NodeProcessRunner({ platform });
  const git = options.git ?? new GitClient({ runner: processRunner, platform });
  const gh = options.gh ?? new GhClient({ runner: processRunner });

  const config = await resolveCliConfig({ parsed, platform, schemas, git });

  const issue = await getIssue(gh, git, config as unknown as ResolvedHdoConfig, parsed.issue as number, parsed.repository);
  const contract = convertToIssueContract(issue);
  // Oracle: hdo.ps1:89, `Test-HdoIssueContract -Contract $contract -Config $resolved
  // -RequireReady` - `-ProjectContract` is intentionally NOT passed here, unlike
  // `issues`/`run`; `projectContract` must stay `undefined`.
  const validation = testIssueContract(contract, schemas, { config: config as unknown as ResolvedHdoConfig, requireReady: true });

  // Key order mirrors PS's `[ordered]@{ issue; contract; validation }` (hdo.ps1:89).
  return { issue, contract, validation };
}
