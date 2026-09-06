import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { IssueContract, JsonObject } from "../contracts/types.ts";
import {
  REASONS,
  SUMMARIES,
  approveResult,
  classifyRunFailure,
  createRunRecord,
  formatRunIdStamp,
  isWriteBackEnabled,
  maxFixEscalateResult,
  newRunId,
  noDiffEscalateResult,
  reviewEscalateResult,
  syntheticTaskContract,
  validationEscalateResult,
} from "./runRecord.ts";

// --- formatRunIdStamp / newRunId --------------------------------------------------

test("formatRunIdStamp renders yyyyMMddTHHmmssZ with T and Z as literals", () => {
  // Oracle: Common.ps1:703, verified 2026-09-06: `[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')` -> `20260906T113551Z`
  assert.equal(formatRunIdStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102T030405Z");
});

test("formatRunIdStamp zero-pads every field", () => {
  assert.equal(formatRunIdStamp(new Date(Date.UTC(2026, 8, 6, 1, 2, 3))), "20260906T010203Z");
});

test("newRunId builds issue-<n>-<stamp>-<hex8> and lower-cases the hex suffix", () => {
  // Oracle: Common.ps1:701-708
  const id = newRunId(7, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "ABCDEF01");
  assert.equal(id, "issue-7-20260102T030405Z-abcdef01");
  assert.match(id, /^issue-7-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
});

test("newRunId falls back to run-<stamp>-<hex8> for a non-positive issue number (unreachable from Invoke-HdoRun, kept faithfully)", () => {
  const id = newRunId(0, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), "ABCDEF01");
  assert.equal(id, "run-20260102T030405Z-abcdef01");
});

// --- isWriteBackEnabled ------------------------------------------------------------

test("isWriteBackEnabled truth table", () => {
  // Oracle: Workflow.ps1:156-165 (`Test-HdoWriteBackEnabled`)
  // -NoWriteBack always wins, even over an explicit boolean true setting.
  assert.equal(isWriteBackEnabled({ github: { writeBack: true } }, true), false);
  // A real JSON boolean is returned as-is.
  assert.equal(isWriteBackEnabled({ github: { writeBack: false } }, false), false);
  assert.equal(isWriteBackEnabled({ github: { writeBack: true } }, false), true);
  // String settings compared case-insensitively against the "off" spellings.
  assert.equal(isWriteBackEnabled({ github: { writeBack: "OFF" } }, false), false);
  assert.equal(isWriteBackEnabled({ github: { writeBack: "none" } }, false), false);
  assert.equal(isWriteBackEnabled({ github: { writeBack: "FALSE" } }, false), false);
  assert.equal(isWriteBackEnabled({ github: { writeBack: "" } }, false), false);
  assert.equal(isWriteBackEnabled({ github: { writeBack: "Status" } }, false), true);
  assert.equal(isWriteBackEnabled({ github: { writeBack: "anything-else" } }, false), true);
  // Missing setting defaults to 'status' -> enabled.
  assert.equal(isWriteBackEnabled({}, false), true);
});

// --- classifyRunFailure -------------------------------------------------------------

test("classifyRunFailure is PREFLIGHT_FAILED only when state is PREFLIGHT at catch time", () => {
  // Oracle: Workflow.ps1:525
  assert.equal(classifyRunFailure("PREFLIGHT"), "PREFLIGHT_FAILED");
  for (const state of ["CREATED", "ISSUE_SELECTED", "ISSUE_CLAIMED", "WORKTREE_READY", "IMPLEMENTING", "VALIDATING", "REVIEWING", "CHANGES_REQUESTED"] as const) {
    assert.equal(classifyRunFailure(state), "RUN_FAILED", state);
  }
});

// --- syntheticTaskContract -----------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../../../tests/fixtures/schema/", import.meta.url));

test("syntheticTaskContract mirrors New-HdoSyntheticTaskContract (Workflow.ps1:199-211)", () => {
  const issueContract = JSON.parse(readFileSync(`${FIXTURE_DIR}issue.valid.json`, "utf8")) as IssueContract;
  const contract = syntheticTaskContract(issueContract);
  assert.deepEqual(contract, {
    schemaVersion: 1,
    objective: "Pick up a ready issue and complete implementation and review.",
    approach: ["Implement the normalized GitHub Issue contract directly."],
    acceptanceCriteria: ["AC-1: A ready issue can progress through planning, implementation, and review."],
    expectedFiles: [],
    risks: [],
    assumptions: [],
  });
});

// --- createRunRecord -----------------------------------------------------------------

function issueContractFixture(): IssueContract {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}issue.valid.json`, "utf8")) as IssueContract;
}

test("createRunRecord builds the initial run object with Workflow.ps1:280-299's key order", () => {
  const issueContract = issueContractFixture();
  const config: JsonObject = {
    resolvedProfile: "cloud-only",
    workflow: { maxFixAttempts: 2.9 },
    configurationWarnings: ["overlay applied"],
  };
  const record = createRunRecord({
    id: "issue-7-20260102T030405Z-abcdef01",
    now: "2026-01-02T03:04:05.000Z",
    repositoryPath: "C:\\repo",
    artifactPath: "C:\\artifacts\\issue-7-20260102T030405Z-abcdef01",
    config,
    issueContract,
    executionPlan: { generatedAt: "2026-01-02T03:04:05.000Z", runners: {} },
    readyAuthorization: { authorized: true, enforced: true, actor: "fixture-owner", readyAt: "2026-01-02T00:00:00Z", reason: "ok" },
    dependencyValidation: { resolved: true, checks: [], unresolved: [] },
    contractWarnings: ["one out-of-scope item"],
    writeBack: true,
  });

  assert.deepEqual(Object.keys(record), [
    "schemaVersion",
    "id",
    "state",
    "createdAt",
    "updatedAt",
    "repositoryPath",
    "artifactPath",
    "profile",
    "iteration",
    "fixAttempts",
    "maxFixAttempts",
    "issue",
    "execution",
    "worktree",
    "github",
    "result",
    "error",
    "warnings",
  ]);
  assert.equal(record.state, "CREATED");
  assert.equal(record.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(record.updatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(record.profile, "cloud-only");
  assert.equal(record.iteration, 0);
  assert.equal(record.fixAttempts, 0);
  // Math.trunc([int] cast semantics): 2.9 truncates to 2, not rounds to 3.
  assert.equal(record.maxFixAttempts, 2);
  assert.deepEqual(record.issue, issueContract.issue);
  assert.equal(record.worktree, null);
  assert.deepEqual(record.github, {
    writeBack: true,
    readyAuthorization: { authorized: true, enforced: true, actor: "fixture-owner", readyAt: "2026-01-02T00:00:00Z", reason: "ok" },
    dependencyValidation: { resolved: true, checks: [], unresolved: [] },
    claim: null,
  });
  assert.equal(record.result, null);
  assert.equal(record.error, null);
  // warnings = [...contractValidation.warnings, ...config.configurationWarnings], both @()-wrapped.
  assert.deepEqual(record.warnings, ["one out-of-scope item", "overlay applied"]);
  // activity must be ABSENT (not present with value undefined either).
  assert.equal(Object.prototype.hasOwnProperty.call(record, "activity"), false);
});

test("createRunRecord defaults maxFixAttempts to 0 and profile/configurationWarnings to safe fallbacks when absent", () => {
  const record = createRunRecord({
    id: "issue-7-20260102T030405Z-abcdef01",
    now: "2026-01-02T03:04:05.000Z",
    repositoryPath: "C:\\repo",
    artifactPath: "C:\\artifacts\\x",
    config: {},
    issueContract: issueContractFixture(),
    executionPlan: {},
    readyAuthorization: { authorized: true, enforced: false, actor: null, readyAt: null, reason: "" },
    dependencyValidation: { resolved: true, checks: [], unresolved: [] },
    contractWarnings: [],
    writeBack: false,
  });
  assert.equal(record.maxFixAttempts, 0);
  assert.equal(record.profile, null);
  assert.deepEqual(record.warnings, []);
});

// --- REASONS / SUMMARIES (verbatim strings, §2.3/§2.4) -------------------------------

test("REASONS carries every static transition-reason string verbatim", () => {
  assert.equal(REASONS.issueSelected, "GitHub Issue resolved and contract validated.");
  assert.equal(REASONS.preflightChecking, "Checking selected adapters and local environment.");
  assert.equal(REASONS.issueClaimed, "GitHub claim marker won the best-effort lock.");
  assert.equal(REASONS.worktreeReady, "Isolated Git worktree created.");
  assert.equal(REASONS.planningStarted, "Read-only planning step started.");
  assert.equal(REASONS.initialImplementation, "Initial implementation started.");
  assert.equal(REASONS.fixIterationStarted, "Fix iteration started.");
  assert.equal(REASONS.validatingStarted, "Trusted project validation gates started.");
  assert.equal(REASONS.noDiff, "Implementation produced no diff.");
  assert.equal(REASONS.validationFailed, "Required validation did not pass.");
  assert.equal(REASONS.reviewingStarted, "Read-only structured review started.");
  assert.equal(REASONS.fixLimitReached, "Reviewer requested changes at the fix limit.");
  assert.equal(REASONS.actionableFindings, "Reviewer returned actionable findings.");
  assert.equal(REASONS.approved, "Reviewer approved a diff with all required validation gates passing.");
  assert.equal(REASONS.noDiffEscalated, "No diff requires Human attention.");
  assert.equal(REASONS.validationEscalated, "Validation policy requires Human attention.");
  assert.equal(REASONS.maxFixReached, "Maximum fix attempts reached.");
});

test("SUMMARIES carries every result.summary literal verbatim", () => {
  assert.equal(SUMMARIES.noDiff, "Implementation produced no diff.");
  assert.equal(SUMMARIES.validation, "Required validation did not pass.");
  assert.equal(SUMMARIES.maxFix, "Maximum fix attempts reached with open findings.");
});

// --- terminal result builders (§2.4 key order) ---------------------------------------

test("approveResult: decision, summary, diffHash, validation, completedAt (Workflow.ps1:466)", () => {
  const review: JsonObject = { summary: "All good.", decision: "approve" };
  const validation: JsonObject = { allRequiredPassed: true };
  const result = approveResult(review, "deadbeef", validation, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(result), ["decision", "summary", "diffHash", "validation", "completedAt"]);
  assert.deepEqual(result, {
    decision: "approve",
    summary: "All good.",
    diffHash: "deadbeef",
    validation,
    completedAt: "2026-01-02T03:04:05.000Z",
  });
});

test("reviewEscalateResult: decision, summary, reason, diffHash, completedAt (Workflow.ps1:471)", () => {
  const review: JsonObject = { summary: "Needs a human.", decision: "escalate", escalationReason: "Ambiguous requirement." };
  const result = reviewEscalateResult(review, "deadbeef", "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(result), ["decision", "summary", "reason", "diffHash", "completedAt"]);
  assert.deepEqual(result, {
    decision: "escalate",
    summary: "Needs a human.",
    reason: "Ambiguous requirement.",
    diffHash: "deadbeef",
    completedAt: "2026-01-02T03:04:05.000Z",
  });
});

test("noDiffEscalateResult: decision, summary, diffHash, completedAt - no reason field (Workflow.ps1:403)", () => {
  const result = noDiffEscalateResult("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(result), ["decision", "summary", "diffHash", "completedAt"]);
  assert.equal(result.summary, "Implementation produced no diff.");
});

test("validationEscalateResult: decision, summary, diffHash, validation, completedAt (Workflow.ps1:418)", () => {
  const validation: JsonObject = { allRequiredPassed: false, failed: 1 };
  const result = validationEscalateResult("deadbeef", validation, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(result), ["decision", "summary", "diffHash", "validation", "completedAt"]);
  assert.equal(result.summary, "Required validation did not pass.");
  assert.deepEqual(result.validation, validation);
});

test("maxFixEscalateResult: decision, summary, findings, diffHash, completedAt (Workflow.ps1:480)", () => {
  const findings = [{ id: "MOCK-R3-F1" }];
  const result = maxFixEscalateResult(findings, "deadbeef", "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(result), ["decision", "summary", "findings", "diffHash", "completedAt"]);
  assert.equal(result.summary, "Maximum fix attempts reached with open findings.");
  assert.deepEqual(result.findings, findings);
});
