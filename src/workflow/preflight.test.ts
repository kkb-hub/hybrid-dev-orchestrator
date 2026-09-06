// Fake-platform/fake-runner tests for `runPreflight` (Test-HdoEnvironment port).
// `GitClient`/`GhClient` are constructed for real, over a scripted fake `ProcessRunner`
// (the pattern `src/github/client.test.ts` already uses) so their own real
// `-c core.longpaths=true`/argument-building logic still runs; only the actual
// process spawn is faked. `platform.resolveExecutable` is a plain lookup map
// spread over a real `getPlatform()` (the same pattern `src/git/index.test.ts` uses
// for its platform spies), so every OTHER PlatformAdapter method (comparableFullPath,
// pathEquals, ...) still behaves like the real platform.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { GhClient } from "../github/client.ts";
import { GitClient } from "../git/index.ts";
import { getPlatform } from "../platform/index.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { runPreflight } from "./preflight.ts";

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
const realPlatform = getPlatform();

/** `getPlatform()` with `resolveExecutable` replaced by a plain lookup map (undefined = "not found"). */
function fakePlatform(resolveMap: Record<string, string | undefined>): PlatformAdapter {
  return {
    ...realPlatform,
    resolveExecutable: (name: string) => resolveMap[name],
  };
}

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: overrides.command ?? "",
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

function scriptedRunner(handler: (options: ProcessRunOptions) => ProcessResult): ProcessRunner {
  return { async run(options: ProcessRunOptions): Promise<ProcessResult> { return handler(options); } };
}

/** `git rev-parse --show-toplevel` resolves to `REPO_ROOT`; `gh auth status` succeeds. */
function baseRunner(overrides: (options: ProcessRunOptions) => ProcessResult | undefined = () => undefined): ProcessRunner {
  return scriptedRunner((options) => {
    const scripted = overrides(options);
    if (scripted) return scripted;
    if (options.command === "git") return makeResult({ command: "git", stdout: `${REPO_ROOT}\n` });
    if (options.command === "gh") return makeResult({ command: "gh" });
    throw new Error(`preflight.test.ts: unscripted command '${options.command}' ${JSON.stringify(options.arguments)}`);
  });
}

function buildConfig(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    resolvedProfile: "claude-only",
    repositoryPath: REPO_ROOT,
    projectContractPath: PROJECT_CONTRACT_PATH,
    paths: { worktreeRoot: join(tmpdir(), "hdo-preflight-test-unused-worktree"), artifactRoot: join(tmpdir(), "hdo-preflight-test-unused-artifact") },
    steps: {
      plan: "claude-planner",
      implement: "claude-implementer",
      review: "claude-reviewer",
      fix: "claude-implementer",
    },
    runners: {
      "claude-planner": { type: "claude", provider: "cloud", command: "claude" },
      "claude-implementer": { type: "claude", provider: "cloud", command: "claude" },
      "claude-reviewer": { type: "claude", provider: "cloud", command: "claude" },
    },
    ...overrides,
  };
}

function checkByName(result: Awaited<ReturnType<typeof runPreflight>>, name: string) {
  return result.checks.find((check) => check.name === name);
}

test("runPreflight: default-shaped config produces checks in the exact PS order, provider:ollama skipped, paths:writable skipped in read-only", async () => {
  // `pwsh` resolved: the repository's own `.hdo/project.json` gates (`tests`,
  // `schemas`) both run `pwsh` (Issue #8, plan §8 Q1's `gate:<id>` check).
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe", pwsh: "C:\\bin\\pwsh.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  assert.deepEqual(
    result.checks.map((check) => check.name),
    [
      "command:git",
      "command:gh",
      "node-version",
      "git:repository",
      "github:authentication",
      "project-contract",
      "gate:tests",
      "gate:schemas",
      "runner:claude-planner",
      "runner:claude-implementer",
      "runner:claude-reviewer",
      "provider:ollama",
      "paths:writable",
    ],
  );
  // The repository's own `.hdo/project.json` (Issue #8, plan §8 Q1): both gates run
  // `pwsh`, which resolves on this machine, so both are `pass`/`required:false`.
  assert.equal(checkByName(result, "gate:tests")?.status, "pass");
  assert.equal(checkByName(result, "gate:tests")?.required, false);
  assert.ok(checkByName(result, "gate:tests")?.message.includes("resolves to"), checkByName(result, "gate:tests")?.message);
  assert.equal(checkByName(result, "gate:schemas")?.status, "pass");
  assert.equal(checkByName(result, "gate:schemas")?.required, false);
  assert.equal(checkByName(result, "provider:ollama")?.status, "skipped");
  assert.equal(checkByName(result, "provider:ollama")?.required, false);
  assert.equal(checkByName(result, "paths:writable")?.status, "skipped");
  assert.equal(checkByName(result, "paths:writable")?.required, false);
  // `node` is not stubbed into this test's platform map, so node-version is
  // "not found" here; the pass/old-version/undeterminable branches get their own
  // dedicated tests below.
  assert.equal(checkByName(result, "node-version")?.status, "warning");
  assert.equal(checkByName(result, "node-version")?.required, false);
  assert.equal(checkByName(result, "node-version")?.message, "node was not found.");
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.profile, "claude-only");
  assert.equal(result.schemaVersion, 1);
});

