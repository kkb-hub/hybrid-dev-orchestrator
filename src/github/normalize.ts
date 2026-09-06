// Port of `ConvertTo-HdoIssueContract` (GitHub.ps1:257-318): turns a raw `GithubIssue`
// into the immutable, normalized `IssueContract` that everything downstream (contract
// validation, pickup order, claim) treats as untrusted-but-structured input.
import { sha256Hex } from "../git/index.ts";
import type { AcceptanceCriterion, GithubIssue, IssueContract } from "../core/contracts/types.ts";
import { getLabelNames } from "./client.ts";
import { getDependencyReferences, getMarkdownList, getMarkdownScalar, getMarkdownSections } from "./markdown.ts";

export interface ConvertToIssueContractOptions {
  /** Defaults to `() => new Date().toISOString()`. Injectable for deterministic tests - mirrors `Get-HdoUtcTimestamp` (GitHub.ps1:316). */
  now?: () => string;
}

// `i` flag mirrors PowerShell `-match`, which is case-insensitive by default
// (GitHub.ps1:266) - `ac-01: text` must keep its explicit id, not fall through to
// auto-numbering.
const ACCEPTANCE_CRITERION_PATTERN = /^(?<id>AC[-_ ]?[A-Za-z0-9][A-Za-z0-9._-]*)\s*[:：]\s*(?<text>.*)$/i;
const ROUTE_LABEL_PREFIX = "hdo:route/";
const PRIORITY_LABEL_PREFIX = "hdo:priority/";
const RISK_LABEL_PREFIX = "hdo:risk/";

/** Case-insensitive `.StartsWith` - mirrors PowerShell `-like 'prefix*'`'s default case-insensitivity (GitHub.ps1:277-279). */
function startsWithCaseInsensitive(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

export function convertToIssueContract(issue: GithubIssue, options: ConvertToIssueContractOptions = {}): IssueContract {
  const now = options.now ?? (() => new Date().toISOString());
  const body = issue.body ?? "";
  const sections = getMarkdownSections(body);

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  let criterionIndex = 0;
  for (const item of getMarkdownList(sections.acceptanceCriteria ?? "")) {
    criterionIndex++;
    const match = item.match(ACCEPTANCE_CRITERION_PATTERN);
    if (match?.groups) {
      acceptanceCriteria.push({
        id: match.groups.id.replace(/[_ ]/g, "-").toUpperCase(),
        text: match.groups.text.trim(),
      });
    } else {
      acceptanceCriteria.push({ id: `AC-${criterionIndex}`, text: item });
    }
  }

  // `getLabelNames` re-normalizes defensively (matching `ConvertTo-HdoIssueContract`
  // calling `Get-HdoLabelNames` again on its own input) even though `GithubIssue.labels`
  // is already typed as `string[]` by the time it reaches here.
  const labels = getLabelNames(issue.labels);
  const routeLabel = labels.find((label) => startsWithCaseInsensitive(label, ROUTE_LABEL_PREFIX));
  const priorityLabel = labels.find((label) => startsWithCaseInsensitive(label, PRIORITY_LABEL_PREFIX));
  const riskLabel = labels.find((label) => startsWithCaseInsensitive(label, RISK_LABEL_PREFIX));

  // GitHub.ps1:280-282's `if (-not $preferredExecution -and $routeLabel.Count -gt 0)
  // {...} elseif ($routeLabel.Count -gt 0) {...}` sets the identical value in both
  // branches; the net, parity-relevant effect is simply "a route label, if present,
  // ALWAYS overrides any body text" - ported directly rather than reproducing the
  // redundant branch.
  let preferredExecution = getMarkdownScalar(sections.preferredExecution ?? "");
  if (routeLabel) preferredExecution = routeLabel.slice(ROUTE_LABEL_PREFIX.length);

  let priority = getMarkdownScalar(sections.priority ?? "");
  if (priorityLabel) priority = priorityLabel.slice(PRIORITY_LABEL_PREFIX.length);

  let risk = getMarkdownScalar(sections.risk ?? "");
  if (riskLabel) risk = riskLabel.slice(RISK_LABEL_PREFIX.length);

  return {
    schemaVersion: 1,
    issue: {
      repository: issue.repository,
      number: issue.number,
      url: issue.url,
      updatedAt: issue.updatedAt,
      title: issue.title,
      state: issue.state,
      labels: [...labels],
      bodyHash: sha256Hex(body),
    },
    goal: getMarkdownScalar(sections.goal ?? ""),
    context: getMarkdownScalar(sections.context ?? ""),
    scope: {
      include: getMarkdownList(sections.scope ?? ""),
      exclude: getMarkdownList(sections.outOfScope ?? ""),
    },
    acceptanceCriteria,
    validationGates: getMarkdownList(sections.validationGates ?? "").map((gate) => gate.replace(/^`|`$/g, "").trim()),
    constraints: getMarkdownList(sections.constraints ?? ""),
    dependencies: getDependencyReferences(sections.dependencies ?? "", issue.repository),
    affectedAreas: getMarkdownList(sections.affectedAreas ?? ""),
    additionalContext: getMarkdownScalar(sections.additionalContext ?? ""),
    priority,
    risk,
    preferredExecution,
    capturedAt: now(),
  };
}
