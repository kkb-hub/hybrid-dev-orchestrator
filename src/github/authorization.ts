// Port of `Get-HdoIssueLastEditedAt` (GitHub.ps1:92-115) and
// `Test-HdoReadyLabelAuthorization` (GitHub.ps1:140-178).
import { getValue } from "../core/config/value.ts";
import type { JsonValue, ReadyLabelAuthorizationResult, ResolvedHdoConfig } from "../core/contracts/types.ts";
import type { GhClient } from "./client.ts";
import { testReadyContentFreshness } from "./contractValidation.ts";

const REPOSITORY_SLUG_PATTERN = /^(?<owner>[^/]+)\/(?<name>[^/]+)$/;

/** Case-insensitive `-eq` equivalent (PowerShell's default string comparison). */
function equalsCaseInsensitive(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Port of `Get-HdoIssueLastEditedAt` (GitHub.ps1:92-115): the GraphQL-only `lastEditedAt` field, scoped to content edits. */
export async function getIssueLastEditedAt(gh: GhClient, repository: string, issueNumber: number, workingDirectory: string): Promise<string> {
  const match = repository.match(REPOSITORY_SLUG_PATTERN);
  if (!match?.groups) throw new Error(`Invalid GitHub repository slug '${repository}'.`);
  const { owner, name } = match.groups;
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt}}}";
  const response = await gh.execJson<JsonValue>(
    ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${issueNumber}`],
    workingDirectory,
  );
  const issue = getValue(response, "data.repository.issue", null);
  if (issue === null || issue === undefined) {
    throw new Error(`GitHub Issue ${repository}#${issueNumber} was not found while checking ready authorization.`);
  }
  return String(getValue(issue, "lastEditedAt", "") ?? "");
}

/**
 * Port of `Test-HdoReadyLabelAuthorization` (GitHub.ps1:140-178).
 *
 * Issue.updatedAt also advances when the ready label itself changes. GitHub can
 * expose that timestamp one second after the corresponding label event, so comparing
 * those two fields rejects a freshly approved Issue. GraphQL `lastEditedAt` is
 * limited to Issue content edits and preserves the intended boundary: title/body
 * edits after ready fail (GitHub.ps1:158-161).
 */
export async function testReadyLabelAuthorization(
  gh: GhClient,
  config: Pick<ResolvedHdoConfig, "github">,
  repository: string,
  issueNumber: number,
  workingDirectory: string,
): Promise<ReadyLabelAuthorizationResult> {
  const trustedActors = config.github?.trustedActors ?? [];
  const readyLabel = config.github?.labels?.ready ?? "hdo:ready";
  const events = await gh.execPagedJson<JsonValue>(`repos/${repository}/issues/${issueNumber}/events`, workingDirectory);
  const labelEvents = events
    .filter(
      (event) =>
        equalsCaseInsensitive(String(getValue(event, "event", "")), "labeled") &&
        equalsCaseInsensitive(String(getValue(event, "label.name", "")), readyLabel),
    )
    .sort((a, b) => String(getValue(b, "created_at", "")).localeCompare(String(getValue(a, "created_at", ""))));

  if (labelEvents.length === 0) {
    return { authorized: false, enforced: true, actor: null, readyAt: null, reason: `No label event was found for '${readyLabel}'.` };
  }

  const actor = String(getValue(labelEvents[0], "actor.login", ""));
  const readyAtText = String(getValue(labelEvents[0], "created_at", ""));
  const lastEditedAt = await getIssueLastEditedAt(gh, repository, issueNumber, workingDirectory);
  const freshness = testReadyContentFreshness(readyAtText, lastEditedAt);
  if (!freshness.fresh) {
    return { authorized: false, enforced: true, actor, readyAt: readyAtText, lastEditedAt, reason: freshness.reason };
  }
  if (trustedActors.length === 0) {
    return {
      authorized: true,
      enforced: false,
      actor,
      readyAt: readyAtText,
      lastEditedAt,
      reason: "Ready event covers the latest content edit; repository label permissions are the actor trust boundary.",
    };
  }
  const isTrusted = trustedActors.some((trustedActor) => trustedActor.toLowerCase() === actor.toLowerCase());
  return {
    authorized: isTrusted,
    enforced: true,
    actor,
    readyAt: readyAtText,
    lastEditedAt,
    reason: isTrusted ? `Ready label was applied by trusted actor '${actor}'.` : `Ready label actor '${actor}' is not trusted.`,
  };
}