test("runPreflight: node-version passes with the trimmed version string when node resolves to major >= 24", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", node: "C:\\bin\\node.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "node") return makeResult({ command: "node", stdout: "v24.20.0\n" });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "node-version");
  assert.equal(check?.status, "pass");
  assert.equal(check?.required, false);
  assert.equal(check?.message, "v24.20.0");
});

test("runPreflight: node-version warns (required:false) with 'Node <version> is older than the required 24 LTS.' when major < 24", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", node: "C:\\bin\\node.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "node") return makeResult({ command: "node", stdout: "v18.20.0\n" });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "node-version");
  assert.equal(check?.status, "warning");
  assert.equal(check?.required, false);
  assert.equal(check?.message, "Node v18.20.0 is older than the required 24 LTS.");
});

test("runPreflight: node-version warns 'node was not found.' when node is not resolvable", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "node-version");
  assert.equal(check?.status, "warning");
  assert.equal(check?.required, false);
  assert.equal(check?.message, "node was not found.");
});

test("runPreflight: node-version warns 'node --version could not be determined.' on a non-zero exit or unparsable output", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", node: "C:\\bin\\node.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "node") return makeResult({ command: "node", exitCode: 1, stderr: "boom" });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "node-version");
  assert.equal(check?.status, "warning");
  assert.equal(check?.required, false);
  assert.equal(check?.message, "node --version could not be determined.");
});

test("runPreflight: node-version warns 'node --version could not be determined.' when stdout does not match ^v(\\d+)\\.", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", node: "C:\\bin\\node.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "node") return makeResult({ command: "node", stdout: "not a version\n" });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "node-version");
  assert.equal(check?.status, "warning");
  assert.equal(check?.required, false);
  assert.equal(check?.message, "node --version could not be determined.");
});

test("runPreflight: command:git/command:gh fail with '<name> was not found.' and their dependent checks are omitted entirely", async () => {
  const platform = fakePlatform({});
  const runner = scriptedRunner(() => {
    throw new Error("no command should run when git/gh are both unresolved");
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  assert.equal(checkByName(result, "command:git")?.status, "fail");
  assert.equal(checkByName(result, "command:git")?.message, "git was not found.");
  assert.equal(checkByName(result, "command:gh")?.status, "fail");
  assert.equal(checkByName(result, "command:gh")?.message, "gh was not found.");
  assert.equal(checkByName(result, "git:repository"), undefined);
  assert.equal(checkByName(result, "github:authentication"), undefined);
  assert.equal(result.ok, false);
});

test("runPreflight: git:repository fails with the thrown error message when git rev-parse fails", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "git") return makeResult({ command: "git", exitCode: 128, stderr: "fatal: not a git repository" });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "git:repository");
  assert.equal(check?.status, "fail");
  assert.ok(check?.message.includes("fatal: not a git repository"), check?.message);
  assert.equal(result.ok, false);
});

test("runPreflight: github:authentication fails with trimmed stderr when 'gh auth status' exits non-zero", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "gh") return makeResult({ command: "gh", exitCode: 1, stderr: "  not logged in  " });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "github:authentication");
  assert.equal(check?.status, "fail");
  assert.equal(check?.message, "not logged in");
  assert.equal(result.ok, false);
});

test("runPreflight: project-contract fails with the thrown message when the contract path is missing", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });
  const missingPath = resolvePath(REPO_ROOT, "does-not-exist", "project.json");

  const result = await runPreflight({
    config: buildConfig({ projectContractPath: missingPath }),
    readOnly: true,
    platform,
    processRunner: runner,
    git,
    gh,
    schemas,
  });

  const check = checkByName(result, "project-contract");
  assert.equal(check?.status, "fail");
  assert.equal(check?.message, `Project contract was not found: ${missingPath}`);
  assert.equal(result.ok, false);
});

