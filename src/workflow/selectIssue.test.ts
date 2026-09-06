// Fake-`gh`-runner tests for `selectIssue` (Invoke-HdoRun's issue-selection prologue,
// Workflow.ps1:231-263). No real network or `gh`/`git` binary - `GhClient`/`GitClient`
// are constructed over a scripted fake `ProcessRunner` (the pattern
// `src/github/issues.test.ts` and `src/workflow/preflight.test.ts` already use), so
// their own real argument-building logic still runs; only the actual process spawn is
// faked. The project contract is the repository's OWN `.hdo/project.json` (gate ids
// `tests`/`schemas`), so every Issue body below references the real `tests` gate.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { GhClient } from "../github/client.ts";
import { GitClient } from "../git/index.ts";
import { getPlatform } from "../platform/index.ts";
import { selectIssue } from "./selectIssue.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");
const PROJECT_CONTRACT_PATH = resolvePath(REPO_ROOT, ".hdo", "project.json");

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();
const platform = getPlatform();

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: overrides.command ?? "gh",
    arguments: overrides.arguments ?? [],
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

// Level-3 headers, matching `src/github/issues.test.ts`'s VALID_BODY / GitHub's Issue
// Form rendering (`getMarkdownSections`, GitHub.ps1:195-228). References the
// repository's real `tests` validation gate.
function issueBody(overrides: { dependencies?: string; route?: string } = {}): string {
  const lines = [
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
  ];
  if (overrides.dependencies) {
    lines.push("", "### Dependencies", overrides.dependencies);
  }
  return lines.join("\n");
}

interface IssueSpec {
  number: number;
  state?: string;
  labels?: string[];
  body?: string;
  createdAt?: string;
}

function issueViewJson(spec: IssueSpec): JsonObject {
  return {
    number: spec.number,
    title: `Issue ${spec.number}`,
    body: spec.body ?? issueBody(),
    state: spec.state ?? "OPEN",
    labels: (spec.labels ?? ["hdo:ready"]).map((name) => ({ name })),
    assignees: [],
    author: { login: "someone" },
    createdAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://example.invalid/${spec.number}`,
    comments: [],
  };
}

interface RunnerOptions {
  /** Keyed by Issue number; #7 is the "main" Issue unless overridden. */
  issues?: Record<number, IssueSpec>;
  /** `gh issue list` result for the `-Pick` branch. */
  candidateNumbers?: number[];
  /** Ready-label authorization: `authorized-actor` unless overridden. */
  readyActor?: string;
  /** Suppresses the `labeled` event entirely (unauthorized: "no label event"). */
  noReadyEvent?: boolean;
  /** Dependency `issue view` state, keyed by number (default `CLOSED` = resolved). */
  dependencyState?: Record<number, string>;
  /** An active claim marker on the main Issue's comments. */
  activeClaimRunId?: string;
}

