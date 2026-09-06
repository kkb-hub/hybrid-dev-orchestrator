// Integration tests for `runWorkflow` (Workflow.ps1:228-561 port): a real git
// repository + a real `NodeProcessRunner` (git worktrees, the `mock-workflow-agent.ps1`
// pwsh agent, the `gate-*.ps1` pwsh gates) but a SCRIPTED `ProcessRunner` behind
// `GhClient` (no PATH shim, no real `gh` network call - ADR-0001 phase 6 plan §WP-F2
// "run.test.ts uses a scripted ProcessRunner for GhClient... and a real
// NodeProcessRunner for git/agents/gates"). `-NoWriteBack` is always on, so
// `claimIssue`/`setManagedStatusLabel`/`completeClaim` are never invoked; the scripted
// runner throws on any gh call outside the five NoWriteBack calls the oracle makes
// (auth status, issue view, the two paginated endpoints, graphql), which is this
// test's own guarantee that NoWriteBack never touches GitHub.
//
// Fixtures are written fresh into each scenario's own temp directory (not read from
// `tests/fixtures/workflow/**`, which is owned by a concurrent PowerShell-side work
// package) - EXCEPT `mock-workflow-agent.ps1`, referenced read-only by its real path:
// it is a substantial, already-finished, plan-pinned script (ADR-0001 phase 6 plan
// §3.3) and duplicating it here would be a parity risk, not a safety one.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { GitClient } from "../git/index.ts";
import { GhClient } from "../github/client.ts";
import type { NonTerminalRunState } from "../core/state/index.ts";
import { RUN_STATES, isTerminalState } from "../core/state/index.ts";
import { STEP_HANDLERS, runWorkflow } from "./run.ts";
import type { RunRecord } from "../core/workflow/runRecord.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
const MOCK_AGENT_PATH = join(REPO_ROOT, "tests", "fixtures", "workflow", "mock-workflow-agent.ps1");

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

function detectGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const GIT_AVAILABLE = detectGit();
const SKIP_REASON = !GIT_AVAILABLE ? "git is not on PATH" : !PWSH_AVAILABLE ? "pwsh is not on PATH" : false;

function loadTestSchemaRegistry(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadTestSchemaRegistry();
const platform = getPlatform();

// --- fixture repository (own temp dir per scenario, never under tests/fixtures/**) --

const PROJECT_CONTRACT = {
  schemaVersion: 1,
  instructions: { files: [], specificationPaths: ["README.md"] },
  validationGates: [
    {
      id: "gate-pass",
      command: "pwsh",
      args: ["-NoProfile", "-File", "tools/gate-pass.ps1"],
      workingDirectory: ".",
      timeoutSeconds: 60,
      required: true,
      exitCodes: { passed: [0], failed: [1], indeterminate: [2, 124, 125, 126, 127] },
      continueAfterFailure: true,
    },
    {
      id: "gate-fail",
      command: "pwsh",
      args: ["-NoProfile", "-File", "tools/gate-fail.ps1"],
      workingDirectory: ".",
      timeoutSeconds: 60,
      required: true,
      exitCodes: { passed: [0], failed: [1], indeterminate: [2, 124, 125, 126, 127] },
      continueAfterFailure: true,
    },
    {
      id: "gate-setup",
      command: "hdo-gate-command-that-does-not-exist",
      args: [],
      workingDirectory: ".",
      timeoutSeconds: 60,
      required: true,
      exitCodes: { passed: [0], failed: [1], indeterminate: [2, 124, 125, 126, 127] },
      continueAfterFailure: true,
    },
    {
      id: "gate-after",
      command: "pwsh",
      args: ["-NoProfile", "-File", "tools/gate-pass.ps1"],
      workingDirectory: ".",
      timeoutSeconds: 60,
      required: true,
      exitCodes: { passed: [0], failed: [1], indeterminate: [2, 124, 125, 126, 127] },
      continueAfterFailure: true,
    },
  ],
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
    largeChangeLines: 500,
    onMissingViewpoint: "escalate",
    stableFindingIds: true,
    mutation: { enabled: false, oneWriterWindow: true, indeterminateIsSuccess: false },
  },
};

