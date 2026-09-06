// Byte-exact parity with the PowerShell here-strings (Runner.ps1:936-1025) is covered by
// the WP-H cross-implementation parity test; the assertions below check the TS side in
// isolation: exact first line, section headers in order, value interpolation, the
// `previousReview: undefined` -> `null` rendering, and no trailing newline.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IssueContract, ProjectContract, ReviewResult } from "../contracts/types.ts";
import { buildFixPrompt, buildImplementationPrompt, buildPlanPrompt, buildReviewPrompt, type PromptDiff } from "./prompts.ts";

function issueContract(): IssueContract {
  return {
    schemaVersion: 1,
    issue: {
      repository: "kkb-hub/hybrid-dev-orchestrator",
      number: 42,
      url: "https://github.com/kkb-hub/hybrid-dev-orchestrator/issues/42",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Example issue",
      state: "open",
      labels: ["hdo:ready"],
      bodyHash: "deadbeef",
    },
    goal: "Do the thing",
    context: "Some context",
    scope: { include: ["src/"], exclude: [] },
    acceptanceCriteria: [{ id: "ac-1", text: "It works" }],
    validationGates: ["build"],
    constraints: [],
    dependencies: [],
    affectedAreas: ["src"],
    additionalContext: "",
    priority: "normal",
    risk: "low",
    preferredExecution: "auto",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

function projectContract(): ProjectContract {
  return {
    schemaVersion: 1,
    instructions: { files: ["CLAUDE.md"], specificationPaths: [] },
    validationGates: [],
    workerPolicy: {
      networkAccess: "denied",
      oneWriterPerWorktree: true,
      allowCommit: false,
      allowPush: false,
      forbiddenCommands: [],
      protectedPaths: [],
    },
    reviewPolicy: {
      defaultViewpoints: ["correctness"],
      highRiskPaths: [],
      largeChangeLines: 400,
      onMissingViewpoint: "escalate",
      stableFindingIds: true,
      mutation: { enabled: false, oneWriterWindow: true, indeterminateIsSuccess: false },
    },
  };
}

function reviewResult(): ReviewResult {
  return {
    schemaVersion: 1,
    runId: "run-1",
    baseCommit: "abc123",
    diffHash: "sha256:def456",
    reviewRound: 1,
    decision: "request_changes",
    summary: "needs work",
    missingViewpoints: [],
    findings: [],
    escalationReason: null,
  };
}

const diff: PromptDiff = { baseCommit: "abc123", hash: "sha256:def456", patch: "diff --git a/x b/x\n+added" };

test("buildPlanPrompt: exact first line, section headers in order, no trailing newline", () => {
  const prompt = buildPlanPrompt(issueContract(), projectContract());
  const lines = prompt.split("\n");
  assert.equal(lines[0], "You are the read-only planning step of Hybrid Dev Orchestrator. Do not modify files.");
  assert.ok(prompt.includes("ISSUE CONTRACT\n"));
  assert.ok(prompt.indexOf("ISSUE CONTRACT") < prompt.indexOf("TRUSTED PROJECT CONTRACT"));
  assert.ok(!prompt.endsWith("\n"));
});

test("buildImplementationPrompt: iteration interpolated, section headers in order", () => {
  const prompt = buildImplementationPrompt(issueContract(), { objective: "do it" }, projectContract(), 3);
  assert.equal(prompt.split("\n")[0], "You are the implementation step of Hybrid Dev Orchestrator, iteration 3.");
  const order = ["UNTRUSTED ISSUE CONTRACT", "PLANNED TASK CONTRACT", "TRUSTED PROJECT CONTRACT"];
  const positions = order.map((heading) => prompt.indexOf(heading));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(!prompt.endsWith("\n"));
});

test("buildFixPrompt: iteration interpolated, section headers in order", () => {
  const prompt = buildFixPrompt(issueContract(), { objective: "do it" }, projectContract(), reviewResult(), { ok: true }, 2);
  assert.equal(prompt.split("\n")[0], "You are the fix step of Hybrid Dev Orchestrator, iteration 2.");
  const order = ["UNTRUSTED ISSUE CONTRACT", "TASK CONTRACT", "PREVIOUS REVIEW", "PREVIOUS VALIDATION", "TRUSTED PROJECT CONTRACT"];
  const positions = order.map((heading) => prompt.indexOf(heading));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(!prompt.endsWith("\n"));
});

test("buildReviewPrompt: round/runId/baseCommit/diffHash interpolated, section headers in order, no trailing newline", () => {
  const prompt = buildReviewPrompt(issueContract(), { objective: "do it" }, projectContract(), { passed: true }, diff, reviewResult(), 2, "run-42");
  assert.equal(
    prompt.split("\n")[0],
    "You are the read-only review step of Hybrid Dev Orchestrator, review round 2. Do not modify files.",
  );
  assert.ok(prompt.includes("Set runId to 'run-42', baseCommit to 'abc123', diffHash to 'sha256:def456', and reviewRound to 2 in the result."));
  assert.ok(prompt.includes("DIFF HASH: sha256:def456"));
  assert.ok(prompt.includes("BASE COMMIT: abc123"));
  const order = [
    "UNTRUSTED ISSUE CONTRACT",
    "TASK CONTRACT",
    "TRUSTED PROJECT AND REVIEW POLICY",
    "VALIDATION RESULT",
    "PREVIOUS REVIEW (may be null)",
    "BEGIN COMPLETE DIFF",
    "END COMPLETE DIFF",
  ];
  const positions = order.map((heading) => prompt.indexOf(heading));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(prompt.endsWith("END COMPLETE DIFF"));
  assert.ok(!prompt.endsWith("\n"));
});

// Oracle: prompts.ts psJson - `JSON.stringify(x === undefined ? null : x, null, 2)`
// mirrors `ConvertTo-Json $null` -> the text "null" (Runner.ps1:1016 with $PreviousReview
// unset on the first review round).
test("buildReviewPrompt: an undefined previousReview renders as the JSON text 'null'", () => {
  const prompt = buildReviewPrompt(issueContract(), { objective: "do it" }, projectContract(), { passed: true }, diff, undefined, 1, "run-1");
  const marker = "PREVIOUS REVIEW (may be null)\n";
  const start = prompt.indexOf(marker) + marker.length;
  const rest = prompt.slice(start);
  assert.ok(rest.startsWith("null\n\nDIFF HASH:"), `expected 'null' immediately after the heading, got: ${rest.slice(0, 40)}`);
});

test("buildReviewPrompt: the diff patch text is embedded verbatim between the BEGIN/END markers", () => {
  const prompt = buildReviewPrompt(issueContract(), { objective: "do it" }, projectContract(), {}, diff, undefined, 1, "run-1");
  assert.ok(prompt.includes("BEGIN COMPLETE DIFF\ndiff --git a/x b/x\n+added\nEND COMPLETE DIFF"));
});
