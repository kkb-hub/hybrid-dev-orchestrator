// Integration tests for `runAgentStep` against the REAL `NodeProcessRunner` (real
// process spawn, real Windows containment) and the real `tests/fixtures/runtime/*`
// fixtures `tests/run-tests.ps1` itself spawns (:1086-1136, :1154-1174, :1176-1193,
// :1223-1238). Skipped off Windows or when `pwsh` is not on PATH; on Windows this also
// depends on WP-D's cmd.exe-shim wrapper in `src/process/runner.ts` to spawn the
// `.cmd` fixtures at all (ADR-0001 phase 5 plan §7 risk 20) - that dependency has
// already landed in this worktree, so cases (b)-(d) below are not skipped here.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../core/contracts/types.ts";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { runAgentStep } from "./agentStep.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "runtime");

/** Duplicated (not imported) from `src/cli/schemaLoader.ts`: `src/runners/**` tests
 * must not depend on `src/cli/**` (ADR-0001 phase 5 plan §2 boundary). */
function loadTestSchemaRegistry(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}
const schemas = loadTestSchemaRegistry();

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const IS_WINDOWS = process.platform === "win32";
const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = !IS_WINDOWS ? "Windows-only (real .cmd shims/pwsh)" : PWSH_AVAILABLE ? false : "pwsh is not on PATH";

const platform = getPlatform();
const processRunner = new NodeProcessRunner({ platform });

function buildConfig(step: string, runnerName: string, runner: JsonObject): JsonObject {
  return {
    steps: { [step]: runnerName },
    runners: { [runnerName]: runner },
  };
}