function buildFixtureRepo(tempDir: string): string {
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "HDO Tests",
    GIT_AUTHOR_EMAIL: "hdo-tests@example.invalid",
    GIT_COMMITTER_NAME: "HDO Tests",
    GIT_COMMITTER_EMAIL: "hdo-tests@example.invalid",
  };
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, { cwd: repoDir, env, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "hdo-tests@example.invalid"]);
  run(["config", "user.name", "HDO Tests"]);
  run(["config", "commit.gpgSign", "false"]);
  run(["config", "core.autocrlf", "false"]);
  mkdirSync(join(repoDir, ".hdo"), { recursive: true });
  mkdirSync(join(repoDir, "tools"), { recursive: true });
  writeFileSync(join(repoDir, ".hdo", "project.json"), JSON.stringify(PROJECT_CONTRACT, null, 2), "utf8");
  writeFileSync(join(repoDir, "tools", "gate-pass.ps1"), "exit 0\n", "utf8");
  writeFileSync(join(repoDir, "tools", "gate-fail.ps1"), "Write-Output 'validation failed'\nexit 1\n", "utf8");
  writeFileSync(join(repoDir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(repoDir, "tracked.txt"), "baseline\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "baseline"]);
  return repoDir;
}

// --- scripted GhClient (the five NoWriteBack gh calls only) -------------------------

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

function buildIssueBody(gateIds: string[]): string {
  const gateList = gateIds.map((id) => `- ${id}`).join("\n");
  return [
    "## Problem / Context",
    "",
    "Deterministic fixture body for the workflow dispatch-loop integration test.",
    "",
    "## Goal",
    "",
    "Exercise the bounded workflow loop end to end using only deterministic mock adapters.",
    "",
    "## In scope",
    "",
    "- workflow scenarios",
    "",
    "## Out of scope",
    "",
    "- real GitHub writeback",
    "",
    "## Acceptance Criteria",
    "",
    "- AC-01: The workflow reaches a terminal state deterministically.",
    "",
    "## Validation Gate IDs",
    "",
    gateList,
    "",
    "## Constraints",
    "",
    "- Do not require network access.",
    "",
    "## Dependencies",
    "",
    "_No response_",
    "",
    "## Affected Areas",
    "",
    "- workflow",
    "",
    "## Additional Context",
    "",
    "_No response_",
  ].join("\n");
}

/** Every gh call `Invoke-HdoRun -NoWriteBack` makes: `auth status`, `issue view`, the
 * paginated events/comments endpoints, and `api graphql`. Anything else throws -
 * this test's own guarantee that NoWriteBack never mutates or otherwise touches GitHub. */
function makeGhRunner(gateIds: string[]): ProcessRunner {
  const issue = {
    number: 7,
    title: "Fixture: deterministic HDO workflow run",
    body: buildIssueBody(gateIds),
    state: "OPEN",
    labels: [{ name: "hdo:ready" }, { name: "hdo:priority/p2" }, { name: "hdo:risk/low" }],
    assignees: [],
    milestone: null,
    author: { login: "fixture-owner" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/hdo-fixture/repo/issues/7",
    comments: [],
  };
  return {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "auth" && args[1] === "status") return makeResult({ exitCode: 0 });
      if (args[0] === "issue" && args[1] === "view") return makeResult({ stdout: JSON.stringify(issue) });
      if (args[0] === "api" && args[1] === "graphql") {
        return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: null } } } }) });
      }
      if (args[0] === "api" && args.includes("--paginate")) {
        const endpoint = args.find((entry) => entry.includes("/issues/7/")) ?? "";
        if (endpoint.includes("/events")) {
          return makeResult({
            stdout: JSON.stringify([
              [{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "fixture-owner" }, created_at: "2026-01-02T00:00:00Z" }],
            ]),
          });
        }
        return makeResult({ stdout: JSON.stringify([[]]) }); // comments: no active claim
      }
      throw new Error(`scripted gh runner: unhandled call ${JSON.stringify(args)} (NoWriteBack must never reach here)`);
    },
  };
}

// --- config ---------------------------------------------------------------------

interface ScenarioWorkflowOverrides {
  onNoDiff?: string;
  onValidationFailure?: string;
  onMaxFixAttempts?: string;
  maxFixAttempts?: number;
}

