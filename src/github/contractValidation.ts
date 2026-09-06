// Port of `Test-HdoReadyContentFreshness` (GitHub.ps1:117-138) and
// `Test-HdoIssueContract` (GitHub.ps1:320-395).
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { IssueContract, IssueContractValidationResult, ProjectContract, ReadyContentFreshnessResult, ResolvedHdoConfig } from "../core/contracts/types.ts";

/**
 * `[DateTimeOffset]::TryParse` equivalent for the ISO-8601-ish timestamps this module
 * deals with: `Date.parse` returns `NaN` for unparseable input, which this collapses
 * to `null` so callers can use a plain nullish check instead of an `isNaN` guard at
 * every call site. Exported for reuse by `claim.ts`'s claim-marker date validation
 * (`Get-HdoClaimComments`, GitHub.ps1:488-492), which needs the identical semantics.
 */
export function tryParseTimestamp(text: string): number | null {
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Port of `Test-HdoReadyContentFreshness` (GitHub.ps1:117-138): the ready label's
 * timestamp only ever needs to be AT LEAST as recent as the Issue's last content
 * edit. An Issue that was never edited after creation is always fresh; a missing/
 * unparseable timestamp fails closed (not fresh).
 */
export function testReadyContentFreshness(readyAt: string, lastEditedAt: string): ReadyContentFreshnessResult {
  const readyTimestamp = tryParseTimestamp(readyAt);
  if (readyTimestamp === null) {
    return { fresh: false, reason: "Ready timestamp could not be parsed." };
  }
  if (!lastEditedAt) {
    return { fresh: true, reason: "Issue content has not been edited since creation." };
  }
  const editedTimestamp = tryParseTimestamp(lastEditedAt);
  if (editedTimestamp === null) {
    return { fresh: false, reason: "Issue content edit timestamp could not be parsed." };
  }
  if (editedTimestamp > readyTimestamp) {
    return {
      fresh: false,
      reason: "Issue content changed after the ready label was applied; re-review it and re-apply the ready label.",
    };
  }
  return { fresh: true, reason: "Ready label covers the latest Issue content edit." };
}

export interface TestIssueContractOptions {
  config?: Pick<ResolvedHdoConfig, "github" | "profiles">;
  projectContract?: ProjectContract;
  requireReady?: boolean;
}

const VALIDATION_GATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ROUTE_HINT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const VALID_PRIORITIES = ["p0", "p1", "p2", "p3"];
const VALID_RISKS = ["low", "medium", "high", "critical"];
const EXCLUSIVE_LABEL_AXES = ["hdo:status/", "hdo:priority/", "hdo:risk/", "hdo:route/"];
const CATALOG_RISK_LABELS = ["hdo:risk/low", "hdo:risk/medium", "hdo:risk/high", "hdo:risk/critical"];

/** Case-insensitive `-contains`/`-in` equivalent (PowerShell's default string comparison). */
function includesCaseInsensitive(list: readonly string[], value: string): boolean {
  const target = value.toLowerCase();
  return list.some((item) => item.toLowerCase() === target);
}

/** Case-insensitive `.StartsWith(prefix, OrdinalIgnoreCase)`. */
function startsWithCaseInsensitive(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * Port of `Test-HdoIssueContract` (GitHub.ps1:320-395). Every PowerShell `-eq`/`-in`/
 * `-contains`/`-like`/hashtable `ContainsKey` used against label/gate-id text below is
 * case-insensitive by default, so this port uses the case-insensitive helpers above
 * (or explicit `.toLowerCase()` comparisons) at every corresponding site rather than
 * JS's case-sensitive `Array.includes`/`String.startsWith`.
 */
export function testIssueContract(
  contract: IssueContract,
  schemas: SchemaRegistry,
  options: TestIssueContractOptions = {},
): IssueContractValidationResult {
  const { config, projectContract, requireReady = false } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  const schemaValidation = schemas.get("issue-contract")(contract);
  if (!schemaValidation.valid) {
    errors.push(`Issue contract schema validation failed: ${schemaValidation.errors.join("; ")}`);
  }
  if (contract.schemaVersion !== 1) errors.push("Issue contract schemaVersion must be 1.");
  if (!contract.issue?.title) errors.push("Issue title is required.");
  if (!contract.context) errors.push("Issue section 'Problem / Context' is required.");
  if (!contract.goal) errors.push("Issue section 'Goal' is required.");
  if ((contract.scope?.include ?? []).length === 0) errors.push("Issue section 'In scope' must contain at least one item.");
  if ((contract.acceptanceCriteria ?? []).length === 0) {
    errors.push("Issue section 'Acceptance criteria' must contain at least one item.");
  }

  const seenAcceptanceIds = new Set<string>();
  for (const criterion of contract.acceptanceCriteria ?? []) {
    const criterionId = criterion.id ?? "";
    if (!criterionId) continue;
    const key = criterionId.toLowerCase();
    if (seenAcceptanceIds.has(key)) {
      errors.push(`Duplicate acceptance criterion id '${criterionId}'.`);
    } else {
      seenAcceptanceIds.add(key);
    }
  }

  if ((contract.validationGates ?? []).length === 0) {
    errors.push("Issue section 'Validation gate IDs' must contain at least one gate id.");
  }
  for (const gateId of contract.validationGates ?? []) {
    if (!VALIDATION_GATE_ID_PATTERN.test(gateId)) errors.push(`Invalid validation gate id '${gateId}'.`);
  }
  if (!includesCaseInsensitive(VALID_PRIORITIES, contract.priority ?? "")) {
    errors.push("Issue priority must be p0, p1, p2, or p3.");
  }
  if (!includesCaseInsensitive(VALID_RISKS, contract.risk ?? "")) {
    errors.push("Issue risk must be low, medium, high, or critical.");
  }

  const routeHint = contract.preferredExecution ?? "";
  if (routeHint && !ROUTE_HINT_PATTERN.test(routeHint)) errors.push(`Invalid route hint '${routeHint}'.`);
  if (routeHint && config) {
    const profileNames = Object.keys(config.profiles ?? {});
    if (!includesCaseInsensitive(profileNames, routeHint)) {
      errors.push(`Route hint '${routeHint}' does not name a configured profile.`);
    }
  }

  const labels = contract.issue?.labels ?? [];
  if (requireReady && config) {
    const readyLabel = config.github?.labels?.ready ?? "hdo:ready";
    if (!includesCaseInsensitive(labels, readyLabel)) errors.push(`Issue must have ready label '${readyLabel}'.`);
    const skipLabel = config.github?.labels?.skip ?? "hdo:skip";
    if (includesCaseInsensitive(labels, skipLabel)) errors.push(`Issue has exclusion label '${skipLabel}'.`);
    const statusPrefix = config.github?.labels?.statusPrefix ?? "hdo:status/";
    if (includesCaseInsensitive(labels, readyLabel) && labels.some((label) => startsWithCaseInsensitive(label, statusPrefix))) {
      errors.push(`Ready label '${readyLabel}' cannot coexist with an HDO status label.`);
    }
  }

  for (const axis of EXCLUSIVE_LABEL_AXES) {
    const matches = labels.filter((label) => startsWithCaseInsensitive(label, axis));
    if (matches.length > 1) errors.push(`Issue has multiple labels on exclusive axis '${axis}': ${matches.join(", ")}`);
  }

  if (config) {
    const allowedStatic = new Set<string>();
    const addAllowed = (value: string | undefined | null) => {
      if (value) allowedStatic.add(value.toLowerCase());
    };
    addAllowed(config.github?.labels?.ready ?? "hdo:ready");
    addAllowed(config.github?.labels?.skip ?? "hdo:skip");
    for (const value of Object.values(config.github?.labels ?? {})) addAllowed(value as string);
    for (const value of config.github?.priorityOrder ?? []) addAllowed(value);
    for (const value of CATALOG_RISK_LABELS) addAllowed(value);

    for (const label of labels.filter((candidate) => startsWithCaseInsensitive(candidate, "hdo:"))) {
      if (!allowedStatic.has(label.toLowerCase()) && !startsWithCaseInsensitive(label, "hdo:route/")) {
        errors.push(`Unknown reserved HDO label '${label}'.`);
      }
    }
  }

  if (projectContract) {
    const knownGateIds = new Set(projectContract.validationGates.map((gate) => gate.id.toLowerCase()));
    for (const gateId of contract.validationGates ?? []) {
      if (!knownGateIds.has(gateId.toLowerCase())) errors.push(`Issue references unknown validation gate '${gateId}'.`);
    }
  }

  if ((contract.scope?.exclude ?? []).length === 0) warnings.push("Issue section 'Out of scope' is empty.");

  return { valid: errors.length === 0, errors, warnings };
}
