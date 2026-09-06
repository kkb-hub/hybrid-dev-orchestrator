// Tests for `runRunCommand` (hdo.ps1's `'run'` case port): the `-Issue`/`-Pick`
// mutual-exclusion check (cheap, no fixture needed) and the exit-code mapping table
// (hdo.ps1:133-136) driven end to end through `parseArgs` + a real fixture repository,
// with a scripted `ProcessRunner` injected as `GhClient`'s runner (no real `gh`
// network call, no PATH shim - `runRunCommand` itself still builds a real
// `NodeProcessRunner`/`GitClient` for git/agent/gate execution, exactly like
// `run.test.ts`).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import { GhClient } from "../github/client.ts";
import { parseArgs } from "./args.ts";
import { runRunCommand } from "./runCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MOCK_AGENT_PATH = join(REPO_ROOT, "tests", "fixtures", "workflow", "mock-workflow-agent.ps1");

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

function detectGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

const SKIP_REASON = !detectGit() ? "git is not on PATH" : !detectPwsh() ? "pwsh is not on PATH" : false;

const platform = getPlatform();
const schemas = loadSchemaRegistry();

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
  writeFileSync(join(repoDir, "README.md"), "fixture\n", "utf8");
  writeFileSync(join(repoDir, "tracked.txt"), "baseline\n", "utf8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "baseline"]);
  return repoDir;
}

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
    "Deterministic fixture body for the runCommand exit-code integration test.",
    "",
    "## Goal",
    "",
    "Exercise the run CLI exit-code mapping end to end using deterministic mock adapters.",
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

function makeGhRunner(gateIds: string[]): ProcessRunner {
  const issue = {
    number: 7,
    title: "Fixture: deterministic HDO run-command exit-code run",
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
        return makeResult({ stdout: JSON.stringify([[]]) });
      }
      throw new Error(`scripted gh runner: unhandled call ${JSON.stringify(args)} (NoWriteBack must never reach here)`);
    },
  };
}

function writeOverlay(params: {
  tempDir: string;
  scenarioId: string;
  worktreeRoot: string;
  artifactRoot: string;
  planCommand?: string;
}): string {
  const scenarioPath = join(REPO_ROOT, "tests", "fixtures", "workflow", "scenarios", `${params.scenarioId}.json`);
  const runnerDefinition = (sandbox: string): unknown => ({
    type: "command",
    provider: "custom",
    command: "pwsh",
    sandbox,
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
  const planRunner = runnerDefinition("read-only") as Record<string, unknown>;
  if (params.planCommand) planRunner.command = params.planCommand;
  const overlay = {
    activeProfile: "mock",
    profiles: { mock: { steps: { plan: "mock-plan", implement: "mock-implement", review: "mock-review", fix: "mock-implement" } } },
    runners: { "mock-plan": planRunner, "mock-implement": runnerDefinition("workspace-write"), "mock-review": runnerDefinition("read-only") },
    github: { writeBack: "none" },
    workflow: { maxFixAttempts: 2, onNoDiff: "fail", onValidationFailure: "request-changes", onMaxFixAttempts: "escalate" },
    paths: { worktreeRoot: params.worktreeRoot, artifactRoot: params.artifactRoot },
    projectContractPath: ".hdo/project.json",
  };
  const overlayPath = join(params.tempDir, "overlay.json");
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2), "utf8");
  return overlayPath;
}

async function runCase(params: { scenarioId: string; gateIds: string[]; planCommand?: string }): Promise<{ exitCode: number; tempDir: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), "hdo-runCommand-test-"));
  const repositoryPath = buildFixtureRepo(tempDir);
  const worktreeRoot = join(tempDir, "worktrees");
  const artifactRoot = join(tempDir, "runs");
  const overlayPath = writeOverlay({ tempDir, scenarioId: params.scenarioId, worktreeRoot, artifactRoot, planCommand: params.planCommand });
  const parsed = parseArgs([
    "run",
    "-Issue",
    "7",
    "-NoWriteBack",
    "-Json",
    "-Config",
    overlayPath,
    "-RepositoryPath",
    repositoryPath,
    "-Repository",
    "hdo-fixture/repo",
  ]);
  const gh = new GhClient({ runner: makeGhRunner(params.gateIds) });
  // Suppresses the default `HDO_PROGRESS` stderr sink (hdo.ps1:112-115) for test output
  // cleanliness only; the default sink itself is exercised by `main.ts`'s CLI wiring.
  const { exitCode } = await runRunCommand({ parsed, platform, schemas, gh, activityCallback: () => {} });
  return { exitCode, tempDir };
}

test("runRunCommand: -Issue and -Pick together throws the exact PS conflict text", async () => {
  const parsed = parseArgs(["run", "-Issue", "7", "-Pick", "-NoWriteBack"]);
  await assert.rejects(
    () => runRunCommand({ parsed, platform, schemas }),
    (error: unknown) => error instanceof Error && error.message === "Specify either -Issue or -Pick, not both.",
  );
});

test("runRunCommand: -RepositoryPath outside a git repository aborts before any GitHub access", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  // Oracle: Workflow.ps1:244, `Get-HdoRepositoryRoot` -> `Invoke-HdoGit ... -ThrowOnError`
  // -> `Command 'git' failed with exit code 128. fatal: not a git repository ...`, no
  // gh call. A scripted gh runner that records every call it receives lets this test
  // assert zero calls, not just the exit code.
  const tempDir = mkdtempSync(join(tmpdir(), "hdo-runCommand-nongit-test-"));
  const nonGitDir = join(tempDir, "not-a-repo");
  mkdirSync(nonGitDir, { recursive: true });
  try {
    const parsed = parseArgs([
      "run",
      "-Issue",
      "7",
      "-NoWriteBack",
      "-Json",
      "-RepositoryPath",
      nonGitDir,
      "-Repository",
      "hdo-fixture/repo",
    ]);
    const calls: unknown[][] = [];
    const gh = new GhClient({
      runner: {
        async run(options: ProcessRunOptions): Promise<ProcessResult> {
          calls.push(options.arguments ?? []);
          return makeResult({ exitCode: 0 });
        },
      },
    });
    await assert.rejects(
      () => runRunCommand({ parsed, platform, schemas, gh, activityCallback: () => {} }),
      (error: unknown) => error instanceof Error && error.message.startsWith("Command 'git' failed"),
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runRunCommand exit-code mapping: approve -> 0", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { exitCode, tempDir } = await runCase({ scenarioId: "a", gateIds: ["gate-pass"] });
  try {
    assert.equal(exitCode, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runRunCommand exit-code mapping: review escalate -> 6", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { exitCode, tempDir } = await runCase({ scenarioId: "d", gateIds: ["gate-pass"] });
  try {
    assert.equal(exitCode, 6);
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runRunCommand exit-code mapping: no-diff-fail -> 5", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { exitCode, tempDir } = await runCase({ scenarioId: "e2", gateIds: ["gate-pass"] });
  try {
    assert.equal(exitCode, 5);
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runRunCommand exit-code mapping: preflight failure (missing runner command) -> 3", { skip: SKIP_REASON, timeout: 60_000 }, async () => {
  const { exitCode, tempDir } = await runCase({ scenarioId: "a", gateIds: ["gate-pass"], planCommand: "hdo-command-that-does-not-exist" });
  try {
    assert.equal(exitCode, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