function buildConfig(params: {
  repositoryPath: string;
  worktreeRoot: string;
  artifactRoot: string;
  scenarioId: string;
  workflow?: ScenarioWorkflowOverrides;
  planCommand?: string;
}): JsonObject {
  const scenarioPath = join(REPO_ROOT, "tests", "fixtures", "workflow", "scenarios", `${params.scenarioId}.json`);
  const runnerDefinition = (): JsonObject => ({
    type: "command",
    provider: "custom",
    command: "pwsh",
    sandbox: "workspace-write",
    timeoutSeconds: 60,
    passEnvironment: [],
    extraArgs: [
      "-NoProfile",
      "-File",
      MOCK_AGENT_PATH,
      "-SchemaFile",
      "{schemaFile}",
      "-OutputFile",
      "{outputFile}",
      "-Scenario",
      scenarioPath,
    ],
  });
  const planRunner = runnerDefinition();
  if (params.planCommand) planRunner.command = params.planCommand;
  return {
    schemaVersion: 1,
    activeProfile: "mock",
    resolvedProfile: "mock",
    repositoryPath: params.repositoryPath,
    projectContractPath: join(params.repositoryPath, ".hdo", "project.json"),
    configurationWarnings: [],
    repositoryConfig: { loaded: false },
    steps: { plan: "mock-plan", implement: "mock-implement", review: "mock-review", fix: "mock-implement" },
    runners: { "mock-plan": planRunner, "mock-implement": runnerDefinition(), "mock-review": runnerDefinition() },
    github: {
      writeBack: "none",
      assignOnClaim: false,
      trustedActors: [],
      candidateLimit: 50,
      priorityOrder: ["hdo:priority/p0", "hdo:priority/p1", "hdo:priority/p2", "hdo:priority/p3"],
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
    },
    workflow: {
      maxFixAttempts: 2,
      implicitFallback: false,
      onNoDiff: "fail",
      onValidationFailure: "request-changes",
      onMaxFixAttempts: "escalate",
      ...params.workflow,
    },
    paths: { worktreeRoot: params.worktreeRoot, artifactRoot: params.artifactRoot },
  };
}

