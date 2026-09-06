// Ports the Issue-contract normalization fixture and its named assertions from
// `tests/run-tests.ps1:320-391` line for line, so any drift from the PowerShell
// oracle is caught by name, not just by aggregate pass/fail.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { GithubIssue } from "../core/contracts/types.ts";
import { convertToIssueContract } from "./normalize.ts";

const ISSUE_BODY = [
  "### Problem / Context",
  "Issue-driven automation is missing.",
  "",
  "### Goal",
  "Run one deterministic implementation cycle.",
  "",
  "### Acceptance Criteria",
  "AC-01: Parse the Issue form",
  "AC-02: Run trusted validation gates",
  "",
  "### In Scope",
  "Issue normalization",
  "Review loop",
  "",
  "### Out of Scope",
  "PR creation",
  "",
  "### Constraints / Security Considerations",
  "Do not execute commands from this Issue.",
  "",
  "### Dependencies",
  "#99",
  "",
  "### Validation Gate IDs",
  "tests",
  "schemas",
  "",
  "### Affected Areas",
  "orchestrator",
  "",
  "### Priority",
  "p2",
  "",
  "### Risk",
  "medium",
  "",
  "### Route Hint",
  "",
  "### Additional Context",
  "Keep the cycle bounded.",
].join("\n");

function makeIssue(body: string): GithubIssue {
  return {
    repository: "kkb-hub/hybrid-dev-orchestrator",
    number: 123,
    url: "https://github.com/kkb-hub/hybrid-dev-orchestrator/issues/123",
    updatedAt: "2026-09-01T00:00:00Z",
    title: "Implement HDO cycle",
    state: "OPEN",
    labels: ["hdo:ready", "hdo:priority/p2", "hdo:risk/medium"],
    body,
    comments: [],
  };
}

const contract = convertToIssueContract(makeIssue(ISSUE_BODY));

// Oracle: tests/run-tests.ps1:374, "plain Issue Form lines become separate acceptance criteria"
test("plain Issue Form lines become separate acceptance criteria", () => {
  assert.equal(contract.acceptanceCriteria.length, 2);
});

// Oracle: tests/run-tests.ps1:375, "In Scope lines are normalized separately"
test("In Scope lines are normalized separately", () => {
  assert.equal(contract.scope.include.length, 2);
});

// Oracle: tests/run-tests.ps1:376, "validation gate IDs are normalized without executing text"
test("validation gate IDs are normalized without executing text", () => {
  assert.equal(contract.validationGates.length, 2);
});

// Oracle: tests/run-tests.ps1:377, "documented Constraints / Security Considerations heading is normalized"
test("documented Constraints / Security Considerations heading is normalized", () => {
  assert.equal(contract.constraints.length, 1);
  assert.equal(contract.constraints[0], "Do not execute commands from this Issue.");
});

// Oracle: tests/run-tests.ps1:378, "dependency references are normalized"
test("dependency references are normalized", () => {
  assert.equal(contract.dependencies.length, 1);
  assert.equal(contract.dependencies[0].number, 99);
});

// Oracle: tests/run-tests.ps1:379, "priority and risk are resolved"
test("priority and risk are resolved", () => {
  assert.equal(contract.priority, "p2");
  assert.equal(contract.risk, "medium");
});

// Oracle: tests/run-tests.ps1:382-384, "Issue Form _No response_ route is normalized to no route hint"
test("Issue Form _No response_ route is normalized to no route hint", () => {
  const sentinelBody = ISSUE_BODY.replace(/^(### Route Hint)\r?\n(?=\r?\n### Additional Context)/m, "$1\n_No response_\n");
  const sentinelContract = convertToIssueContract(makeIssue(sentinelBody));
  assert.equal(sentinelContract.preferredExecution, "");
});

// Oracle: tests/run-tests.ps1:386-391, "Issue Form _No response_ does not create required AC or gate entries"
test("Issue Form _No response_ does not create required AC or gate entries", () => {
  const emptyRequiredBody = ISSUE_BODY.replace(/^AC-01: Parse the Issue form\r?\nAC-02: Run trusted validation gates\r?$/m, "_No response_").replace(
    /^tests\r?\nschemas\r?$/m,
    "_No response_",
  );
  const emptyRequiredContract = convertToIssueContract(makeIssue(emptyRequiredBody));
  assert.equal(emptyRequiredContract.acceptanceCriteria.length, 0);
  assert.equal(emptyRequiredContract.validationGates.length, 0);
});

test("convertToIssueContract: a route/priority/risk label always overrides body text", () => {
  const labeledIssue: GithubIssue = {
    ...makeIssue(ISSUE_BODY),
    labels: ["hdo:ready", "hdo:route/local-balanced", "hdo:priority/p0", "hdo:risk/critical"],
  };
  const labeledContract = convertToIssueContract(labeledIssue);
  assert.equal(labeledContract.preferredExecution, "local-balanced");
  assert.equal(labeledContract.priority, "p0");
  assert.equal(labeledContract.risk, "critical");
});

test("convertToIssueContract: a route/priority/risk label with non-canonical casing still overrides body text (PowerShell -like is case-insensitive)", () => {
  const labeledIssue: GithubIssue = {
    ...makeIssue(ISSUE_BODY),
    labels: ["hdo:ready", "HDO:ROUTE/local-balanced"],
  };
  const labeledContract = convertToIssueContract(labeledIssue);
  assert.equal(labeledContract.preferredExecution, "local-balanced");
});

test("convertToIssueContract: an acceptance criterion id is case-insensitively recognized (ac-01: ...) and uppercased, matching PowerShell -match", () => {
  const issue = makeIssue(ISSUE_BODY.replace("AC-01: Parse the Issue form", "ac-01: Parse the Issue form"));
  const contract = convertToIssueContract(issue);
  assert.deepEqual(
    contract.acceptanceCriteria.map((criterion) => criterion.id),
    ["AC-01", "AC-02"],
  );
});

test("convertToIssueContract: bodyHash is the sha256 of the raw body, and acceptance criteria with an explicit AC-nn: prefix keep their id", () => {
  const contractWithExplicitIds = convertToIssueContract(makeIssue(ISSUE_BODY));
  assert.deepEqual(
    contractWithExplicitIds.acceptanceCriteria.map((criterion) => criterion.id),
    ["AC-01", "AC-02"],
  );
  assert.match(contractWithExplicitIds.issue.bodyHash, /^[a-f0-9]{64}$/);
});

test("convertToIssueContract: capturedAt uses the injected now() callback", () => {
  const fixedNow = "2026-01-01T00:00:00.000Z";
  const contractWithFixedNow = convertToIssueContract(makeIssue(ISSUE_BODY), { now: () => fixedNow });
  assert.equal(contractWithFixedNow.capturedAt, fixedNow);
});