/** A schema-valid project contract with a single validation gate, for the `gate:<id>` (Issue #8) tests. */
function writeProjectContractWithGate(dir: string, gateId: string, gateCommand: string): string {
  const contractPath = join(dir, "project.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      schemaVersion: 1,
      instructions: { files: [], specificationPaths: [] },
      validationGates: [
        {
          id: gateId,
          command: gateCommand,
          args: [],
          workingDirectory: ".",
          timeoutSeconds: 60,
          required: true,
          exitCodes: { passed: [0], failed: [1], indeterminate: [] },
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
        largeChangeLines: 400,
        onMissingViewpoint: "escalate",
        stableFindingIds: true,
        mutation: { enabled: false, oneWriterWindow: true, indeterminateIsSuccess: false },
      },
    }),
    "utf8",
  );
  return contractPath;
}

test("runPreflight: gate:<id> is 'warning' (required:false) when a gate command cannot be resolved, and 'ok' stays true (Issue #8, plan §8 Q1)", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });
  const dir = mkdtempSync(join(tmpdir(), "hdo-preflight-gate-"));
  try {
    const contractPath = writeProjectContractWithGate(dir, "missing-gate", "hdo-gate-command-that-does-not-exist");

    const result = await runPreflight({
      config: buildConfig({ projectContractPath: contractPath }),
      readOnly: true,
      platform,
      processRunner: runner,
      git,
      gh,
      schemas,
    });

    const check = checkByName(result, "gate:missing-gate");
    assert.equal(check?.status, "warning");
    assert.equal(check?.required, false);
    assert.equal(
      check?.message,
      "Validation gate 'missing-gate' command 'hdo-gate-command-that-does-not-exist' was not found. The gate would be recorded as a setup failure at run time.",
    );
    // A warning never flips `ok`.
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight: gate:<id> is 'pass' with the resolved path in the message when the gate command resolves", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe", pwsh: "C:\\bin\\pwsh.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });
  const dir = mkdtempSync(join(tmpdir(), "hdo-preflight-gate-"));
  try {
    const contractPath = writeProjectContractWithGate(dir, "pwsh-gate", "pwsh");

    const result = await runPreflight({
      config: buildConfig({ projectContractPath: contractPath }),
      readOnly: true,
      platform,
      processRunner: runner,
      git,
      gh,
      schemas,
    });

    const check = checkByName(result, "gate:pwsh-gate");
    assert.equal(check?.status, "pass");
    assert.equal(check?.message, "Validation gate 'pwsh-gate' command 'pwsh' resolves to C:\\bin\\pwsh.exe.");
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight: a runner command that does not resolve fails with 'Runner command ... was not found.'", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const config = buildConfig({
    steps: { plan: "codex-cloud-planner", implement: "claude-planner", review: "claude-planner", fix: "claude-planner" },
    runners: {
      "codex-cloud-planner": { type: "codex", provider: "cloud", command: "codex" },
      "claude-planner": { type: "claude", provider: "cloud", command: "claude" },
    },
  });

  const result = await runPreflight({ config, readOnly: true, platform, processRunner: runner, git, gh, schemas });

  const check = checkByName(result, "runner:codex-cloud-planner");
  assert.equal(check?.status, "fail");
  assert.equal(check?.message, "Runner command 'codex' was not found.");
  assert.equal(result.ok, false);
});

test("runPreflight: a claude runner resolved to a .cmd/.bat shim still passes but adds a required:false shim warning", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({ config: buildConfig(), readOnly: true, platform, processRunner: runner, git, gh, schemas });

  const plannerCheck = checkByName(result, "runner:claude-planner");
  assert.equal(plannerCheck?.status, "pass");
  const shimCheck = checkByName(result, "runner:claude-planner:shim");
  assert.equal(shimCheck?.status, "warning");
  assert.equal(shimCheck?.required, false);
  assert.ok(shimCheck?.message.includes("claude.cmd"), shimCheck?.message);
  assert.ok(shimCheck?.message.includes("prefer a native claude install"), shimCheck?.message);
  // A warning never flips `ok`.
  assert.equal(result.ok, true);
});

