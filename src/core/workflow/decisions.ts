// Pure policy decisions from the `Invoke-HdoRun` dispatch loop (Workflow.ps1:216-549).
// Each function returns a discriminated union describing what the host should do
// next; the host (`src/workflow/run.ts`, WP-F2) is the one that actually throws with
// the exact PS text, transitions state via `RunStore.setState`, and writes artifacts -
// this module never throws except where documented (`applyValidationBlocker` never
// throws at all; it is a pure transform).
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import { asString, equalsIgnoreCase, hdoArrayItems, inIgnoreCase, isPlainObject } from "../runners/psSemantics.ts";

export type NoDiffDecision = { kind: "continue" } | { kind: "escalate" } | { kind: "fail"; message: string };

/**
 * Oracle: Workflow.ps1:399-410. Called only when the caller already knows
 * `hasChanges` (`$diff.hasChanges`); `continue` covers both "there were changes" and
 * anything not explicitly handled, matching the PS `if (-not $diff.hasChanges) { ... }`
 * guard - the whole no-diff branch (including the throw) is skipped when changes
 * exist.
 */
export function decideNoDiff(hasChanges: boolean, config: JsonObject): NoDiffDecision {
  if (hasChanges) return { kind: "continue" };
  const policy = asString(getValue(config, "workflow.onNoDiff", "fail"));
  if (equalsIgnoreCase(policy, "escalate")) return { kind: "escalate" };
  return { kind: "fail", message: "Implementation step completed without any worktree changes." };
}

export type ValidationDecision = { kind: "continue" } | { kind: "escalate" } | { kind: "fail"; message: string };

/**
 * Oracle: Workflow.ps1:412-423. `allRequiredPassed = true` always continues without
 * even reading the policy (PS never enters the `if (-not $validation.allRequiredPassed)`
 * block). Any policy value other than `fail`/`escalate` (including the default
 * `request-changes`) continues into the review step, exactly like PS's implicit
 * fallthrough.
 */
export function decideValidation(allRequiredPassed: boolean, config: JsonObject): ValidationDecision {
  if (allRequiredPassed) return { kind: "continue" };
  const policy = asString(getValue(config, "workflow.onValidationFailure", "request-changes"));
  if (equalsIgnoreCase(policy, "fail")) {
    return { kind: "fail", message: "One or more required validation gates did not pass." };
  }
  if (equalsIgnoreCase(policy, "escalate")) return { kind: "escalate" };
  return { kind: "continue" };
}

export type ReviewDecision =
  | { kind: "approve" }
  | { kind: "escalate"; reason: string }
  | { kind: "request-changes" }
  | { kind: "fix-limit" }
  | { kind: "fail"; message: string };

/**
 * Oracle: Workflow.ps1:465-486. `review` is expected to already reflect the
 * validation-blocker rewrite (`applyValidationBlocker`) when applicable - PS applies
 * that rewrite at :438-464, strictly before the decision checks below, so a caller
 * that skipped it would see a stale `approve` decision here. `fixAttempts`/
 * `maxFixAttempts` are read PRE-increment (Workflow.ps1 §5 trap 32): with
 * `maxFixAttempts = 2`, rounds where `fixAttempts` is 0 or 1 return `request-changes`;
 * the round where `fixAttempts` is already 2 hits the limit.
 */
export function decideReview(
  review: JsonObject,
  fixAttempts: number,
  maxFixAttempts: number,
  config: JsonObject,
): ReviewDecision {
  const decision = asString(review.decision);
  if (equalsIgnoreCase(decision, "approve")) return { kind: "approve" };
  if (equalsIgnoreCase(decision, "escalate")) {
    return { kind: "escalate", reason: asString(review.escalationReason) };
  }
  if (fixAttempts >= maxFixAttempts) {
    const policy = asString(getValue(config, "workflow.onMaxFixAttempts", "escalate"));
    if (equalsIgnoreCase(policy, "fail")) {
      return { kind: "fail", message: "Maximum fix attempts reached with open findings." };
    }
    return { kind: "fix-limit" };
  }
  return { kind: "request-changes" };
}

/** Deep-copies a JSON-shaped value without mutating the input (no `structuredClone` dependency). */
function deepCopyJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Oracle: Workflow.ps1:438-459 (`review.decision -eq 'approve' -and -not
 * $validation.allRequiredPassed`). Returns a NEW object; PS mutates `$review` in
 * place, but by the time this runs `Invoke-HdoAgentStep` has already written
 * `review/final.json` with the reviewer's original `approve` decision (Runner.ps1:724)
 * - `review/result.json` (written after this transform, Workflow.ps1:465) is the only
 * artifact that ever holds the rewritten `request_changes`, so a fresh object here is
 * observably identical to PS's in-place mutation. The existing-id set used for the
 * de-dup suffix loop is computed ONCE, before the loop starts (mirroring PS, which
 * never recomputes `$existingFindingIds` inside its `while` loop) - `-contains` is
 * case-insensitive (`inIgnoreCase`), so `hdo-validation-r1` collides with
 * `HDO-VALIDATION-R1` too.
 */
export function applyValidationBlocker(
  review: JsonObject,
  validation: JsonObject,
  iteration: number,
  compressJson: (value: JsonValue) => string,
): JsonObject {
  const copy = deepCopyJson(review);
  copy.decision = "request_changes";
  copy.summary = `HDO rejected approval because required validation did not pass. ${asString(review.summary)}`;

  const existingFindings = hdoArrayItems(copy.findings);
  const existingFindingIds = existingFindings.map((finding) =>
    isPlainObject(finding) ? asString(finding.id) : asString(finding),
  );

  let syntheticFindingId = `HDO-VALIDATION-R${iteration}`;
  let suffix = 1;
  while (inIgnoreCase(syntheticFindingId, existingFindingIds)) {
    syntheticFindingId = `HDO-VALIDATION-R${iteration}-${suffix}`;
    suffix++;
  }

  copy.findings = [
    ...existingFindings,
    {
      id: syntheticFindingId,
      severity: "blocker",
      category: "test_detection",
      evidence: "measured",
      evidenceDetail: compressJson(validation),
      status: "open",
      actionable: true,
      path: ".hdo/project.json",
      line: null,
      message: "One or more required validation gates did not pass.",
      requiredAction: "Fix the failures or make the validation result conclusive, then re-run all required gates.",
    },
  ];

  return copy;
}
