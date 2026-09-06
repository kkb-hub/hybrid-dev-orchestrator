// Port of `Get-HdoIssueCandidate` (GitHub.ps1:397-437) and `Test-HdoIssueDependencies`
// (GitHub.ps1:439-460).
import { protectText } from "../core/process/redact.ts";
import type { DependencyValidationResult, IssueCandidate, IssueContract, JsonValue, ProjectContract, ResolvedHdoConfig } from "../core/contracts/types.ts";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { GitClient } from "../git/index.ts";
import { getClaimComments } from "./claim.ts";
import { getIssue, getLabelNames, resolveRepositorySlug, type GhClient } from "./client.ts";
import { testReadyLabelAuthorization } from "./authorization.ts";
import { testIssueContract } from "./contractValidation.ts";
import { convertToIssueContract } from "./normalize.ts";

function equalsCaseInsensitive(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function includesCaseInsensitive(list: readonly string[], value: string): boolean {
  return list.some((item) => equalsCaseInsensitive(item, value));
}

function startsWithCaseInsensitive(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

const DEFAULT_PRIORITY_ORDER = ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"];

/**
 * Port of `Test-HdoIssueDependencies` (GitHub.ps1:439-460): resolves each dependency
 * reference against the live Issue state, treating `CLOSED` as the only resolved
 * state. A `gh issue view` failure (unknown repository/number, no access, ...) is
 * captured per-dependency as an `UNKNOWN`/unresolved check rather than aborting the
 * whole validation, with the caught error text redacted via `protectText` before
 * being surfaced (mirrors `Protect-HdoText $_.Exception.Message`).
 */
export async function testIssueDependencies(gh: GhClient, contract: IssueContract, workingDirectory: string): Promise<DependencyValidationResult> {
  const checks: DependencyValidationResult["checks"] = [];
  for (const dependency of contract.dependencies ?? []) {
    const repository = dependency.repository;
    const number = dependency.number;
    try {
      const result = await gh.execJson<{ state: string }>(["issue", "view", String(number), "--repo", repository, "--json", "state,url"], workingDirectory);
      const state = String(result.state);
      checks.push({ repository, number, state, resolved: state === "CLOSED", error: null });
    } catch (error) {
      checks.push({ repository, number, state: "UNKNOWN", resolved: false, error: protectText((error as Error).message) });
    }
  }
  const unresolved = checks.filter((check) => !check.resolved);
  return { resolved: unresolved.length === 0, checks, unresolved };
}

export interface GetIssueCandidateOptions {
  repository?: string;
  limit?: number;
}

/**
 * Port of `Get-HdoIssueCandidate` (GitHub.ps1:397-437): lists open, ready-labeled
 * Issues, filters out excluded/status-in-progress/contract-invalid/unauthorized/
 * dependency-blocked/already-claimed candidates, then sorts the survivors by
 * (priorityRank asc, createdAt asc, number asc) and truncates to `limit`.
 *
 * `projectContract` is passed in by the caller (already loaded) rather than read from
 * disk here - `core`/`github` never touch the filesystem directly (see `SchemaRegistry`
 * and the composition-root convention documented there); the same is true of `Sync-
 * HdoLabels`'s catalog parameter in `labels.ts`.
 */
export async function getIssueCandidate(
  gh: GhClient,
  git: GitClient,
  schemas: SchemaRegistry,
  config: ResolvedHdoConfig,
  projectContract: ProjectContract | undefined,
  workingDirectory: string,
  options: GetIssueCandidateOptions = {},
): Promise<IssueCandidate[]> {
  const repository = options.repository ?? (await resolveRepositorySlug({ github: config.github, repositoryPath: workingDirectory }, git));
  const limit = options.limit && options.limit > 0 ? options.limit : Number(config.github?.candidateLimit ?? 50);
  const readyLabel = config.github?.labels?.ready ?? "hdo:ready";
  const fields = "number,title,body,state,labels,assignees,author,createdAt,updatedAt,url";
  const issues = await gh.execJson<Array<Record<string, JsonValue>>>(
    ["issue", "list", "--repo", repository, "--state", "open", "--label", readyLabel, "--limit", "1000", "--json", fields],
    workingDirectory,
  );
  const statusPrefix = config.github?.labels?.statusPrefix ?? "hdo:status/";
  const skipLabel = config.github?.labels?.skip ?? "hdo:skip";
  // `getValue`'s (GitHub.ps1:412 `Get-HdoValue ... @('hdo:priority/p0', ...)`) default
  // applies only when the key is ABSENT, not when it is present-but-empty - an
  // explicit `github.priorityOrder: []` (which config merge preserves verbatim rather
  // than concatenating, see tests/run-tests.ps1:66-77) must leave every issue tied at
  // rank 0, not silently fall back to the built-in 4-tier order.
  const priorityOrder = config.github?.priorityOrder !== undefined ? config.github.priorityOrder : DEFAULT_PRIORITY_ORDER;

  const candidates: IssueCandidate[] = [];
  for (const rawIssue of issues) {
    const labels = getLabelNames(rawIssue.labels);
    const issue = { ...rawIssue, repository, labels } as unknown as IssueCandidate;
    if (includesCaseInsensitive(labels, skipLabel)) continue;
    if (labels.some((label) => startsWithCaseInsensitive(label, statusPrefix))) continue;

    const contract = convertToIssueContract(issue);
    const contractValidation = testIssueContract(contract, schemas, { config, projectContract, requireReady: true });
    if (!contractValidation.valid) continue;

    const readyAuthorization = await testReadyLabelAuthorization(gh, config, repository, Number(issue.number), workingDirectory);
    if (!readyAuthorization.authorized) continue;

    const dependencyValidation = await testIssueDependencies(gh, contract, workingDirectory);
    if (!dependencyValidation.resolved) continue;

    const activeClaims = (await getClaimComments(gh, config, repository, Number(issue.number), workingDirectory)).filter(
      (claim) => claim.status === "active",
    );
    if (activeClaims.length > 0) continue;

    let priorityRank = priorityOrder.length;
    for (let index = 0; index < priorityOrder.length; index++) {
      if (includesCaseInsensitive(labels, priorityOrder[index])) {
        priorityRank = index;
        break;
      }
    }
    issue.priorityRank = priorityRank;
    candidates.push(issue);
  }

  const sorted = candidates.slice().sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    const createdAtA = String(a.createdAt ?? "");
    const createdAtB = String(b.createdAt ?? "");
    if (createdAtA !== createdAtB) return createdAtA < createdAtB ? -1 : 1;
    return a.number - b.number;
  });
  return sorted.slice(0, limit);
}