function ollamaHybridConfig(overrides: Partial<JsonObject> = {}): JsonObject {
  return buildConfig({
    steps: {
      plan: "codex-cloud-planner",
      implement: "claude-ollama-implementer",
      review: "codex-cloud-planner",
      fix: "claude-ollama-implementer",
    },
    runners: {
      "codex-cloud-planner": { type: "codex", provider: "cloud", command: "codex" },
      "claude-ollama-implementer": {
        type: "claude",
        provider: "ollama",
        command: "claude",
        model: "qwen3.8:27b-q4_K_M",
        contextTokens: 65536,
      },
    },
    ...overrides,
  });
}

test("runPreflight: provider:ollama fails when a step references ollama but the ollama command is unresolved", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", codex: "C:\\bin\\codex.exe", claude: "C:\\bin\\claude.exe" });
  const runner = baseRunner();
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({ config: ollamaHybridConfig(), readOnly: true, platform, processRunner: runner, git, gh, schemas });

  const check = checkByName(result, "provider:ollama");
  assert.equal(check?.status, "fail");
  assert.equal(check?.message, "Ollama is selected by the active profile but the ollama command was not found.");
  assert.equal(checkByName(result, "ollama-model:qwen3.8:27b-q4_K_M"), undefined);
  assert.equal(result.ok, false);
});

test("runPreflight: provider:ollama fails with trimmed stderr when 'ollama list' exits non-zero", async () => {
  const platform = fakePlatform({
    git: "C:\\bin\\git.exe",
    gh: "C:\\bin\\gh.exe",
    codex: "C:\\bin\\codex.exe",
    claude: "C:\\bin\\claude.exe",
    ollama: "C:\\bin\\ollama.exe",
  });
  const runner = baseRunner((options) => {
    if (options.command === "ollama") return makeResult({ command: "ollama", exitCode: 1, stderr: "  daemon not running  " });
    return undefined;
  });
  const git = new GitClient({ runner, platform });
  const gh = new GhClient({ runner });

  const result = await runPreflight({ config: ollamaHybridConfig(), readOnly: true, platform, processRunner: runner, git, gh, schemas });

  const check = checkByName(result, "provider:ollama");
  assert.equal(check?.status, "fail");
  assert.equal(check?.message, "Ollama is selected but unavailable: daemon not running");
  assert.equal(result.ok, false);
});

test("runPreflight: ollama-model pass/fail is derived from a '^<model>\\s' line match against scripted 'ollama list' stdout", async () => {
  const platform = fakePlatform({
    git: "C:\\bin\\git.exe",
    gh: "C:\\bin\\gh.exe",
    codex: "C:\\bin\\codex.exe",
    claude: "C:\\bin\\claude.exe",
    ollama: "C:\\bin\\ollama.exe",
  });

  // Present: the model line the real `ollama list` format uses (name, whitespace, id, ...).
  const presentRunner = baseRunner((options) => {
    if (options.command === "ollama" && options.arguments?.[0] === "list") {
      return makeResult({ command: "ollama", stdout: "qwen3.8:27b-q4_K_M\t0123456789ab\t4.7 GB\n" });
    }
    if (options.command === "ollama") return makeResult({ command: "ollama" });
    return undefined;
  });
  const presentResult = await runPreflight({
    config: ollamaHybridConfig(),
    readOnly: true,
    platform,
    processRunner: presentRunner,
    git: new GitClient({ runner: presentRunner, platform }),
    gh: new GhClient({ runner: presentRunner }),
    schemas,
  });
  assert.equal(checkByName(presentResult, "ollama-model:qwen3.8:27b-q4_K_M")?.status, "pass");
  assert.equal(checkByName(presentResult, "ollama-model:qwen3.8:27b-q4_K_M")?.message, "Model 'qwen3.8:27b-q4_K_M' is installed.");

  // Absent: 'ollama list' succeeds but never mentions the model.
  const absentRunner = baseRunner((options) => {
    if (options.command === "ollama" && options.arguments?.[0] === "list") {
      return makeResult({ command: "ollama", stdout: "llama3:8b\t0123456789ab\t4.7 GB\n" });
    }
    if (options.command === "ollama") return makeResult({ command: "ollama" });
    return undefined;
  });
  const absentResult = await runPreflight({
    config: ollamaHybridConfig(),
    readOnly: true,
    platform,
    processRunner: absentRunner,
    git: new GitClient({ runner: absentRunner, platform }),
    gh: new GhClient({ runner: absentRunner }),
    schemas,
  });
  const absentCheck = checkByName(absentResult, "ollama-model:qwen3.8:27b-q4_K_M");
  assert.equal(absentCheck?.status, "fail");
  assert.equal(absentCheck?.message, "Model 'qwen3.8:27b-q4_K_M' is not installed. HDO will not pull it automatically.");
  assert.equal(absentResult.ok, false);
});

