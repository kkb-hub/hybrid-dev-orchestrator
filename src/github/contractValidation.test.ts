// Ports the `Test-HdoReadyContentFreshness` and `Test-HdoIssueContract` oracle cases
// from `tests/run-tests.ps1:394-429` line for line.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import type { GithubIssue, IssueContract, ProjectContract, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { convertToIssueContract } from "./normalize.ts";
import { testIssueContract, testReadyContentFreshness } from "./contractValidation.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();

const config: Pick<ResolvedHdoConfig, "github" | "profiles"> = {
  github: {
    labels: {
      ready: "hdo:ready",
      skip: "hdo:skip",
      statusPrefix: "hdo:status/",
      claimed: "hdo:status/claimed",
      implementing: "hdo:status/implementing",
      review: "hdo:status/review",
      changesRequested: "hdo:status/changes-requested",
      approved: "hdo:status/approved",
      escalated: "hdo:status/blocked",
      failed: "hdo:status/failed",
      cancelled: "hdo:status/cancelled",
    },
    priorityOrder: ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"],
    writeBack: "none",
    candidateLimit: 50,
    assignOnClaim: true,
  },
  profiles: {},
};

function makeProjectContract(gateIds: string[]): ProjectContract {
  return {
    schemaVersion: 1,
    instructions: { files: [], specificationPaths: [] },
    validationGates: gateIds.map((id) => ({
      id,
      command: "true",
      args: [],
      required: true,
      timeoutSeconds: 60,
      exitCodes: { passed: [0], failed: [1], indeterminate: [] },
      continueAfterFailure: false,
    })),
    workerPolicy: {
      networkAccess: "denied",
      oneWriterPerWorktree: true,
      allowCommit: false,
      allowPush: false,
      forbiddenCommands: [],
      protectedPaths: [],
    },
    reviewPolicy: {
      defaultViewpoints: [],
      highRiskPaths: [],
      largeChangeLines: 400,
      onMissingViewpoint: "escalate",
      stableFindingIds: true,
      mutation: { enabled: false, oneWriterWindow: true, indeterminateIsSuccess: false },
    },
  };
}

const projectContract = makeProjectContract(["tests", "schemas"]);

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

function makeIssue(body: string, labels: string[] = ["hdo:ready", "hdo:priority/p2", "hdo:risk/medium"]): GithubIssue {
  return {
    repository: "kkb-hub/hybrid-dev-orchestrator",
    number: 123,
    url: "https://github.com/kkb-hub/hybrid-dev-orchestrator/issues/123",
    updatedAt: "2026-09-01T00:00:00Z",
    title: "Implement HDO cycle",
    state: "OPEN",
    labels,
    body,
    comments: [],
  };
}

const contract = convertToIssueContract(makeIssue(ISSUE_BODY));

const emptyRequiredBody = ISSUE_BODY.replace(/^AC-01: Parse the Issue form\r?\nAC-02: Run trusted validation gates\r?$/m, "_No response_").replace(
  /^tests\r?\nschemas\r?$/m,
  "_No response_",
);
const emptyRequiredContract = convertToIssueContract(makeIssue(emptyRequiredBody));

// Oracle: tests/run-tests.ps1:402, "a never-edited Issue is not rejected when ready labeling advances updatedAt"
test("a never-edited Issue is not rejected when ready labeling advances updatedAt", () => {
  const result = testReadyContentFreshness("2026-09-03T01:43:07Z", "");
  assert.equal(result.fresh, true);
});

// Oracle: tests/run-tests.ps1:406, "an Issue content edit at or before ready remains authorized"
test("an Issue content edit at or before ready remains authorized", () => {
  const result = testReadyContentFreshness("2026-09-03T01:43:07Z", "2026-09-03T01:43:07Z");
  assert.equal(result.fresh, true);
});

// Oracle: tests/run-tests.ps1:410, "an Issue content edit after ready requires re-authorization"
test("an Issue content edit after ready requires re-authorization", () => {
  const result = testReadyContentFreshness("2026-09-03T01:43:07Z", "2026-09-03T01:43:08Z");
  assert.equal(result.fresh, false);
});

// Oracle: tests/run-tests.ps1:414, "an invalid Issue content edit timestamp fails closed"
test("an invalid Issue content edit timestamp fails closed", () => {
  const result = testReadyContentFreshness("2026-09-03T01:43:07Z", "not-a-timestamp");
  assert.equal(result.fresh, false);
});

// Oracle: tests/run-tests.ps1:395, "valid Issue Form satisfies the semantic contract"
test("valid Issue Form satisfies the semantic contract", () => {
  const result = testIssueContract(contract, schemas, { config, projectContract, requireReady: true });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

// Oracle: tests/run-tests.ps1:397, "Issue contract rejects empty required AC and gate sections"
test("Issue contract rejects empty required AC and gate sections", () => {
  const result = testIssueContract(emptyRequiredContract, schemas, { config, projectContract, requireReady: true });
  assert.equal(result.valid, false);
});

// Oracle: tests/run-tests.ps1:419, "duplicate acceptance criterion IDs are rejected"
test("duplicate acceptance criterion IDs are rejected", () => {
  const duplicateAcceptance: IssueContract = {
    ...contract,
    acceptanceCriteria: [...contract.acceptanceCriteria, { id: "AC-01", text: "A conflicting duplicate id." }],
  };
  const result = testIssueContract(duplicateAcceptance, schemas, { config, projectContract, requireReady: true });
  assert.equal(result.valid, false);
});

// Oracle: tests/run-tests.ps1:424, "multiple lifecycle labels are rejected"
test("multiple lifecycle labels are rejected", () => {
  const conflicting: IssueContract = {
    ...contract,
    issue: { ...contract.issue, labels: [...contract.issue.labels, "hdo:status/claimed", "hdo:status/review"] },
  };
  const result = testIssueContract(conflicting, schemas, { config, projectContract, requireReady: true });
  assert.equal(result.valid, false);
});

// Oracle: tests/run-tests.ps1:429, "unknown validation gate IDs are rejected"
test("unknown validation gate IDs are rejected", () => {
  const unknownGate: IssueContract = { ...contract, validationGates: ["does-not-exist"] };
  const result = testIssueContract(unknownGate, schemas, { config, projectContract, requireReady: true });
  assert.equal(result.valid, false);
});
