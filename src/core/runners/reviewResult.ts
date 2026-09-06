// Port of `Test-HdoReviewResult` (Runner.ps1:762-816). Error strings are copied
// verbatim from the PowerShell source; every comparison against PS `-eq`/`-ne`/`-in`/
// `-notin` is case-insensitive (ADR-0001 phase 5 plan §7 risk 1), and finding ids are
// deduplicated in a case-insensitive set (`[StringComparer]::OrdinalIgnoreCase`,
// Runner.ps1:782).
import { getValue } from "../config/value.ts";
import type { JsonObject } from "../contracts/types.ts";
import {
  addCaseInsensitive,
  asNumber,
  asString,
  equalsIgnoreCase,
  hdoArrayCount,
  hdoArrayItems,
  inIgnoreCase,
  isTruthy,
} from "./psSemantics.ts";

export interface ReviewResultCheck {
  valid: boolean;
  errors: string[];
}

/** Port of `Test-HdoReviewResult` (Runner.ps1:762-816). */
export function testReviewResult(
  review: JsonObject,
  previousReview?: JsonObject | null,
  expectedRound = 0,
  expectedRunId = "",
  expectedBaseCommit = "",
  expectedDiffHash = "",
): ReviewResultCheck {
  const errors: string[] = [];

  const decision = asString(getValue(review, "decision", ""));
  // Oracle: Runner.ps1:774, "Invalid review decision '<decision>'."
  if (!inIgnoreCase(decision, ["approve", "request_changes", "escalate"])) {
    errors.push(`Invalid review decision '${decision}'.`);
  }
  // Oracle: Runner.ps1:776, "reviewRound must be <n> for this iteration."
  if (expectedRound > 0 && asNumber(getValue(review, "reviewRound", 0), 0) !== expectedRound) {
    errors.push(`reviewRound must be ${expectedRound} for this iteration.`);
  }
  // Oracle: Runner.ps1:778, "Review runId does not match the active run."
  if (expectedRunId && !equalsIgnoreCase(asString(getValue(review, "runId", "")), expectedRunId)) {
    errors.push("Review runId does not match the active run.");
  }
  // Oracle: Runner.ps1:779, "Review baseCommit does not match the reviewed worktree base."
  if (expectedBaseCommit && !equalsIgnoreCase(asString(getValue(review, "baseCommit", "")), expectedBaseCommit)) {
    errors.push("Review baseCommit does not match the reviewed worktree base.");
  }
  // Oracle: Runner.ps1:780, "Review diffHash does not match the reviewed patch."
  if (expectedDiffHash && !equalsIgnoreCase(asString(getValue(review, "diffHash", "")), expectedDiffHash)) {
    errors.push("Review diffHash does not match the reviewed patch.");
  }
  // Oracle: Runner.ps1:781, "missingViewpoints must be present, even when empty."
  if (!Object.prototype.hasOwnProperty.call(review, "missingViewpoints")) {
    errors.push("missingViewpoints must be present, even when empty.");
  }

  const ids = new Set<string>();
  let actionableOpen = 0;
  let blockingOpen = 0;
  for (const finding of hdoArrayItems(getValue(review, "findings", []))) {
    const id = asString(getValue(finding, "id", ""));
    // Oracle: Runner.ps1:787, "Every finding must have an id."
    if (!id) {
      errors.push("Every finding must have an id.");
      // Oracle: Runner.ps1:788, "Duplicate finding id '<id>'."
    } else if (!addCaseInsensitive(ids, id)) {
      errors.push(`Duplicate finding id '${id}'.`);
    }
    const severity = asString(getValue(finding, "severity", ""));
    const status = asString(getValue(finding, "status", "open"));
    if (equalsIgnoreCase(status, "open") && isTruthy(getValue(finding, "actionable", false))) actionableOpen++;
    if (equalsIgnoreCase(status, "open") && inIgnoreCase(severity, ["blocker", "should"])) blockingOpen++;
    // Oracle: Runner.ps1:793, "Indeterminate finding '<id>' requires escalation."
    if (equalsIgnoreCase(status, "indeterminate") && !equalsIgnoreCase(decision, "escalate")) {
      errors.push(`Indeterminate finding '${id}' requires escalation.`);
    }
  }

  // Oracle: Runner.ps1:796, "request_changes requires at least one open actionable finding."
  if (equalsIgnoreCase(decision, "request_changes") && actionableOpen === 0) {
    errors.push("request_changes requires at least one open actionable finding.");
  }
  // Oracle: Runner.ps1:799, "approve cannot contain open blocker/should findings."
  if (equalsIgnoreCase(decision, "approve") && blockingOpen > 0) {
    errors.push("approve cannot contain open blocker/should findings.");
  }
  // Oracle: Runner.ps1:802, "escalate requires escalationReason."
  if (equalsIgnoreCase(decision, "escalate") && !isTruthy(getValue(review, "escalationReason", ""))) {
    errors.push("escalate requires escalationReason.");
  }
  // Oracle: Runner.ps1:805, "Missing viewpoints require escalation."
  if (hdoArrayCount(getValue(review, "missingViewpoints", [])) > 0 && !equalsIgnoreCase(decision, "escalate")) {
    errors.push("Missing viewpoints require escalation.");
  }

  if (previousReview) {
    for (const previousFinding of hdoArrayItems(getValue(previousReview, "findings", []))) {
      const previousId = asString(getValue(previousFinding, "id", ""));
      // Oracle: Runner.ps1:811, "Finding '<id>' disappeared; carry it forward with resolved, waived, or refuted status."
      if (previousId && !ids.has(previousId.toLowerCase())) {
        errors.push(`Finding '${previousId}' disappeared; carry it forward with resolved, waived, or refuted status.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
