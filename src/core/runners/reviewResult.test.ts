// Ports `Test-HdoReviewResult` fixtures and their named assertions from
// `tests/run-tests.ps1:1028-1061`, plus one assertion per remaining error string copied
// verbatim from `Test-HdoReviewResult` (Runner.ps1:774-811). Reads the real
// `tests/fixtures/schema/review.valid.json` fixture from disk (this is a *.test.ts
// file, exempt from the core boundary rule - see `src/core/boundary.test.ts`'s module
// banner).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../contracts/types.ts";
import { testReviewResult } from "./reviewResult.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");
const REVIEW_FIXTURE_PATH = resolvePath(REPO_ROOT, "tests", "fixtures", "schema", "review.valid.json");

function loadValidReview(): JsonObject {
  return JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8")) as JsonObject;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Oracle: tests/run-tests.ps1:1028-1038, "review findings cannot disappear across rounds"
test("review findings cannot disappear across rounds", () => {
  const previousReview = loadValidReview();
  const missingFindingReview = deepClone(previousReview);
  missingFindingReview.reviewRound = 2;
  missingFindingReview.decision = "approve";
  missingFindingReview.summary = "The prior finding disappeared.";
  missingFindingReview.findings = [];

  const result = testReviewResult(missingFindingReview, previousReview, 2);
  assert.equal(result.valid, false);
});

// Oracle: tests/run-tests.ps1:1040-1051, "review findings can be carried forward with a
// terminal status"
test("review findings can be carried forward with a terminal status", () => {
  const previousReview = loadValidReview();
  const carriedFindingReview = deepClone(previousReview);
  carriedFindingReview.reviewRound = 2;
  carriedFindingReview.decision = "approve";
  carriedFindingReview.summary = "The prior finding is resolved.";
  const findings = carriedFindingReview.findings as JsonObject[];
  findings[0].status = "resolved";
  findings[0].actionable = false;
  findings[0].requiredAction = null;

  const result = testReviewResult(carriedFindingReview, previousReview, 2);
  assert.equal(result.valid, true, `expected valid, got errors: ${result.errors.join("; ")}`);
});

// Oracle: tests/run-tests.ps1:1053-1061, "review finding IDs are unique without regard
// to case"
test("review finding IDs are unique without regard to case", () => {
  const previousReview = loadValidReview();
  const duplicateFindingReview = deepClone(previousReview);
  const findings = duplicateFindingReview.findings as JsonObject[];
  const caseVariantFinding = deepClone(findings[0]);
  caseVariantFinding.id = String(caseVariantFinding.id).toLowerCase();
  findings.push(caseVariantFinding);

  const result = testReviewResult(duplicateFindingReview);
  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------------
// One assertion per remaining error string, copied verbatim from
// Test-HdoReviewResult (Runner.ps1:774-811). Not individually named in
// run-tests.ps1's named-assertion list, but exercised there via the parity fixtures
// under tests/fixtures/schema/review.invalid-*.json; asserted directly here so a
// change to any one error string is caught by name.
// ---------------------------------------------------------------------------

function baseValidReview(): JsonObject {
  return loadValidReview();
}

// Oracle: Runner.ps1:774, "Invalid review decision '<decision>'."
test("testReviewResult: an invalid decision is rejected", () => {
  const review = baseValidReview();
  review.decision = "not-a-real-decision";
  const result = testReviewResult(review);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("Invalid review decision 'not-a-real-decision'."));
});

test("testReviewResult: decision is compared case-insensitively (PS -notin)", () => {
  const review = baseValidReview();
  review.decision = "REQUEST_CHANGES";
  const result = testReviewResult(review);
  assert.ok(!result.errors.some((error) => error.startsWith("Invalid review decision")));
});

// Oracle: Runner.ps1:776, "reviewRound must be <n> for this iteration."
test("testReviewResult: reviewRound must match the expected round", () => {
  const review = baseValidReview();
  review.reviewRound = 1;
  const result = testReviewResult(review, null, 3);
  assert.ok(result.errors.includes("reviewRound must be 3 for this iteration."));
});

// Oracle: Runner.ps1:778, "Review runId does not match the active run."
test("testReviewResult: runId must match the expected run (case-insensitively)", () => {
  const review = baseValidReview();
  const result = testReviewResult(review, null, 0, "some-other-run-id");
  assert.ok(result.errors.includes("Review runId does not match the active run."));
  const caseOnly = testReviewResult(review, null, 0, String(review.runId).toUpperCase());
  assert.ok(!caseOnly.errors.includes("Review runId does not match the active run."));
});

// Oracle: Runner.ps1:779, "Review baseCommit does not match the reviewed worktree base."
test("testReviewResult: baseCommit must match the expected base commit", () => {
  const review = baseValidReview();
  const result = testReviewResult(review, null, 0, "", "0000000000000000000000000000000000000000");
  assert.ok(result.errors.includes("Review baseCommit does not match the reviewed worktree base."));
});

// Oracle: Runner.ps1:780, "Review diffHash does not match the reviewed patch."
test("testReviewResult: diffHash must match the expected diff hash", () => {
  const review = baseValidReview();
  const result = testReviewResult(review, null, 0, "", "", "0".repeat(64));
  assert.ok(result.errors.includes("Review diffHash does not match the reviewed patch."));
});

// Oracle: Runner.ps1:781, "missingViewpoints must be present, even when empty."
test("testReviewResult: missingViewpoints must be present as a key, even when empty", () => {
  const review = baseValidReview();
  delete review.missingViewpoints;
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("missingViewpoints must be present, even when empty."));
});

// Oracle: Runner.ps1:787, "Every finding must have an id."
test("testReviewResult: every finding must have an id", () => {
  const review = baseValidReview();
  const findings = review.findings as JsonObject[];
  delete findings[0].id;
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("Every finding must have an id."));
});

