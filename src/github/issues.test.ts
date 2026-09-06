// Fake-runner tests for Test-HdoIssueDependencies / Get-HdoIssueCandidate ports
// (GitHub.ps1:397-460). No real network or `gh`/`git` binary.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import type { IssueContract, ProjectContract, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { getPlatform } from "../platform/index.ts";
import { GitClient } from "../git/index.ts";
import { GhClient } from "./client.ts";
import { getIssueCandidate, testIssueDependencies } from "./issues.ts";

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

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: "gh",
    arguments: [],
    exitCode: overrides.exitCode ?? 0,
    timedOut: false,
    outputLimitExceeded: false,
    outputLimitStream: "",
    outputDrainTimedOut: false,
    maximumOutputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: "",
    stderrPath: "",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
  };
}

function fakeRunner(handler: (options: ProcessRunOptions) => ProcessResult): ProcessRunner {
  return { async run(options: ProcessRunOptions): Promise<ProcessResult> { return handler(options); } };
}

function makeGitAndGh(runner: ProcessRunner): { gh: GhClient; git: GitClient } {
  const platform = getPlatform();
  return { gh: new GhClient({ runner }), git: new GitClient({ runner, platform }) };
}

function githubConfig(overrides: Partial<{ trustedActors: string[]; skipLabel: string }> = {}): ResolvedHdoConfig["github"] {
  return {
    labels: {
      ready: "hdo:ready",
      skip: overrides.skipLabel ?? "hdo:skip",
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
    trustedActors: overrides.trustedActors,
  };
}

function fullConfig(overrides: Partial<{ trustedActors: string[] }> = {}): ResolvedHdoConfig {
  return {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: {},
    runners: {},
    github: githubConfig(overrides),
    workflow: { maxFixAttempts: 3, implicitFallback: false, onNoDiff: "fail", onValidationFailure: "escalate", onMaxFixAttempts: "escalate" },
    paths: { worktreeRoot: "/worktrees", artifactRoot: "/artifacts" },
    projectContractPath: ".hdo/project.json",
  };
}

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

// --- testIssueDependencies ---------------------------------------------------------

function makeContract(dependencies: Array<{ repository: string; number: number }>): IssueContract {
  return {
    schemaVersion: 1,
    issue: {
      repository: "o/r",
      number: 1,
      url: "u",
      updatedAt: "x",
      title: "t",
      state: "OPEN",
      labels: [],
      bodyHash: "0".repeat(64),
    },
    goal: "g",
    context: "c",
    scope: { include: ["a"], exclude: [] },
    acceptanceCriteria: [{ id: "AC-1", text: "t" }],
    validationGates: ["tests"],
    constraints: [],
    dependencies,
    affectedAreas: [],
    additionalContext: "",
    priority: "p2",
    risk: "low",
    preferredExecution: "",
    capturedAt: "2026-01-01T00:00:00Z",
  };
}

test("testIssueDependencies: a CLOSED dependency Issue is resolved", async () => {
  const { gh } = makeGitAndGh(fakeRunner(() => makeResult({ stdout: JSON.stringify({ state: "CLOSED", url: "u" }) })));
  const result = await testIssueDependencies(gh, makeContract([{ repository: "o/r", number: 99 }]), "/repo");
  assert.equal(result.resolved, true);
  assert.equal(result.checks[0].state, "CLOSED");
});

test("testIssueDependencies: an OPEN dependency Issue is unresolved", async () => {
  const { gh } = makeGitAndGh(fakeRunner(() => makeResult({ stdout: JSON.stringify({ state: "OPEN", url: "u" }) })));
  const result = await testIssueDependencies(gh, makeContract([{ repository: "o/r", number: 99 }]), "/repo");
  assert.equal(result.resolved, false);
  assert.equal(result.unresolved.length, 1);
});

test("testIssueDependencies: a gh failure is captured as an UNKNOWN, unresolved, redacted-error check", async () => {
  const { gh } = makeGitAndGh(fakeRunner(() => makeResult({ exitCode: 1, stderr: "no such issue" })));
  const result = await testIssueDependencies(gh, makeContract([{ repository: "o/r", number: 99 }]), "/repo");
  assert.equal(result.resolved, false);
  assert.equal(result.checks[0].state, "UNKNOWN");
  assert.equal(result.checks[0].resolved, false);
  assert.ok(result.checks[0].error);
});

// --- getIssueCandidate --------------------------------------------------------------

const VALID_BODY = [
  "### Problem / Context",
  "Context text.",
  "",
  "### Goal",
  "Goal text.",
  "",
  "### Acceptance Criteria",
  "AC-01: first",
  "",
  "### In Scope",
  "included",
  "",
  "### Out of Scope",
  "excluded",
  "",
  "### Validation Gate IDs",
  "tests",
  "",
  "### Priority",
  "p2",
  "",
  "### Risk",
  "low",
].join("\n");

interface FakeIssueSpec {
  number: number;
  labels: string[];
  body?: string;
  createdAt?: string;
}

/**
 * Builds a single fake ProcessRunner that answers every `gh` call `getIssueCandidate`
 * makes, keyed off argv shape: `issue list` (the candidate set), `issue events`
 * (ready-label authorization, via the paginated endpoint), `api graphql`
 * (lastEditedAt), `issue view` (dependency checks) and `issue comments` (paginated,
 * for the active-claim check). Every candidate is, by default, ready-authorized (a
 * `labeled` event for `hdo:ready` by `authorized-actor`, never edited since), has no
 * open dependencies, and has no active claim - individual tests override just the
 * one behavior under test via `overrides`.
 */
function makeCandidateRunner(
  issues: FakeIssueSpec[],
  overrides: {
    dependencyState?: Record<number, string>;
    activeClaimIssueNumbers?: number[];
    unauthorizedIssueNumbers?: number[];
  } = {},
): ProcessRunner {
  return fakeRunner((options) => {
    const args = options.arguments ?? [];
    if (args[0] === "issue" && args[1] === "list") {
      return makeResult({
        stdout: JSON.stringify(
          issues.map((issue) => ({
            number: issue.number,
            title: `Issue ${issue.number}`,
            body: issue.body ?? VALID_BODY,
            state: "OPEN",
            labels: issue.labels,
            assignees: [],
            author: { login: "someone" },
            createdAt: issue.createdAt ?? `2026-01-0${issue.number}T00:00:00Z`,
            updatedAt: `2026-01-0${issue.number}T00:00:00Z`,
            url: `https://example.invalid/${issue.number}`,
          })),
        ),
      });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/events"))) {
      const endpoint = args.find((a) => a.includes("/events")) ?? "";
      const issueNumber = Number(endpoint.split("/issues/")[1]?.split("/")[0]);
      if (overrides.unauthorizedIssueNumbers?.includes(issueNumber)) {
        return makeResult({ stdout: JSON.stringify([[]]) });
      }
      return makeResult({
        stdout: JSON.stringify([[{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "authorized-actor" }, created_at: "2026-01-01T00:00:00Z" }]]),
      });
    }
    if (args[0] === "api" && args.includes("graphql")) {
      return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/comments"))) {
      const endpoint = args.find((a) => a.includes("/comments")) ?? "";
      const issueNumber = Number(endpoint.split("/issues/")[1]?.split("/")[0]);
      if (overrides.activeClaimIssueNumbers?.includes(issueNumber)) {
        const marker = {
          version: 1,
          kind: "claim",
          runId: "issue-1-active",
          issueKey: `o/r#${issueNumber}`,
          claimedBy: "someone",
          claimedAt: "2026-01-01T00:00:00.000Z",
          leaseExpiresAt: "2026-01-02T00:00:00.000Z",
          state: "active",
        };
        return makeResult({
          stdout: JSON.stringify([
            [{ id: 1, body: `<!-- hdo:claim:v1 ${JSON.stringify(marker)} -->\ntext`, user: { login: "someone" }, author_association: "OWNER", created_at: "x" }],
          ]),
        });
      }
      return makeResult({ stdout: JSON.stringify([[]]) });
    }
    if (args[0] === "issue" && args[1] === "view") {
      const issueNumber = Number(args[2]);
      const state = overrides.dependencyState?.[issueNumber] ?? "CLOSED";
      return makeResult({ stdout: JSON.stringify({ state, url: "u" }) });
    }
    return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
  });
}