function readEventsJsonl(artifactPath: string): JsonObject[] {
  const text = readFileSync(join(artifactPath, "events.jsonl"), "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

async function runScenario(params: {
  scenarioId: string;
  gateIds: string[];
  workflow?: ScenarioWorkflowOverrides;
  planCommand?: string;
}): Promise<{ result: RunRecord; tempDir: string }> {
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-run-test-")));
  const repositoryPath = buildFixtureRepo(tempDir);
  const worktreeRoot = join(tempDir, "worktrees");
  const artifactRoot = join(tempDir, "runs");
  const config = buildConfig({
    repositoryPath,
    worktreeRoot,
    artifactRoot,
    scenarioId: params.scenarioId,
    workflow: params.workflow,
    planCommand: params.planCommand,
  });
  const processRunner = new NodeProcessRunner({ platform });
  const git = new GitClient({ runner: processRunner, platform });
  const gh = new GhClient({ runner: makeGhRunner(params.gateIds) });

  const result = await runWorkflow({
    config,
    repositoryRoot: repositoryPath,
    repository: "hdo-fixture/repo",
    issueNumber: 7,
    pick: false,
    dryRun: false,
    noWriteBack: true,
    reresolveConfig: async () => config,
    gh,
    git,
    processRunner,
    platform,
    schemas,
    hdoRoot: REPO_ROOT,
    schemasDir: SCHEMAS_DIR,
  });
  return { result: result as RunRecord, tempDir };
}

function withCleanup(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
}

// --- scenarios (ADR-0001 phase 6 plan §3.4; minimum set for WP-F2's own integration test) --

test("run scenario a (approve-first): reaches APPROVED via CREATED..PLANNING..REVIEWING", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({ scenarioId: "a", gateIds: ["gate-pass"] });
  try {
    assert.equal(result.state, "APPROVED");
    assert.equal(result.iteration, 1);
    assert.equal(result.fixAttempts, 0);
    assert.equal(result.github.claim, null);
    assert.equal(result.result?.decision, "approve");
    assert.equal(result.result?.summary, "Mock review round 1: approve.");
    const transitions = readEventsJsonl(result.artifactPath)
      .filter((event) => event.type === "state.transition")
      .map((event) => ({ from: event.from, to: event.to }));
    assert.deepEqual(transitions, [
      { from: "CREATED", to: "ISSUE_SELECTED" },
      { from: "ISSUE_SELECTED", to: "PREFLIGHT" },
      { from: "PREFLIGHT", to: "WORKTREE_READY" },
      { from: "WORKTREE_READY", to: "PLANNING" },
      { from: "PLANNING", to: "IMPLEMENTING" },
      { from: "IMPLEMENTING", to: "VALIDATING" },
      { from: "VALIDATING", to: "REVIEWING" },
      { from: "REVIEWING", to: "APPROVED" },
    ]);
  } finally {
    withCleanup(tempDir);
  }
});

test("run scenario b (fix-then-approve): one fix iteration reaches APPROVED", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({ scenarioId: "b", gateIds: ["gate-pass"] });
  try {
    assert.equal(result.state, "APPROVED");
    assert.equal(result.iteration, 2);
    assert.equal(result.fixAttempts, 1);
    assert.equal(result.result?.decision, "approve");
    const transitions = readEventsJsonl(result.artifactPath)
      .filter((event) => event.type === "state.transition")
      .map((event) => ({ from: event.from, to: event.to, reason: event.reason }));
    assert.deepEqual(
      transitions.map((entry) => ({ from: entry.from, to: entry.to })),
      [
        { from: "CREATED", to: "ISSUE_SELECTED" },
        { from: "ISSUE_SELECTED", to: "PREFLIGHT" },
        { from: "PREFLIGHT", to: "WORKTREE_READY" },
        { from: "WORKTREE_READY", to: "PLANNING" },
        { from: "PLANNING", to: "IMPLEMENTING" },
        { from: "IMPLEMENTING", to: "VALIDATING" },
        { from: "VALIDATING", to: "REVIEWING" },
        { from: "REVIEWING", to: "CHANGES_REQUESTED" },
        { from: "CHANGES_REQUESTED", to: "IMPLEMENTING" },
        { from: "IMPLEMENTING", to: "VALIDATING" },
        { from: "VALIDATING", to: "REVIEWING" },
        { from: "REVIEWING", to: "APPROVED" },
      ],
    );
    assert.equal(transitions[7].reason, "Reviewer returned actionable findings.");
    assert.equal(transitions[8].reason, "Fix iteration started.");
  } finally {
    withCleanup(tempDir);
  }
});

test("run scenario e2 (no-diff-fail): FAILED with the exact PS throw text", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({ scenarioId: "e2", gateIds: ["gate-pass"] });
  try {
    assert.equal(result.state, "FAILED");
    assert.equal(result.error?.category, "RUN_FAILED");
    assert.equal(result.error?.message, "Implementation step completed without any worktree changes.");
    assert.equal(result.result, null);
  } finally {
    withCleanup(tempDir);
  }
});

test("run scenario g (gate-setup-failure): setup failure always stops remaining gates (#16 AC-02/AC-06)", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({
    scenarioId: "g",
    gateIds: ["gate-setup", "gate-after"],
    workflow: { onValidationFailure: "escalate" },
  });
  try {
    assert.equal(result.state, "ESCALATED");
    assert.equal(result.result?.decision, "escalate");
    assert.equal(result.result?.summary, "Required validation did not pass.");
    const validation = result.result?.validation as JsonObject;
    assert.equal(validation.indeterminate, 2);
    const gates = validation.gates as JsonObject[];
    assert.equal(gates[0].id, "gate-setup");
    assert.equal(gates[0].status, "indeterminate");
    assert.equal(gates[0].failureClass, "setup");
    assert.equal(gates[0].exitCode, null);
    assert.equal(gates[0].skipped, false);
    assert.equal(gates[1].id, "gate-after");
    assert.equal(gates[1].status, "indeterminate");
    assert.equal(gates[1].failureClass, "skipped");
    assert.equal(gates[1].skipped, true);
  } finally {
    withCleanup(tempDir);
  }
});