// Oracle: Runner.ps1:793, "Indeterminate finding '<id>' requires escalation."
test("testReviewResult: an indeterminate finding requires an escalate decision", () => {
  const review = baseValidReview();
  const findings = review.findings as JsonObject[];
  const id = String(findings[0].id);
  findings[0].status = "indeterminate";
  review.decision = "request_changes";
  const result = testReviewResult(review);
  assert.ok(result.errors.includes(`Indeterminate finding '${id}' requires escalation.`));
});

// Oracle: Runner.ps1:796, "request_changes requires at least one open actionable finding."
test("testReviewResult: request_changes requires at least one open actionable finding", () => {
  const review = baseValidReview();
  const findings = review.findings as JsonObject[];
  findings[0].actionable = false;
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("request_changes requires at least one open actionable finding."));
});

// Oracle: Runner.ps1:799, "approve cannot contain open blocker/should findings."
test("testReviewResult: approve cannot contain open blocker/should findings", () => {
  const review = baseValidReview();
  review.decision = "approve";
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("approve cannot contain open blocker/should findings."));
});

// Oracle: Runner.ps1:802, "escalate requires escalationReason."
test("testReviewResult: escalate requires a truthy escalationReason", () => {
  const review = baseValidReview();
  review.decision = "escalate";
  review.escalationReason = null;
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("escalate requires escalationReason."));
});

// Oracle: Runner.ps1:805, "Missing viewpoints require escalation."
test("testReviewResult: a non-empty missingViewpoints requires an escalate decision", () => {
  const review = baseValidReview();
  review.missingViewpoints = ["security"];
  const result = testReviewResult(review);
  assert.ok(result.errors.includes("Missing viewpoints require escalation."));
});

// Oracle: Runner.ps1:788, "Duplicate finding id '<id>'."
test("testReviewResult: exact error text for a duplicate finding id", () => {
  const review = baseValidReview();
  const findings = review.findings as JsonObject[];
  const id = String(findings[0].id);
  findings.push(deepClone(findings[0]));
  const result = testReviewResult(review);
  assert.ok(result.errors.includes(`Duplicate finding id '${id}'.`));
});

test("testReviewResult: a fully valid review (no expectations) has no errors", () => {
  const review = baseValidReview();
  const result = testReviewResult(review);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});
