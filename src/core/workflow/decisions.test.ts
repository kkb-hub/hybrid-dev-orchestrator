import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { applyValidationBlocker, decideNoDiff, decideReview, decideValidation } from "./decisions.ts";

// --- decideNoDiff --------------------------------------------------------------------

test("decideNoDiff: hasChanges true always continues regardless of policy", () => {
  // Oracle: Workflow.ps1:399-410 (the whole branch is skipped when $diff.hasChanges)
  assert.deepEqual(decideNoDiff(true, { workflow: { onNoDiff: "fail" } }), { kind: "continue" });
  assert.deepEqual(decideNoDiff(true, { workflow: { onNoDiff: "escalate" } }), { kind: "continue" });
  assert.deepEqual(decideNoDiff(true, {}), { kind: "continue" });
});

test("decideNoDiff: no changes + onNoDiff=escalate (case-insensitive) escalates", () => {
  assert.deepEqual(decideNoDiff(false, { workflow: { onNoDiff: "escalate" } }), { kind: "escalate" });
  assert.deepEqual(decideNoDiff(false, { workflow: { onNoDiff: "ESCALATE" } }), { kind: "escalate" });
});

test("decideNoDiff: no changes + default/other policy fails with the verbatim message", () => {
  // Oracle: Workflow.ps1:409
  assert.deepEqual(decideNoDiff(false, {}), {
    kind: "fail",
    message: "Implementation step completed without any worktree changes.",
  });
  assert.deepEqual(decideNoDiff(false, { workflow: { onNoDiff: "fail" } }), {
    kind: "fail",
    message: "Implementation step completed without any worktree changes.",
  });
});

// --- decideValidation ------------------------------------------------------------------

test("decideValidation: allRequiredPassed=true always continues without reading the policy", () => {
  // Oracle: Workflow.ps1:412 (`if (-not $validation.allRequiredPassed)` never entered)
  assert.deepEqual(decideValidation(true, { workflow: { onValidationFailure: "fail" } }), { kind: "continue" });
});

test("decideValidation: allRequiredPassed=false honours fail/escalate/default (case-insensitive)", () => {
  assert.deepEqual(decideValidation(false, { workflow: { onValidationFailure: "fail" } }), {
    kind: "fail",
    message: "One or more required validation gates did not pass.",
  });
  assert.deepEqual(decideValidation(false, { workflow: { onValidationFailure: "FAIL" } }), {
    kind: "fail",
    message: "One or more required validation gates did not pass.",
  });
  assert.deepEqual(decideValidation(false, { workflow: { onValidationFailure: "escalate" } }), { kind: "escalate" });
  // default (missing key) and the explicit 'request-changes' both continue into review.
  assert.deepEqual(decideValidation(false, {}), { kind: "continue" });
  assert.deepEqual(decideValidation(false, { workflow: { onValidationFailure: "request-changes" } }), {
    kind: "continue",
  });
});

// --- decideReview --------------------------------------------------------------------

test("decideReview: approve (case-insensitive)", () => {
  assert.deepEqual(decideReview({ decision: "approve" }, 0, 2, {}), { kind: "approve" });
  assert.deepEqual(decideReview({ decision: "APPROVE" }, 0, 2, {}), { kind: "approve" });
});

test("decideReview: escalate carries the escalation reason (Workflow.ps1:474)", () => {
  assert.deepEqual(decideReview({ decision: "escalate", escalationReason: "Ambiguous requirement." }, 0, 2, {}), {
    kind: "escalate",
    reason: "Ambiguous requirement.",
  });
  // [string]$null -> '' (trap 36)
  assert.deepEqual(decideReview({ decision: "escalate" }, 0, 2, {}), { kind: "escalate", reason: "" });
});

test("decideReview: request_changes below the fix limit returns request-changes", () => {
  // maxFixAttempts=2: fixAttempts 0 and 1 (PRE-increment) both request changes.
  assert.deepEqual(decideReview({ decision: "request_changes" }, 0, 2, {}), { kind: "request-changes" });
  assert.deepEqual(decideReview({ decision: "request_changes" }, 1, 2, {}), { kind: "request-changes" });
});

