// Port of `Invoke-HdoRun`'s issue-selection prologue (Workflow.ps1:231-258): resolves
// the repository slug, picks or validates an Issue number, loads and normalizes the
// Issue into an `IssueContract`, re-resolves configuration for a route hint, loads
// the project contract, and runs every pre-worktree gate (contract validation, ready
// authorization, dependency resolution, active-claim check) - throwing the exact
// PowerShell text on the first failure, in the exact PowerShell order. Shared by
// `DryRun`, a full run, and the phase-7 `inspect` command (plan §1.1).
//
// `src/workflow/**` is a host module (ADR-0001 phase 5/6 plan §2 boundary): this file
// never touches the filesystem or spawns a process directly - every GitHub call goes
// through the injected `GhClient`/`GitClient`, and `config` is passed in already
// resolved by the composition root (`resolveCliConfig`), with `reresolveConfig`
// injected so this module never imports `src/cli/**`.
import type { JsonObject } from "../core/contracts/types.ts";
import type {
  DependencyValidationResult,
  GithubIssue,
  IssueContract,
  IssueContractValidationResult,
  ProjectContract,
  ReadyLabelAuthorizationResult,
  ResolvedHdoConfig,
} from "../core/contracts/types.ts";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { asString, equalsIgnoreCase } from "../core/runners/psSemantics.ts";
import { GitClient, sha256Hex } from "../git/index.ts";
import { getClaimComments } from "../github/claim.ts";
import { getIssue, resolveRepositorySlug, type GhClient } from "../github/client.ts";
import { testReadyLabelAuthorization } from "../github/authorization.ts";
import { testIssueContract } from "../github/contractValidation.ts";
import { getIssueCandidate, testIssueDependencies } from "../github/issues.ts";
import { convertToIssueContract } from "../github/normalize.ts";
import { loadProjectContract } from "./projectContract.ts";

export interface SelectIssueOptions {
  config: JsonObject;
  repository?: string;
  issueNumber?: number;
  pick: boolean;
  gh: GhClient;
  git: GitClient;
  schemas: SchemaRegistry;
  /** Re-resolves config for the Issue's route hint (`Get-HdoConfig ... -Profile`, Workflow.ps1:246). */
  reresolveConfig: (profile: string) => Promise<JsonObject>;
  /** The CLI's explicit `-Profile` (PS `$Profile`); a route hint never overrides it. */
  explicitProfile?: string;
  now?: () => string;
}

export interface SelectedIssue {
  config: JsonObject;
  repository: string;
  issueNumber: number;
  issue: GithubIssue;
  issueContract: IssueContract;
  projectContract: JsonObject;
  projectContractHash: string;
  contractValidation: IssueContractValidationResult;
  readyAuthorization: ReadyLabelAuthorizationResult;
  dependencyValidation: DependencyValidationResult;
}

/**
 * Port of `Invoke-HdoRun`'s issue-selection prologue. Throw texts are copied verbatim
 * from Workflow.ps1:236-263 (plan §2.5); see the inline `// Oracle:` comments below.
 */