function ollamaListRunner(overrides: (options: ProcessRunOptions) => ProcessResult | undefined = () => undefined): ProcessRunner {
  return baseRunner((options) => {
    const scripted = overrides(options);
    if (scripted) return scripted;
    if (options.command === "ollama" && options.arguments?.[0] === "list") {
      return makeResult({ command: "ollama", stdout: "qwen3.8:27b-q4_K_M\t0123456789ab\t4.7 GB\n" });
    }
    return undefined;
  });
}

test("runPreflight: ollama-context is skipped (readOnly), passes via a real resolveOllamaContextModel over a fake 'ollama create', or fails when create rejects", async () => {
  const platform = fakePlatform({
    git: "C:\\bin\\git.exe",
    gh: "C:\\bin\\gh.exe",
    codex: "C:\\bin\\codex.exe",
    claude: "C:\\bin\\claude.exe",
    ollama: "C:\\bin\\ollama.exe",
  });

  // readOnly: skipped, required:false, never calls 'ollama create'.
  const readOnlyRunner = ollamaListRunner((options) => {
    if (options.arguments?.[0] === "create") throw new Error("must not run 'ollama create' during a read-only preflight");
    return undefined;
  });
  const readOnlyResult = await runPreflight({
    config: ollamaHybridConfig(),
    readOnly: true,
    platform,
    processRunner: readOnlyRunner,
    git: new GitClient({ runner: readOnlyRunner, platform }),
    gh: new GhClient({ runner: readOnlyRunner }),
    schemas,
  });
  const skippedCheck = checkByName(readOnlyResult, "ollama-context:claude-ollama-implementer");
  assert.equal(skippedCheck?.status, "skipped");
  assert.equal(skippedCheck?.required, false);
  assert.equal(skippedCheck?.message, "Read-only preflight does not create the 65536-token derived Ollama model.");

  // non-readOnly, 'ollama create' succeeds: pass, message names the derived model.
  const passRunner = ollamaListRunner((options) => {
    if (options.arguments?.[0] === "create") return makeResult({ command: "ollama" });
    return undefined;
  });
  const worktreeRoot = mkdtempSync(join(tmpdir(), "hdo-preflight-writable-"));
  const passResult = await runPreflight({
    config: ollamaHybridConfig({ paths: { worktreeRoot, artifactRoot: worktreeRoot } }),
    readOnly: false,
    platform,
    processRunner: passRunner,
    git: new GitClient({ runner: passRunner, platform }),
    gh: new GhClient({ runner: passRunner }),
    schemas,
  });
  try {
    const passCheck = checkByName(passResult, "ollama-context:claude-ollama-implementer");
    assert.equal(passCheck?.status, "pass");
    assert.ok(passCheck?.message.includes("65536-token context model"), passCheck?.message);
    assert.ok(passCheck?.message.includes("qwen3.8:27b-q4_K_M"), passCheck?.message);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
  }

  // non-readOnly, 'ollama create' fails: fail, message is the thrown error text.
  // `resolveOllamaContextModel` calls `runner.run({..., throwOnError: true})`; the
  // real `NodeProcessRunner` is what turns a non-zero exit code into a throw (see
  // `src/runners/ollamaContextModel.test.ts`'s own fake-runner pattern) - a bare
  // fake `ProcessRunner` must throw directly to emulate that.
  const failRunner = ollamaListRunner((options) => {
    if (options.arguments?.[0] === "create") {
      throw new Error("Command 'ollama' failed with exit code 1. unknown model");
    }
    return undefined;
  });
  const worktreeRoot2 = mkdtempSync(join(tmpdir(), "hdo-preflight-writable-"));
  const failResult = await runPreflight({
    config: ollamaHybridConfig({ paths: { worktreeRoot: worktreeRoot2, artifactRoot: worktreeRoot2 } }),
    readOnly: false,
    platform,
    processRunner: failRunner,
    git: new GitClient({ runner: failRunner, platform }),
    gh: new GhClient({ runner: failRunner }),
    schemas,
  });
  try {
    const failCheck = checkByName(failResult, "ollama-context:claude-ollama-implementer");
    assert.equal(failCheck?.status, "fail");
    assert.ok(failCheck?.message.includes("unknown model"), failCheck?.message);
    assert.equal(failResult.ok, false);
  } finally {
    rmSync(worktreeRoot2, { recursive: true, force: true });
  }
});