test("decideReview: request_changes at the fix limit returns fix-limit by default (onMaxFixAttempts=escalate)", () => {
  // Oracle: Workflow.ps1:476-481 - trap 32: three iterations total = maxFixAttempts + 1.
  assert.deepEqual(decideReview({ decision: "request_changes" }, 2, 2, {}), { kind: "fix-limit" });
  assert.deepEqual(decideReview({ decision: "request_changes" }, 2, 2, { workflow: { onMaxFixAttempts: "escalate" } }), {
    kind: "fix-limit",
  });
});

test("decideReview: request_changes at the fix limit fails when onMaxFixAttempts=fail (Workflow.ps1:477)", () => {
  assert.deepEqual(decideReview({ decision: "request_changes" }, 2, 2, { workflow: { onMaxFixAttempts: "fail" } }), {
    kind: "fail",
    message: "Maximum fix attempts reached with open findings.",
  });
  assert.deepEqual(decideReview({ decision: "request_changes" }, 3, 2, { workflow: { onMaxFixAttempts: "FAIL" } }), {
    kind: "fail",
    message: "Maximum fix attempts reached with open findings.",
  });
});

// --- applyValidationBlocker ------------------------------------------------------------

const compressJson = (value: unknown): string => JSON.stringify(value);

test("applyValidationBlocker rewrites decision/summary and appends the synthetic finding (Workflow.ps1:438-459)", () => {
  const review: JsonObject = { decision: "approve", summary: "Looks fine.", findings: [] };
  const validation: JsonObject = { allRequiredPassed: false, failed: 1, passed: 1, indeterminate: 0 };
  const result = applyValidationBlocker(review, validation, 1, compressJson);

  assert.equal(result.decision, "request_changes");
  assert.equal(result.summary, "HDO rejected approval because required validation did not pass. Looks fine.");
  assert.ok(Array.isArray(result.findings));
  const findings = result.findings as JsonObject[];
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    id: "HDO-VALIDATION-R1",
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
  });
});

test("applyValidationBlocker does not mutate the input review", () => {
  const review: JsonObject = { decision: "approve", summary: "Looks fine.", findings: [] };
  const before = JSON.stringify(review);
  applyValidationBlocker(review, { allRequiredPassed: false }, 1, compressJson);
  assert.equal(JSON.stringify(review), before);
});

test("applyValidationBlocker de-dups the synthetic id with a -<n> suffix when it already exists, case-insensitively", () => {
  const review: JsonObject = { decision: "approve", summary: "x", findings: [{ id: "HDO-VALIDATION-R1" }] };
  const result = applyValidationBlocker(review, { allRequiredPassed: false }, 1, compressJson);
  const findings = result.findings as JsonObject[];
  assert.equal(findings.length, 2);
  assert.equal(findings[1].id, "HDO-VALIDATION-R1-1");

  const reviewCaseVariant: JsonObject = { decision: "approve", summary: "x", findings: [{ id: "hdo-validation-r1" }] };
  const resultCaseVariant = applyValidationBlocker(reviewCaseVariant, { allRequiredPassed: false }, 1, compressJson);
  const findingsCaseVariant = resultCaseVariant.findings as JsonObject[];
  assert.equal(findingsCaseVariant[1].id, "HDO-VALIDATION-R1-1");
});

test("applyValidationBlocker advances the suffix past every already-taken id", () => {
  const review: JsonObject = {
    decision: "approve",
    summary: "x",
    findings: [{ id: "HDO-VALIDATION-R2" }, { id: "HDO-VALIDATION-R2-1" }],
  };
  const result = applyValidationBlocker(review, { allRequiredPassed: false }, 2, compressJson);
  const findings = result.findings as JsonObject[];
  assert.equal(findings[2].id, "HDO-VALIDATION-R2-2");
});

test("applyValidationBlocker preserves existing findings ahead of the synthetic one", () => {
  const review: JsonObject = {
    decision: "approve",
    summary: "x",
    findings: [{ id: "MOCK-R1-F1", status: "resolved" }],
  };
  const result = applyValidationBlocker(review, { allRequiredPassed: false }, 1, compressJson);
  const findings = result.findings as JsonObject[];
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], { id: "MOCK-R1-F1", status: "resolved" });
  assert.equal(findings[1].id, "HDO-VALIDATION-R1");
});