export async function selectIssue(options: SelectIssueOptions): Promise<SelectedIssue> {
  const { gh, git, schemas } = options;
  let config = options.config;
  const repositoryPath = asString(config.repositoryPath);

  // Oracle: Workflow.ps1:234, `if (-not $Repository) { $Repository = Resolve-HdoRepositorySlug $config }`
  const repository = options.repository || (await resolveRepositorySlug(config as unknown as ResolvedHdoConfig, git));

  let issueNumber = options.issueNumber ?? 0;
  if (issueNumber <= 0) {
    // Oracle: Workflow.ps1:236, "Specify -IssueNumber or -Pick."
    if (!options.pick) throw new Error("Specify -IssueNumber or -Pick.");
    // Get-HdoIssueCandidate (GitHub.ps1:397-437) always loads its own project
    // contract from the config it is called with (:422 `Get-HdoProjectContract
    // $Config`), independent of the per-Issue route-hint re-resolution below - the
    // TS port takes it as a parameter instead of reading the filesystem itself.
    const candidateProjectContract = loadProjectContract(asString(config.projectContractPath), schemas);
    const candidates = await getIssueCandidate(
      gh,
      git,
      schemas,
      config as unknown as ResolvedHdoConfig,
      candidateProjectContract as unknown as ProjectContract,
      repositoryPath,
      { repository },
    );
    // Oracle: Workflow.ps1:238, "No eligible HDO Issue was found in $Repository."
    if (candidates.length === 0) throw new Error(`No eligible HDO Issue was found in ${repository}.`);
    issueNumber = candidates[0].number;
  }

  const issue = await getIssue(gh, git, config as unknown as ResolvedHdoConfig, issueNumber, repository);
  // Oracle: Workflow.ps1:243, "Issue #$IssueNumber is not open."
  if (!equalsIgnoreCase(issue.state, "OPEN")) throw new Error(`Issue #${issueNumber} is not open.`);

  const issueContract = convertToIssueContract(issue, { now: options.now });

  // Oracle: Workflow.ps1:245-247 - a route hint never overrides an explicit -Profile;
  // comparison is case-insensitive.
  if (
    !options.explicitProfile &&
    issueContract.preferredExecution &&
    !equalsIgnoreCase(issueContract.preferredExecution, asString(config.resolvedProfile))
  ) {
    config = await options.reresolveConfig(issueContract.preferredExecution);
  }

  const projectContract = loadProjectContract(asString(config.projectContractPath), schemas);
  // Oracle: Workflow.ps1:249 - `Get-HdoSha256 ($projectContract | ConvertTo-Json -Depth 100 -Compress)`.
  const projectContractHash = sha256Hex(JSON.stringify(projectContract));

  const contractValidation = testIssueContract(issueContract, schemas, {
    config: config as unknown as ResolvedHdoConfig,
    projectContract: projectContract as unknown as ProjectContract,
    requireReady: true,
  });
  if (!contractValidation.valid) {
    // Oracle: Workflow.ps1:252, "Issue #$IssueNumber does not satisfy the HDO contract:`n - <error>`n - <error>..."
    throw new Error(`Issue #${issueNumber} does not satisfy the HDO contract:\n - ${contractValidation.errors.join("\n - ")}`);
  }

  const readyAuthorization = await testReadyLabelAuthorization(gh, config as unknown as ResolvedHdoConfig, repository, issueNumber, repositoryPath);
  if (!readyAuthorization.authorized) {
    // Oracle: Workflow.ps1:255, "Issue #$IssueNumber ready authorization failed: $($readyAuthorization.reason)"
    throw new Error(`Issue #${issueNumber} ready authorization failed: ${readyAuthorization.reason}`);
  }

  const dependencyValidation = await testIssueDependencies(gh, issueContract, repositoryPath);
  if (!dependencyValidation.resolved) {
    // Oracle: Workflow.ps1:258-259, "Issue #$IssueNumber has unresolved or unverifiable dependencies: <repo>#<num> [<state>], ..."
    const blockedDependencies = dependencyValidation.unresolved.map((dependency) => `${dependency.repository}#${dependency.number} [${dependency.state}]`);
    throw new Error(`Issue #${issueNumber} has unresolved or unverifiable dependencies: ${blockedDependencies.join(", ")}`);
  }

  const activeClaims = (await getClaimComments(gh, config as unknown as ResolvedHdoConfig, repository, issueNumber, repositoryPath)).filter((claim) =>
    equalsIgnoreCase(claim.status, "active"),
  );
  if (activeClaims.length > 0) {
    // Oracle: Workflow.ps1:263, "Issue #$IssueNumber already has an active HDO run: <runId>, ..."
    throw new Error(`Issue #${issueNumber} already has an active HDO run: ${activeClaims.map((claim) => claim.runId).join(", ")}`);
  }

  return {
    config,
    repository,
    issueNumber,
    issue,
    issueContract,
    projectContract,
    projectContractHash,
    contractValidation,
    readyAuthorization,
    dependencyValidation,
  };
}