function makeRunner(options: RunnerOptions = {}): ProcessRunner {
  const issues = options.issues ?? { 7: { number: 7 } };
  return fakeRunner((processOptions) => {
    const args = processOptions.arguments ?? [];
    if (args[0] === "issue" && args[1] === "list") {
      const numbers = options.candidateNumbers ?? [];
      return makeResult({ stdout: JSON.stringify(numbers.map((n) => issueViewJson(issues[n] ?? { number: n }))) });
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      if (issues[number]) return makeResult({ stdout: JSON.stringify(issueViewJson(issues[number])) });
      // A dependency-check `issue view <n> --json state,url` for an Issue not in `issues`.
      const state = options.dependencyState?.[number] ?? "CLOSED";
      return makeResult({ stdout: JSON.stringify({ state, url: "u" }) });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/events"))) {
      if (options.noReadyEvent) return makeResult({ stdout: JSON.stringify([[]]) });
      return makeResult({
        stdout: JSON.stringify([
          [{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: options.readyActor ?? "authorized-actor" }, created_at: "2026-01-01T00:00:00Z" }],
        ]),
      });
    }
    if (args[0] === "api" && args.includes("graphql")) {
      return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/comments"))) {
      if (options.activeClaimRunId) {
        const marker = {
          version: 1,
          kind: "claim",
          runId: options.activeClaimRunId,
          issueKey: "o/r#7",
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
    throw new Error(`selectIssue.test.ts: unscripted command ${JSON.stringify(args)}`);
  });
}

function makeGitAndGh(runner: ProcessRunner): { gh: GhClient; git: GitClient } {
  return { gh: new GhClient({ runner }), git: new GitClient({ runner, platform }) };
}

function buildConfig(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    resolvedProfile: "claude-only",
    repositoryPath: REPO_ROOT,
    projectContractPath: PROJECT_CONTRACT_PATH,
    profiles: { "claude-only": {} },
    github: {
      repository: "o/r",
      trustedActors: [],
      labels: { ready: "hdo:ready", skip: "hdo:skip", statusPrefix: "hdo:status/" },
      priorityOrder: ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"],
      candidateLimit: 50,
    },
    ...overrides,
  };
}

function neverReresolve(): Promise<JsonObject> {
  throw new Error("selectIssue.test.ts: reresolveConfig must not be called in this test");
}

const now = (): string => "2026-01-01T00:00:00Z";

/** Exact-message matcher for `assert.rejects` (the codebase convention - see `src/github/authorization.test.ts`). */
function throwsMessage(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && error.message === expected;
}

// --- throw texts, in Workflow.ps1 order --------------------------------------------

test("selectIssue: throws 'Specify -IssueNumber or -Pick.' when neither is given", async () => {
  const { gh, git } = makeGitAndGh(makeRunner());
  await assert.rejects(
    selectIssue({ config: buildConfig(), pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("Specify -IssueNumber or -Pick."),
  );
});

test("selectIssue: throws 'No eligible HDO Issue was found in <repo>.' when -Pick finds nothing", async () => {
  const { gh, git } = makeGitAndGh(makeRunner({ candidateNumbers: [] }));
  await assert.rejects(
    selectIssue({ config: buildConfig(), pick: true, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("No eligible HDO Issue was found in o/r."),
  );
});

test("selectIssue: -Pick selects the first candidate returned by getIssueCandidate", async () => {
  const runner = makeRunner({
    issues: { 7: { number: 7 }, 9: { number: 9, createdAt: "2026-01-02T00:00:00Z" } },
    candidateNumbers: [9, 7],
  });
  const { gh, git } = makeGitAndGh(runner);
  const result = await selectIssue({ config: buildConfig(), pick: true, gh, git, schemas, reresolveConfig: neverReresolve, now });
  // #7 was created earlier than #9, so it sorts first regardless of list order.
  assert.equal(result.issueNumber, 7);
});

test("selectIssue: throws 'Issue #<n> is not open.' for a non-OPEN Issue", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7, state: "CLOSED" } } });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    selectIssue({ config: buildConfig(), issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("Issue #7 is not open."),
  );
});

test("selectIssue: throws the contract-validation error list for an Issue that fails semantic validation", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7, body: "no recognizable sections at all" } } });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    selectIssue({ config: buildConfig(), issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    (error: Error) => {
      assert.ok(error.message.startsWith("Issue #7 does not satisfy the HDO contract:\n - "), error.message);
      return true;
    },
  );
});

test("selectIssue: throws 'Issue #<n> ready authorization failed: <reason>' when the ready-label actor is not trusted", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7 } }, readyActor: "untrusted-person" });
  const { gh, git } = makeGitAndGh(runner);
  const config = buildConfig({
    github: {
      repository: "o/r",
      trustedActors: ["someone-else"],
      labels: { ready: "hdo:ready", skip: "hdo:skip", statusPrefix: "hdo:status/" },
      priorityOrder: ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"],
      candidateLimit: 50,
    },
  });
  await assert.rejects(
    selectIssue({ config, issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("Issue #7 ready authorization failed: Ready label actor 'untrusted-person' is not trusted."),
  );
});