function propertyOf(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

test(
  "runAgentStep (integration): command runner spawns a real pwsh process, streams heartbeats, and returns valid structured output",
  { skip: SKIP_REASON, timeout: 60_000 },
  async () => {
    // Oracle: tests/run-tests.ps1:1086-1136.
    const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-it-mockagent-"));
    try {
      const config = buildConfig("plan", "mock-agent", {
        type: "command",
        provider: "custom",
        command: "pwsh",
        sandbox: "read-only",
        timeoutSeconds: 30,
        passEnvironment: [],
        promptTransport: "stdin",
        extraArgs: [
          "-NoProfile",
          "-File",
          join(FIXTURES_DIR, "mock-agent.ps1"),
          "-SchemaFile",
          "{schemaFile}",
          "-OutputFile",
          "{outputFile}",
          "-DelayMilliseconds",
          "1500",
        ],
      });
      const events: JsonObject[] = [];
      const result = await runAgentStep({
        config,
        run: { id: "it-run", state: "PLANNING" },
        step: "plan",
        iteration: 0,
        workingDirectory: REPO_ROOT,
        prompt: "mock prompt",
        artifactDirectory,
        outputSchema: "task-contract",
        schemas,
        schemasDir: SCHEMAS_DIR,
        hdoRoot: REPO_ROOT,
        platform,
        processRunner,
        progressIntervalSeconds: 1,
        activityCallback: (event) => {
          events.push(event);
        },
      });

      assert.equal(result.status, "succeeded");
      assert.equal(propertyOf(result.output, "schemaVersion"), 1);
      assert.ok(events.length >= 1);
      assert.equal(events[0].type, "agent.progress");
      assert.equal(events[0].phase, "started");
      assert.ok(events.some((event) => event.phase === "heartbeat"), "expected at least one heartbeat event");
    } finally {
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "runAgentStep (integration): claude adapter invokes a real .cmd shim and extracts structured_output",
  { skip: SKIP_REASON, timeout: 60_000 },
  async () => {
    // Oracle: tests/run-tests.ps1:1154-1174.
    const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-it-claude-"));
    try {
      const config = buildConfig("plan", "mock-claude", {
        type: "claude",
        provider: "cloud",
        command: join(FIXTURES_DIR, "mock-claude.cmd"),
        sandbox: "read-only",
        timeoutSeconds: 30,
        passEnvironment: [],
        extraArgs: [],
      });
      const result = await runAgentStep({
        config,
        run: { id: "it-run", state: "PLANNING" },
        step: "plan",
        iteration: 0,
        workingDirectory: REPO_ROOT,
        prompt: "mock prompt",
        artifactDirectory,
        outputSchema: "task-contract",
        schemas,
        schemasDir: SCHEMAS_DIR,
        hdoRoot: REPO_ROOT,
        platform,
        processRunner,
      });

      assert.equal(result.status, "succeeded");
      assert.equal(propertyOf(result.output, "objective"), "Implement the normalized issue delivery cycle.");
      assert.equal(result.artifacts.events, join(artifactDirectory, "envelope.json"));
      assert.ok(existsSync(result.artifacts.events));
    } finally {
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "runAgentStep (integration): claude/ollama adapter recovers a real prose-prefixed result and preserves the worker's file edit",
  { skip: SKIP_REASON, timeout: 60_000 },
  async () => {
    // Oracle: tests/run-tests.ps1:1176-1193. `mock-claude-ollama-prose.cmd` writes
    // `hdo-ollama-smoke.txt` into ITS CURRENT DIRECTORY (ADR-0001 phase 5 plan §7 risk
    // 19), so `workingDirectory` must be a scratch temp dir, distinct from the
    // artifact directory.
    const workingDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-it-ollama-work-"));
    const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-it-ollama-artifacts-"));
    try {
      const config = buildConfig("implement", "mock-ollama", {
        type: "claude",
        provider: "ollama",
        command: join(FIXTURES_DIR, "mock-claude-ollama-prose.cmd"),
        sandbox: "read-only",
        timeoutSeconds: 30,
        passEnvironment: [],
        extraArgs: [],
      });
      const result = await runAgentStep({
        config,
        run: { id: "it-run", state: "IMPLEMENTING" },
        step: "implement",
        iteration: 0,
        workingDirectory,
        prompt: "mock prompt",
        artifactDirectory,
        outputSchema: "worker-result",
        schemas,
        schemasDir: SCHEMAS_DIR,
        hdoRoot: REPO_ROOT,
        platform,
        processRunner,
      });

      assert.equal(result.status, "succeeded");
      const smokeFile = join(workingDirectory, "hdo-ollama-smoke.txt");
      assert.ok(existsSync(smokeFile), "expected the worker's file edit to survive recovery");
      assert.equal(readFileSync(smokeFile, "utf8").trim(), "HDO_OLLAMA_SMOKE_OK");
      // Oracle: tests/run-tests.ps1:1191-1193.
      for (const name of ["envelope.json", "result.original.txt", "recovery.input.txt", "recovery.output.txt", "structured-output.json"]) {
        assert.ok(existsSync(join(artifactDirectory, name)), `expected ${name} to exist`);
      }
      const diagnostic = JSON.parse(readFileSync(join(artifactDirectory, "structured-output.json"), "utf8"));
      assert.equal(diagnostic.recovery, "succeeded");
      assert.equal(diagnostic.attempts, 1);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "runAgentStep (integration): claude adapter surfaces the envelope root cause before secondary stderr on a real failing .cmd shim",
  { skip: SKIP_REASON, timeout: 60_000 },
  async () => {
    // Oracle: tests/run-tests.ps1:1223-1238.
    const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-it-claudefail-"));
    try {
      const config = buildConfig("plan", "mock-claude-failure", {
        type: "claude",
        provider: "cloud",
        command: join(FIXTURES_DIR, "mock-claude-failure.cmd"),
        sandbox: "read-only",
        timeoutSeconds: 30,
        passEnvironment: [],
        extraArgs: [],
      });
      await assert.rejects(
        () =>
          runAgentStep({
            config,
            run: { id: "it-run", state: "PLANNING" },
            step: "plan",
            iteration: 0,
            workingDirectory: REPO_ROOT,
            prompt: "mock prompt",
            artifactDirectory,
            outputSchema: "task-contract",
            schemas,
            schemasDir: SCHEMAS_DIR,
            hdoRoot: REPO_ROOT,
            platform,
            processRunner,
          }),
        /API Error: response exceeded the output token maximum\..*terminal_reason: api_error.*stderr: \[claude-code:unrecognized_model\]/s,
      );
      assert.ok(existsSync(join(artifactDirectory, "envelope.json")));
    } finally {
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  },
);