test("run scenario h (implement-exit-3): FAILED at IMPLEMENTING, activity key present as null", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({ scenarioId: "h", gateIds: ["gate-pass"] });
  try {
    assert.equal(result.state, "FAILED");
    assert.equal(result.error?.category, "RUN_FAILED");
    assert.equal(result.error?.message, "Agent step 'implement' failed with exit code 3. mock implement failure");
    assert.equal(Object.prototype.hasOwnProperty.call(result, "activity"), true);
    assert.equal(result.activity, null);
  } finally {
    withCleanup(tempDir);
  }
});

test("run scenario j (preflight-failed): a missing runner command fails preflight, category PREFLIGHT_FAILED, no worktree", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { result, tempDir } = await runScenario({
    scenarioId: "a",
    gateIds: ["gate-pass"],
    planCommand: "hdo-command-that-does-not-exist",
  });
  try {
    assert.equal(result.state, "FAILED");
    assert.equal(result.error?.category, "PREFLIGHT_FAILED");
    assert.ok(result.error?.message.includes("runner:mock-plan: Runner command 'hdo-command-that-does-not-exist' was not found."));
    assert.equal(result.worktree, null);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "activity"), false);
  } finally {
    withCleanup(tempDir);
  }
});

// --- pure dispatch-loop invariants (no fixture repo/gh needed for the first) --------

test("STEP_HANDLERS is exhaustive over every non-terminal RunState", () => {
  const nonTerminal = RUN_STATES.filter((state) => !isTerminalState(state)) as NonTerminalRunState[];
  assert.deepEqual(Object.keys(STEP_HANDLERS).sort(), [...nonTerminal].sort());
  assert.equal(Object.keys(STEP_HANDLERS).length, 10);
});

test("changesRequestedHandler: run.json at the CHANGES_REQUESTED transition still has result === null (deferred-terminal, scenario e no-diff-escalate)", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  // Oracle: Workflow.ps1:417-418 - `Set-HdoRunState ... 'CHANGES_REQUESTED'` (which
  // saves `run.json`) runs BEFORE `$run.result` is assigned; a wrapped
  // `STEP_HANDLERS.CHANGES_REQUESTED` reads `run.json` from disk at its own entry,
  // i.e. exactly when the CHANGES_REQUESTED transition has just been saved but the
  // pending terminal result has not yet been assigned onto `ctx.run.result`.
  const originalHandler = STEP_HANDLERS.CHANGES_REQUESTED;
  let resultAtTransition: unknown = "not-observed";
  STEP_HANDLERS.CHANGES_REQUESTED = async (ctx) => {
    const onDisk = JSON.parse(readFileSync(join(ctx.artifactPath, "run.json"), "utf8")) as JsonObject;
    resultAtTransition = onDisk.result;
    return originalHandler(ctx);
  };
  try {
    const { result, tempDir } = await runScenario({ scenarioId: "e", gateIds: ["gate-pass"], workflow: { onNoDiff: "escalate" } });
    try {
      assert.equal(resultAtTransition, null);
      assert.equal(result.state, "ESCALATED");
      assert.equal(result.result?.decision, "escalate");
      assert.equal(result.result?.summary, "Implementation produced no diff.");
    } finally {
      withCleanup(tempDir);
    }
  } finally {
    STEP_HANDLERS.CHANGES_REQUESTED = originalHandler;
  }
});

test("drive(): an illegal transition returned by a handler fails the run with IllegalStateTransitionError's text", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const originalCreatedHandler = STEP_HANDLERS.CREATED;
  STEP_HANDLERS.CREATED = async () => ({ to: "APPROVED", reason: "illegal, for the test only" });
  try {
    const { result, tempDir } = await runScenario({ scenarioId: "a", gateIds: ["gate-pass"] });
    try {
      assert.equal(result.state, "FAILED");
      assert.equal(result.error?.message, "Invalid HDO state transition: CREATED -> APPROVED");
      assert.equal(result.error?.category, "RUN_FAILED");
    } finally {
      withCleanup(tempDir);
    }
  } finally {
    STEP_HANDLERS.CREATED = originalCreatedHandler;
  }
});
