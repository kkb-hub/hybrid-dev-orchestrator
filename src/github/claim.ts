// Port of `Get-HdoClaimComments` (GitHub.ps1:462-504), `Set-HdoManagedStatusLabel`
// (GitHub.ps1:506-524), `Claim-HdoIssue` (GitHub.ps1:526-596), `Protect-HdoGitHubText`
// (GitHub.ps1:598-606) and `Complete-HdoClaim` (GitHub.ps1:608-638).
import { getValue } from "../core/config/value.ts";
import { protectText } from "../core/process/redact.ts";
import type { ClaimComment, ClaimMarker, ClaimResult, GithubIssue, JsonValue, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { sha256Hex, type GitClient } from "../git/index.ts";
import { getIssue, type GhClient } from "./client.ts";
import { tryParseTimestamp } from "./contractValidation.ts";

function equalsCaseInsensitive(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function includesCaseInsensitive(list: readonly string[], value: string): boolean {
  return list.some((item) => equalsCaseInsensitive(item, value));
}

function startsWithCaseInsensitive(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

const CLAIM_MARKER_PATTERN = /<!--\s*hdo:claim:v1\s+(?<marker>\{.*?\})\s*-->/i;
const RUN_ID_PATTERN = /^issue-[0-9]+-[A-Za-z0-9._:-]+$/i;
const VALID_CLAIM_STATES = ["active", "released"];
const TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * Port of `Get-HdoClaimComments` (GitHub.ps1:462-504): extracts, authenticates and
 * shape-validates `<!-- hdo:claim:v1 {...} -->` markers out of an Issue's comments.
 * Every individual gate below (author trust, `claimedBy` match, marker
 * version/kind/issueKey/runId shape, state enum, parseable/ordered lease dates) must
 * pass or the comment is silently skipped - a malformed or foreign marker is never
 * surfaced as an error, only excluded from the result.
 */
export async function getClaimComments(
  gh: GhClient,
  config: Pick<ResolvedHdoConfig, "github">,
  repository: string,
  issueNumber: number,
  workingDirectory: string,
): Promise<ClaimComment[]> {
  const comments = await gh.execPagedJson<JsonValue>(`repos/${repository}/issues/${issueNumber}/comments`, workingDirectory);
  const trustedActors = config.github?.trustedActors ?? [];
  const claims: ClaimComment[] = [];

  for (const comment of comments) {
    const body = String(getValue(comment, "body", ""));
    const markerMatch = body.match(CLAIM_MARKER_PATTERN);
    if (!markerMatch?.groups?.marker) continue;
    let marker: ClaimMarker;
    try {
      marker = JSON.parse(markerMatch.groups.marker) as ClaimMarker;
    } catch {
      continue;
    }

    const author = String(getValue(comment, "user.login", ""));
    const association = String(getValue(comment, "author_association", ""));
    const trustedAuthor =
      trustedActors.length > 0 ? includesCaseInsensitive(trustedActors, author) : includesCaseInsensitive(TRUSTED_ASSOCIATIONS, association);
    if (!trustedAuthor || !equalsCaseInsensitive(String(marker.claimedBy ?? ""), author)) continue;
    if (Number(marker.version ?? 0) !== 1 || !equalsCaseInsensitive(String(marker.kind ?? ""), "claim")) continue;
    if (!equalsCaseInsensitive(String(marker.issueKey ?? ""), `${repository}#${issueNumber}`)) continue;
    if (!RUN_ID_PATTERN.test(String(marker.runId ?? ""))) continue;
    if (!includesCaseInsensitive(VALID_CLAIM_STATES, String(marker.state ?? ""))) continue;

    const claimedAtMs = tryParseTimestamp(String(marker.claimedAt ?? ""));
    const leaseExpiresAtMs = tryParseTimestamp(String(marker.leaseExpiresAt ?? ""));
    if (claimedAtMs === null || leaseExpiresAtMs === null) continue;
    if (leaseExpiresAtMs <= claimedAtMs) continue;

    claims.push({
      runId: String(marker.runId),
      status: String(marker.state),
      id: Number(getValue(comment, "id", 0)),
      createdAt: String(getValue(comment, "created_at", "")),
      author,
      marker,
      body,
    });
  }
  return claims;
}

/**
 * Port of `Set-HdoManagedStatusLabel` (GitHub.ps1:506-524): removes every currently
 * applied ready/status label except `targetLabel` and adds `targetLabel` if it is not
 * already present, in a single `gh issue edit`. A no-op (target already the only
 * ready/status label present) skips the `gh` call entirely.
 */
export async function setManagedStatusLabel(
  gh: GhClient,
  config: Pick<ResolvedHdoConfig, "github">,
  git: GitClient,
  repository: string,
  issueNumber: number,
  targetLabel: string,
  workingDirectory: string,
): Promise<void> {
  const issue = await getIssue(gh, git, { github: config.github, repositoryPath: workingDirectory }, issueNumber, repository);
  const prefix = config.github?.labels?.statusPrefix ?? "hdo:status/";
  const ready = config.github?.labels?.ready ?? "hdo:ready";
  const args = ["issue", "edit", String(issueNumber), "--repo", repository];
  for (const label of issue.labels.filter((candidate) => equalsCaseInsensitive(candidate, ready) || startsWithCaseInsensitive(candidate, prefix))) {
    if (!equalsCaseInsensitive(label, targetLabel)) args.push("--remove-label", label);
  }
  if (!includesCaseInsensitive(issue.labels, targetLabel)) args.push("--add-label", targetLabel);
  if (args.length === 5) return;
  await gh.execThrowing(args, workingDirectory);
}

function compressJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Port of `Claim-HdoIssue` (GitHub.ps1:526-596): optimistic-concurrency check against
 * the Issue snapshot used for contract validation, an active-claim conflict check, a
 * `github.trustedActors` gate on the authenticated `gh` actor, then a
 * comment-based distributed lock (lowest comment id wins) with automatic release of
 * the loser's marker. `github.assignOnClaim` failures degrade to a `warning` string
 * rather than failing the whole claim (the claim itself already succeeded).
 */
export async function claimIssue(gh: GhClient, git: GitClient, config: ResolvedHdoConfig, issue: GithubIssue, runId: string, workingDirectory: string): Promise<ClaimResult> {
  const repository = issue.repository;
  const number = issue.number;
  const currentIssue = await getIssue(gh, git, { github: config.github, repositoryPath: workingDirectory }, number, repository);
  const expectedBodyHash = sha256Hex(issue.body ?? "");
  const currentBodyHash = sha256Hex(currentIssue.body ?? "");
  if (currentIssue.updatedAt !== issue.updatedAt || currentBodyHash !== expectedBodyHash) {
    throw new Error(`Issue #${number} changed after contract validation; re-run HDO against a fresh snapshot.`);
  }

  const active = (await getClaimComments(gh, config, repository, number, workingDirectory)).filter((claim) => claim.status === "active");
  if (active.length > 0) {
    throw new Error(`Issue #${number} already has an active HDO run: ${active.map((claim) => claim.runId).join(", ")}`);
  }

  const loginResult = await gh.execThrowing(["api", "user", "--jq", ".login"], workingDirectory, 60);
  const login = loginResult.stdout.trim();
  const trustedActors = config.github?.trustedActors ?? [];
  if (trustedActors.length > 0 && !includesCaseInsensitive(trustedActors, login)) {
    throw new Error(`Authenticated GitHub actor '${login}' is not listed in github.trustedActors.`);
  }

  const claimedAt = new Date();
  const leaseHours = Number(config.github?.claimLeaseHours ?? 24);
  const leaseExpiresAt = new Date(claimedAt.getTime() + leaseHours * 60 * 60 * 1000);
  const marker: ClaimMarker = {
    version: 1,
    kind: "claim",
    runId,
    issueKey: `${repository}#${number}`,
    claimedBy: login,
    claimedAt: claimedAt.toISOString(),
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    state: "active",
  };
  const body = `<!-- hdo:claim:v1 ${compressJson(marker)} -->\nHDO run \`${runId}\` が issue を claim しました。`;
  const comment = await gh.execJson<{ id: number }>(
    ["api", "-X", "POST", `repos/${repository}/issues/${number}/comments`, "-f", `body=${body}`],
    workingDirectory,
  );

  const claims = (await getClaimComments(gh, config, repository, number, workingDirectory))
    .filter((claim) => claim.status === "active")
    .sort((a, b) => a.id - b.id);
  const winner = claims[0];
  if (!winner || winner.runId !== runId) {
    marker.state = "released";
    const abortedBody = `<!-- hdo:claim:v1 ${compressJson(marker)} -->\n別の run が先に claim したため停止しました。`;
    await gh.execJson(["api", "-X", "PATCH", `repos/${repository}/issues/comments/${comment.id}`, "-f", `body=${abortedBody}`], workingDirectory);
    // GitHub.ps1:571: `$winner.runId` on a $null `$winner` evaluates to $null, which
    // string-interpolates as "" (not the literal text "null"/"undefined") - reproduce
    // that empty-string fallback explicitly rather than letting `undefined` leak into
    // the message via template-literal interpolation.
    throw new Error(`Issue #${number} claim conflict. Winning run: ${winner ? winner.runId : ""}`);
  }

  const claimedLabel = config.github?.labels?.claimed ?? "hdo:status/claimed";
  try {
    await setManagedStatusLabel(gh, config, git, repository, number, claimedLabel, workingDirectory);
  } catch (error) {
    marker.state = "released";
    const failureBody = `<!-- hdo:claim:v1 ${compressJson(marker)} -->\nClaim 後の status 更新に失敗したため run を開始しませんでした。`;
    try {
      await gh.execJson(["api", "-X", "PATCH", `repos/${repository}/issues/comments/${comment.id}`, "-f", `body=${failureBody}`], workingDirectory);
    } catch {
      // Mirrors the PowerShell empty `catch { }`: a failure to record the release marker must not mask the original error.
    }
    throw error;
  }

  let warning: string | null = null;
  if (config.github?.assignOnClaim ?? true) {
    try {
      await gh.execThrowing(["issue", "edit", String(number), "--repo", repository, "--add-assignee", "@me"], workingDirectory);
    } catch (error) {
      warning = `Issue assignment failed after a successful claim: ${protectText((error as Error).message)}`;
    }
  }
  return { commentId: comment.id, marker, claimedAt: marker.claimedAt, warning };
}

/**
 * Port of `Protect-HdoGitHubText` (GitHub.ps1:598-606): redacts secrets via
 * `protectText`, neutralizes HTML comment delimiters (so caller-controlled text can
 * never terminate/inject a `<!-- hdo:claim:v1 ... -->` marker), inserts a zero-width
 * space after every `@` (so a summary cannot accidentally @-mention someone), then
 * truncates with a trailing ellipsis.
 */
export function protectGitHubText(text: string | null | undefined, maximumLength = 1000): string {
  const safe = text === null || text === undefined ? null : protectText(text);
  if (!safe) return "";
  let result = safe.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;").replaceAll("@", "@\u200B");
  if (result.length > maximumLength) result = result.slice(0, maximumLength) + "…";
  return result;
}

export interface CompleteClaimRun {
  id: string;
  issue: { repository: string; number: number };
  github: { claim: { commentId: number; marker: ClaimMarker } | null };
}

/**
 * Port of `Complete-HdoClaim` (GitHub.ps1:608-638): patches the claim comment with a
 * released marker and the final status/summary, then moves the managed status label
 * to the outcome's label (falling back to a built-in default when unconfigured).
 * A run whose claim never recorded a `commentId` (e.g. it failed before claiming) is
 * a silent no-op, matching the PowerShell early return.
 */
export async function completeClaim(
  gh: GhClient,
  config: Pick<ResolvedHdoConfig, "github">,
  git: GitClient,
  run: CompleteClaimRun,
  status: string,
  summary: string,
  workingDirectory: string,
): Promise<void> {
  if (!run.github.claim?.commentId) return;
  const repository = run.issue.repository;
  const number = run.issue.number;
  const runId = run.id;
  const safeSummary = protectGitHubText(summary);
  const marker: ClaimMarker = { ...run.github.claim.marker, state: "released" };
  const body = `<!-- hdo:claim:v1 ${compressJson(marker)} -->\nHDO run \`${runId}\`: **${status}**\n\n${safeSummary}`;
  await gh.execJson(["api", "-X", "PATCH", `repos/${repository}/issues/comments/${run.github.claim.commentId}`, "-f", `body=${body}`], workingDirectory);

  const upperStatus = status.toUpperCase();
  const labelKey: "approved" | "escalated" | "failed" =
    upperStatus === "APPROVED" ? "approved" : upperStatus === "ESCALATED" ? "escalated" : "failed";
  const fallback = upperStatus === "APPROVED" ? "hdo:status/approved" : upperStatus === "ESCALATED" ? "hdo:status/blocked" : "hdo:status/failed";
  const targetLabel = config.github?.labels?.[labelKey] ?? fallback;
  await setManagedStatusLabel(gh, config, git, repository, number, targetLabel, workingDirectory);
}