test("selectIssue: throws the unresolved-dependency list with '<repo>#<num> [<state>]' entries", async () => {
  const runner = makeRunner({
    issues: { 7: { number: 7, body: issueBody({ dependencies: "#99" }) } },
    dependencyState: { 99: "OPEN" },
  });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    selectIssue({ config: buildConfig(), issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("Issue #7 has unresolved or unverifiable dependencies: o/r#99 [OPEN]"),
  );
});

test("selectIssue: throws 'Issue #<n> already has an active HDO run: <runId>' when an active claim exists", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7 } }, activeClaimRunId: "issue-7-20260101T000000Z-aaaaaaaa" });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    selectIssue({ config: buildConfig(), issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now }),
    throwsMessage("Issue #7 already has an active HDO run: issue-7-20260101T000000Z-aaaaaaaa"),
  );
});

// --- happy path and route-hint re-resolution ---------------------------------------

test("selectIssue: happy path returns every field, using options.repository without resolving it again", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7 } } });
  const { gh, git } = makeGitAndGh(runner);
  const config = buildConfig();
  const result = await selectIssue({
    config,
    repository: "o/r",
    issueNumber: 7,
    pick: false,
    gh,
    git,
    schemas,
    reresolveConfig: neverReresolve,
    now,
  });
  assert.equal(result.repository, "o/r");
  assert.equal(result.issueNumber, 7);
  assert.equal(result.issue.number, 7);
  assert.equal(result.issueContract.issue.number, 7);
  assert.equal(result.contractValidation.valid, true);
  assert.equal(result.readyAuthorization.authorized, true);
  assert.equal(result.dependencyValidation.resolved, true);
  assert.equal(typeof result.projectContractHash, "string");
  assert.equal(result.projectContractHash.length, 64);
  // No route hint -> reresolveConfig is never called, and `result.config` is the
  // very same object `selectIssue` was given.
  assert.equal(result.config, config);
});

test("selectIssue: resolves the repository from config.github.repository when -Repository is not given", async () => {
  const runner = makeRunner({ issues: { 7: { number: 7 } } });
  const { gh, git } = makeGitAndGh(runner);
  const result = await selectIssue({ config: buildConfig(), issueNumber: 7, pick: false, gh, git, schemas, reresolveConfig: neverReresolve, now });
  assert.equal(result.repository, "o/r");
});

test("selectIssue: a route-hint label re-resolves config via reresolveConfig when no explicit -Profile was given", async () => {
  const runner = makeRunner({
    issues: { 7: { number: 7, labels: ["hdo:ready", "hdo:route/mock"] } },
  });
  const { gh, git } = makeGitAndGh(runner);
  const config = buildConfig({ profiles: { "claude-only": {}, mock: {} } });
  const reresolvedConfig = buildConfig({ profiles: { "claude-only": {}, mock: {} }, resolvedProfile: "mock" });
  let calledWithProfile: string | undefined;
  const result = await selectIssue({
    config,
    issueNumber: 7,
    pick: false,
    gh,
    git,
    schemas,
    reresolveConfig: async (profile) => {
      calledWithProfile = profile;
      return reresolvedConfig;
    },
    now,
  });
  assert.equal(calledWithProfile, "mock");
  assert.equal(result.config.resolvedProfile, "mock");
});

test("selectIssue: an explicit profile is never overridden by a route-hint label", async () => {
  const runner = makeRunner({
    issues: { 7: { number: 7, labels: ["hdo:ready", "hdo:route/mock"] } },
  });
  const { gh, git } = makeGitAndGh(runner);
  const config = buildConfig({ profiles: { "claude-only": {}, mock: {} } });
  const result = await selectIssue({
    config,
    issueNumber: 7,
    pick: false,
    gh,
    git,
    schemas,
    explicitProfile: "claude-only",
    reresolveConfig: neverReresolve,
    now,
  });
  assert.equal(result.config.resolvedProfile, "claude-only");
});