test("runPreflight: ollama-context warns (required:false) instead of failing when a claude+ollama runner sets no contextTokens", async () => {
  const platform = fakePlatform({
    git: "C:\\bin\\git.exe",
    gh: "C:\\bin\\gh.exe",
    codex: "C:\\bin\\codex.exe",
    claude: "C:\\bin\\claude.exe",
    ollama: "C:\\bin\\ollama.exe",
  });
  const runner = ollamaListRunner();
  const config = ollamaHybridConfig({
    runners: {
      "codex-cloud-planner": { type: "codex", provider: "cloud", command: "codex" },
      "claude-ollama-implementer": { type: "claude", provider: "ollama", command: "claude", model: "qwen3.8:27b-q4_K_M" },
    },
  });

  const result = await runPreflight({
    config,
    readOnly: true,
    platform,
    processRunner: runner,
    git: new GitClient({ runner, platform }),
    gh: new GhClient({ runner }),
    schemas,
  });

  const check = checkByName(result, "ollama-context:claude-ollama-implementer");
  assert.equal(check?.status, "warning");
  assert.equal(check?.required, false);
  assert.ok(check?.message.includes("does not set contextTokens"), check?.message);
  // A warning never flips `ok` (no other required check fails in this config).
  assert.equal(result.ok, true);
});

test("runPreflight: non-read-only paths:writable probes real directories, pass when writable and fail when not", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe" });
  const runner = baseRunner();
  const root = mkdtempSync(join(tmpdir(), "hdo-preflight-writable-"));
  const worktreeRoot = join(root, "worktrees");
  const artifactRoot = join(root, "runs");
  try {
    const result = await runPreflight({
      config: buildConfig({ paths: { worktreeRoot, artifactRoot } }),
      readOnly: false,
      platform,
      processRunner: runner,
      git: new GitClient({ runner, platform }),
      gh: new GhClient({ runner }),
      schemas,
    });
    assert.equal(checkByName(result, "paths:worktreeRoot")?.status, "pass");
    assert.equal(checkByName(result, "paths:worktreeRoot")?.message, worktreeRoot);
    assert.equal(checkByName(result, "paths:artifactRoot")?.status, "pass");
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Unwritable: a path whose parent segment is a plain FILE, so mkdir(recursive) throws.
  const blockerRoot = mkdtempSync(join(tmpdir(), "hdo-preflight-unwritable-"));
  const blockerFile = join(blockerRoot, "blocker");
  writeFileSync(blockerFile, "x", "utf8");
  try {
    const badPath = join(blockerFile, "sub", "dir");
    const result = await runPreflight({
      config: buildConfig({ paths: { worktreeRoot: badPath, artifactRoot: badPath } }),
      readOnly: false,
      platform,
      processRunner: runner,
      git: new GitClient({ runner, platform }),
      gh: new GhClient({ runner }),
      schemas,
    });
    assert.equal(checkByName(result, "paths:worktreeRoot")?.status, "fail");
    assert.equal(result.ok, false);
  } finally {
    rmSync(blockerRoot, { recursive: true, force: true });
  }
});

test("runPreflight: check messages are redacted via protectText", async () => {
  const platform = fakePlatform({ git: "C:\\bin\\git.exe", gh: "C:\\bin\\gh.exe", claude: "C:\\bin\\claude.exe" });
  const runner = baseRunner((options) => {
    if (options.command === "gh") return makeResult({ command: "gh", exitCode: 1, stderr: 'token="sk-ant-abcdefghijklmnop"' });
    return undefined;
  });
  const result = await runPreflight({
    config: buildConfig(),
    readOnly: true,
    platform,
    processRunner: runner,
    git: new GitClient({ runner, platform }),
    gh: new GhClient({ runner }),
    schemas,
  });
  const check = checkByName(result, "github:authentication");
  assert.equal(check?.status, "fail");
  assert.ok(!check?.message.includes("sk-ant-abcdefghijklmnop"), check?.message);
  assert.ok(check?.message.includes("[REDACTED]"), check?.message);
});