const projectContract = makeProjectContract(["tests", "schemas"]);

test("getIssueCandidate: excludes an Issue carrying the skip label", async () => {
  const runner = makeCandidateRunner([
    { number: 1, labels: ["hdo:ready"] },
    { number: 2, labels: ["hdo:ready", "hdo:skip"] },
  ]);
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: excludes an Issue already carrying an hdo:status/* label", async () => {
  const runner = makeCandidateRunner([
    { number: 1, labels: ["hdo:ready"] },
    { number: 2, labels: ["hdo:ready", "hdo:status/claimed"] },
  ]);
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: excludes an Issue whose contract fails semantic validation", async () => {
  const runner = makeCandidateRunner([
    { number: 1, labels: ["hdo:ready"] },
    { number: 2, labels: ["hdo:ready"], body: "no recognizable sections at all" },
  ]);
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: excludes an Issue whose ready label is not authorized", async () => {
  const runner = makeCandidateRunner(
    [
      { number: 1, labels: ["hdo:ready"] },
      { number: 2, labels: ["hdo:ready"] },
    ],
    { unauthorizedIssueNumbers: [2] },
  );
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: excludes an Issue with an unresolved (still-open) dependency", async () => {
  const bodyWithDependency = `${VALID_BODY}\n\n### Dependencies\n#500`;
  const runner = makeCandidateRunner(
    [
      { number: 1, labels: ["hdo:ready"] },
      { number: 2, labels: ["hdo:ready"], body: bodyWithDependency },
    ],
    { dependencyState: { 500: "OPEN" } },
  );
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: excludes an Issue that already has an active claim", async () => {
  const runner = makeCandidateRunner(
    [
      { number: 1, labels: ["hdo:ready"] },
      { number: 2, labels: ["hdo:ready"] },
    ],
    { activeClaimIssueNumbers: [2] },
  );
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r" });
  assert.deepEqual(candidates.map((c) => c.number), [1]);
});

test("getIssueCandidate: sorts by (priorityRank asc, createdAt asc, number asc) and truncates to limit", async () => {
  const runner = makeCandidateRunner([
    { number: 3, labels: ["hdo:ready", "hdo:priority/p1"], createdAt: "2026-01-01T00:00:00Z" },
    { number: 1, labels: ["hdo:ready", "hdo:priority/p0"], createdAt: "2026-01-02T00:00:00Z" },
    { number: 2, labels: ["hdo:ready"], createdAt: "2026-01-01T00:00:00Z" }, // no priority label -> lowest rank (priorityOrder.length)
    { number: 4, labels: ["hdo:ready", "hdo:priority/p0"], createdAt: "2026-01-01T00:00:00Z" },
  ]);
  const { gh, git } = makeGitAndGh(runner);
  const candidates = await getIssueCandidate(gh, git, schemas, fullConfig(), projectContract, "/repo", { repository: "o/r", limit: 3 });
  // p0: #4 (created 01-01) then #1 (created 01-02); p1: #3; unranked (#2) sorts last and is truncated by limit=3.
  assert.deepEqual(candidates.map((c) => c.number), [4, 1, 3]);
});

test("getIssueCandidate: an explicitly empty github.priorityOrder ([]) is honored as-is (unmatched rank is 0), not silently replaced by the built-in 4-tier default", async () => {
  // `getValue`'s (Get-HdoValue) default-substitution rule applies only when the key is
  // ABSENT, never when it is present-but-empty - config merge preserves an explicit
  // `[]` verbatim (tests/run-tests.ps1:66-77). Note: a candidate carrying an actual
  // `hdo:priority/*` label can't be used to observe this via sort order here, because
  // `testIssueContract`'s OWN (unrelated, unaffected-by-this-fix) reserved-label check
  // reads `config.github.priorityOrder` directly and would reject that label as
  // "Unknown reserved HDO label" once priorityOrder is empty - so this asserts the
  // resolved `priorityRank` field directly instead: with the built-in default
  // (length 4) silently substituted, an unmatched issue would get rank 4; with the
  // configured `[]` honored, it must get rank 0.
  const runner = makeCandidateRunner([{ number: 1, labels: ["hdo:ready"] }]);
  const { gh, git } = makeGitAndGh(runner);
  const config = fullConfig();
  config.github.priorityOrder = [];
  const candidates = await getIssueCandidate(gh, git, schemas, config, projectContract, "/repo", { repository: "o/r" });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].priorityRank, 0);
});
