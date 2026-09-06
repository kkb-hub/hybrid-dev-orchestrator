// Tests for `runAgentStep` (`Invoke-HdoAgentStep`, Runner.ps1:530-760) against a
// scripted FAKE `ProcessRunner` - no real process is ever spawned here (see
// `agentStep.integration.test.ts` for the real-`NodeProcessRunner`/real-pwsh variant,
// gated on Windows + WP-D). The fake records every `run()` call, optionally writes the
// stdout/stderr/final-output files a real agent CLI would have written, and returns a
// scripted `ProcessResult`.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../core/contracts/types.ts";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { toCodexTransportSchemaJson } from "../core/runners/codexSchema.ts";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import { type AgentStepOptions, runAgentStep } from "./agentStep.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
const platform = getPlatform();

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

const VALID_TASK_CONTRACT = {
  schemaVersion: 1,
  objective: "Exercise the command runner.",
  approach: ["Return deterministic structured output."],
  acceptanceCriteria: ["AC-1: output is valid"],
  expectedFiles: [],
  risks: [],
  assumptions: [],
};

class FakeProcessRunner implements ProcessRunner {
  calls: ProcessRunOptions[] = [];
  private readonly behavior: (options: ProcessRunOptions) => ProcessResult | Promise<ProcessResult>;
  constructor(behavior: (options: ProcessRunOptions) => ProcessResult | Promise<ProcessResult>) {
    this.behavior = behavior;
  }
  async run(options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push(options);
    // Mirrors the real `NodeProcessRunner`: it always creates the stdout/stderr
    // capture files (even if the child writes nothing to them) before this function's
    // own `copyFileSync(stdoutPath, eventsPath)`/`protectLogFile` calls run. A test's
    // own `behavior` can still overwrite either file afterward via `writeCapture`.
    if (options.standardOutputPath) writeCapture(options.standardOutputPath, "");
    if (options.standardErrorPath) writeCapture(options.standardErrorPath, "");
    return this.behavior(options);
  }
}

function writeCapture(path: string | undefined, text: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** Minimal successful `ProcessResult`, filling in every field the contract requires. */
function successResult(options: ProcessRunOptions, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: options.command,
    arguments: options.arguments ?? [],
    exitCode: 0,
    timedOut: false,
    outputLimitExceeded: false,
    outputLimitStream: "",
    outputDrainTimedOut: false,
    maximumOutputBytes: 33554432,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: options.standardOutputPath ?? "",
    stderrPath: options.standardErrorPath ?? "",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

/** `AgentStepResult.output`/`.requested.*` are typed `JsonValue`; every fixture here is a plain object. */
function objectiveOf(output: unknown): unknown {
  return (output as { objective?: unknown }).objective;
}

function buildConfig(step: string, runnerName: string, runner: JsonObject): JsonObject {
  return {
    steps: { [step]: runnerName },
    runners: { [runnerName]: runner },
  };
}

interface Dirs {
  workingDirectory: string;
  artifactDirectory: string;
}

async function withTempDirs(fn: (dirs: Dirs) => Promise<void> | void): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-work-"));
  const artifactDirectory = mkdtempSync(join(tmpdir(), "hdo-agentStep-artifacts-"));
  try {
    await fn({ workingDirectory, artifactDirectory });
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

function makeOptions(
  partial: Partial<AgentStepOptions> & { config: JsonObject; processRunner: ProcessRunner; workingDirectory: string; artifactDirectory: string },
): AgentStepOptions {
  return {
    run: { id: "test-run", state: "PLANNING" },
    step: "plan",
    iteration: 0,
    prompt: "mock prompt",
    outputSchema: "task-contract",
    schemas,
    schemasDir: SCHEMAS_DIR,
    hdoRoot: REPO_ROOT,
    platform,
    ambientEnvironment: {},
    ...partial,
  };
}

test("runAgentStep: disabled step throws before any process runs", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const runner = new FakeProcessRunner((options) => successResult(options));
    await assert.rejects(
      () =>
        runAgentStep(
          makeOptions({ config: { steps: {}, runners: {} }, processRunner: runner, workingDirectory, artifactDirectory }),
        ),
      /^Error: Step 'plan' is disabled\.$/,
    );
    assert.equal(runner.calls.length, 0);
  });
});

test("runAgentStep: command runner (stdin transport) sends the prompt on stdin, expands tokens, and falls back to stdout for final.json", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      provider: "custom",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "stdin",
      extraArgs: ["{workingDirectory}", "{step}", "{iteration}", "{runId}", "{hdoRoot}"],
    });
    const runner = new FakeProcessRunner((options) => {
      writeCapture(options.standardOutputPath, JSON.stringify(VALID_TASK_CONTRACT));
      return successResult(options);
    });
    const result = await runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory }));

    assert.equal(result.status, "succeeded");
    assert.equal(runner.calls.length, 1);
    const call = runner.calls[0];
    assert.equal(call.inputText, "mock prompt");
    const expandedWorkingDirectory = platform.comparableFullPath(workingDirectory);
    assert.deepEqual(call.arguments, [expandedWorkingDirectory, "plan", "0", "test-run", REPO_ROOT]);
    assert.equal(result.artifacts.events, join(artifactDirectory, "events.jsonl"));
    assert.equal(JSON.parse(readFileSync(result.artifacts.final, "utf8")).objective, VALID_TASK_CONTRACT.objective);
    assert.equal(objectiveOf(result.output), VALID_TASK_CONTRACT.objective);
  });
});

test("runAgentStep: command runner (file transport) sends no stdin and reads final.json from the output file", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      provider: "custom",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "file",
      extraArgs: ["{outputFile}"],
    });
    const runner = new FakeProcessRunner((options) => {
      const outputFile = options.arguments?.[0];
      assert.ok(outputFile?.endsWith("final.json"));
      writeCapture(outputFile, JSON.stringify(VALID_TASK_CONTRACT));
      writeCapture(options.standardOutputPath, "should not be used as final.json");
      return successResult(options);
    });
    const result = await runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory }));

    assert.equal(runner.calls[0].inputText, undefined);
    assert.equal(objectiveOf(result.output), VALID_TASK_CONTRACT.objective);
  });
});

test("runAgentStep: unsupported command promptTransport throws with the original (non-normalized) value", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "Weird",
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => successResult(options));
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Unsupported command promptTransport 'Weird'\.$/,
    );
  });
});

test("runAgentStep: unsupported runner type (non-empty, e.g. 'Robot') throws with the original (non-lower-cased) value, AFTER writing prompt.md - matching PS", async () => {
  // PS evidence (review round 2 should-fix 1, deep\a2\compare-round2.txt, oracle
  // Runner.ps1:547-611): `$type = [string]$runner.type` (:547) resolves fine for a
  // non-empty unknown type, so PS goes on to run `New-Item` (:549), resolve the
  // schema path, and write `prompt.md` (:558) BEFORE finally reaching the dispatch's
  // trailing `else { throw "Unsupported runner type '$type'." }` (:610-611). The `a2`
  // oracle harness observed exactly this for `type: "Gemini"`:
  //   PS artifacts: "prompt.md" (content "Hello prompt\nwith token=[REDACTED] inside\r\n")
  //   TS (before this fix): no artifacts dir at all - a regression from round 1,
  //   where this case was reported SAME.
  // This test uses "Robot" (an existing fixture value) for the same non-empty-type
  // shape; agentStep.integration.test.ts / the a2 harness are what actually drove a
  // real pwsh process for the "Gemini" case above.
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", { type: "Robot", command: "mock", sandbox: "read-only", timeoutSeconds: 30, passEnvironment: [], extraArgs: [] });
    const runner = new FakeProcessRunner((options) => successResult(options));
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Unsupported runner type 'Robot'\.$/,
    );
    assert.equal(runner.calls.length, 0);
    const promptPath = join(artifactDirectory, "prompt.md");
    assert.equal(existsSync(promptPath), true, "expected prompt.md to exist for a non-empty unknown runner type, matching PS");
    assert.equal(readFileSync(promptPath, "utf8"), "mock prompt\n");
  });
});

test("runAgentStep: unsupported runner type (missing/type-less runner) throws BEFORE creating any artifacts - matching PS strict mode", async () => {
  // PS evidence (review round 2 should-fix 1 / round-1 N-6, deep\a2\compare-round2.txt):
  // for the a2 harness's "missing-type"/"unknown-runner" fixtures, `[string]$runner.type`
  // (Runner.ps1:547) itself throws under PS strict mode - "The property 'type' cannot
  // be found on this object." - BEFORE `New-Item` (:549) ever runs, so NEITHER side
  // produced an artifacts directory for that case (only the throw TEXT differs, by
  // design - N-6 - since TS never runs under PS strict mode and reports "Unsupported
  // runner type ''." instead). This test pins the artifact-side-effect half of that
  // parity: `rawType === ""` must keep throwing before `mkdirSync`/`prompt.md`.
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      extraArgs: [],
    }); // deliberately no `type` field
    const runner = new FakeProcessRunner((options) => successResult(options));
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Unsupported runner type ''\.$/,
    );
    assert.equal(runner.calls.length, 0);
    assert.equal(existsSync(join(artifactDirectory, "prompt.md")), false, "expected no prompt.md for a type-less runner, matching PS");
    assert.deepEqual(readdirSync(artifactDirectory), [], "expected no artifacts at all for a type-less runner, matching PS");
  });
});

test("runAgentStep: codex runner writes output.schema.json, points --output-schema/--output-last-message at it, and validates the final output", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock-codex", {
      type: "codex",
      provider: "cloud",
      command: "codex",
      sandbox: "workspace-write",
      timeoutSeconds: 30,
      passEnvironment: [],
      extraArgs: [],
    });
    const expectedFinalPath = join(artifactDirectory, "final.json");
    const expectedCodexSchemaPath = join(artifactDirectory, "output.schema.json");
    const runner = new FakeProcessRunner((options) => {
      const schemaIndex = options.arguments?.indexOf("--output-schema");
      assert.ok(schemaIndex !== undefined && schemaIndex >= 0);
      assert.equal(options.arguments?.[schemaIndex! + 1], expectedCodexSchemaPath);
      const lastMessageIndex = options.arguments?.indexOf("--output-last-message");
      assert.equal(options.arguments?.[lastMessageIndex! + 1], expectedFinalPath);
      assert.equal(
        readFileSync(expectedCodexSchemaPath, "utf8"),
        `${toCodexTransportSchemaJson(schemas.getDocument("task-contract"))}\n`,
      );
      writeCapture(expectedFinalPath, JSON.stringify(VALID_TASK_CONTRACT));
      return successResult(options);
    });
    const result = await runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory }));
    assert.equal(result.status, "succeeded");
    assert.equal(result.artifacts.events, join(artifactDirectory, "events.jsonl"));
  });
});

test("runAgentStep: codex runner throws when it exits zero without writing final.json", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock-codex", {
      type: "codex",
      provider: "cloud",
      command: "codex",
      sandbox: "workspace-write",
      timeoutSeconds: 30,
      passEnvironment: [],
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => successResult(options));
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Codex step 'plan' did not write its final output\.$/,
    );
  });
});

const CLAUDE_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Planned the delivery cycle.",
  structured_output: VALID_TASK_CONTRACT,
};

test("runAgentStep: claude (cloud) extracts structured_output, sends --json-schema, and names its artifact envelope.json", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock-claude", {
      type: "claude",
      provider: "cloud",
      command: "claude",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => {
      assert.ok(options.arguments?.includes("--json-schema"));
      writeCapture(options.standardOutputPath, JSON.stringify(CLAUDE_ENVELOPE));
      return successResult(options);
    });
    const result = await runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory }));

    assert.equal(result.status, "succeeded");
    assert.equal(objectiveOf(result.output), VALID_TASK_CONTRACT.objective);
    assert.equal(result.artifacts.events, join(artifactDirectory, "envelope.json"));
    assert.ok(existsSync(result.artifacts.events));
  });
});

test("runAgentStep: claude (ollama, contextTokens set) derives a context model first, then invokes claude with --model hdo-ctx-...", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("implement", "mock-ollama", {
      type: "claude",
      provider: "ollama",
      command: "claude",
      model: "qwen3.8:27b-q4_K_M",
      contextTokens: 65536,
      sandbox: "workspace-write",
      timeoutSeconds: 60,
      passEnvironment: [],
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => {
      if (options.command === "ollama") {
        assert.deepEqual(options.arguments?.slice(0, 2), ["create", "hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536"]);
        return successResult(options);
      }
      assert.equal(options.command, "claude");
      const modelIndex = options.arguments?.indexOf("--model");
      assert.ok(modelIndex !== undefined && modelIndex >= 0);
      assert.equal(options.arguments?.[modelIndex! + 1], "hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536");
      assert.ok(!options.arguments?.includes("--json-schema"));
      writeCapture(options.standardOutputPath, JSON.stringify(CLAUDE_ENVELOPE));
      return successResult(options);
    });
    const result = await runAgentStep(
      makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory, step: "implement" }),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(runner.calls.length, 2);
    assert.equal(runner.calls[0].command, "ollama");
    assert.equal(runner.calls[1].command, "claude");
    assert.equal(objectiveOf(result.output), VALID_TASK_CONTRACT.objective);
  });
});

test("runAgentStep: claude failure surfaces the envelope root cause before secondary stderr, and preserves envelope.json", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock-claude-failure", {
      type: "claude",
      provider: "cloud",
      command: "claude",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      extraArgs: [],
    });
    const failureEnvelope = {
      is_error: true,
      terminal_reason: "api_error",
      result: "API Error: response exceeded the output token maximum.",
      permission_denials: [{ tool_name: "Bash" }],
    };
    const runner = new FakeProcessRunner((options) => {
      writeCapture(options.standardOutputPath, JSON.stringify(failureEnvelope));
      const stderr = "[claude-code:unrecognized_model] local-model\n";
      writeCapture(options.standardErrorPath, stderr);
      return successResult(options, { exitCode: 1, stderr });
    });
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /API Error: response exceeded the output token maximum\..*terminal_reason: api_error.*stderr: \[claude-code:unrecognized_model\]/s,
    );
    assert.ok(existsSync(join(artifactDirectory, "envelope.json")));
  });
});

test("runAgentStep: a timed-out process reports 'timed_out' with the process's own stderr", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 1,
      passEnvironment: [],
      promptTransport: "stdin",
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => {
      const stderr = "the process did not exit in time";
      writeCapture(options.standardErrorPath, stderr);
      return successResult(options, { exitCode: 124, timedOut: true, stderr });
    });
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Agent step 'plan' timed_out with exit code 124\. the process did not exit in time$/,
    );
  });
});

test("runAgentStep: exit-zero output that fails the output schema is rejected", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "stdin",
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => {
      writeCapture(options.standardOutputPath, "{}");
      return successResult(options);
    });
    await assert.rejects(
      () => runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory })),
      /^Error: Agent step 'plan' produced invalid structured output: Schema validation failed: /,
    );
  });
});

test("runAgentStep: a credential-shaped string inside the structured output is redacted in both the returned object and final.json", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "stdin",
      extraArgs: [],
    });
    const contract = { ...VALID_TASK_CONTRACT, objective: "Fix password=supersecretvalue123 in config." };
    const runner = new FakeProcessRunner((options) => {
      writeCapture(options.standardOutputPath, JSON.stringify(contract));
      return successResult(options);
    });
    const result = await runAgentStep(makeOptions({ config, processRunner: runner, workingDirectory, artifactDirectory }));

    assert.ok(String(objectiveOf(result.output)).includes("[REDACTED]"));
    assert.ok(!String(objectiveOf(result.output)).includes("supersecretvalue123"));
    const onDisk = JSON.parse(readFileSync(result.artifacts.final, "utf8"));
    assert.ok(onDisk.objective.includes("[REDACTED]"));
    assert.ok(!onDisk.objective.includes("supersecretvalue123"));
  });
});

test("runAgentStep: agent.progress carries the run ID through started/heartbeat, and onActivity is cleared to null when the step completes", async () => {
  await withTempDirs(async ({ workingDirectory, artifactDirectory }) => {
    const config = buildConfig("plan", "mock", {
      type: "command",
      command: "mock",
      sandbox: "read-only",
      timeoutSeconds: 30,
      passEnvironment: [],
      promptTransport: "stdin",
      extraArgs: [],
    });
    const runner = new FakeProcessRunner((options) => {
      // Simulate one process-level heartbeat tick before the process finishes.
      options.activityCallback?.({ type: "process.heartbeat", at: "2026-01-01T00:00:01.000Z", startedAt: "2026-01-01T00:00:00.000Z", elapsedSeconds: 1 });
      writeCapture(options.standardOutputPath, JSON.stringify(VALID_TASK_CONTRACT));
      return successResult(options);
    });
    const events: JsonObject[] = [];
    // Snapshot synchronously: `onActivity` receives the SAME mutable object on every
    // call (mirroring PowerShell mutating a single `$Run['activity']` hashtable in
    // place), so a caller that wants per-call history must clone at call time.
    const activitySnapshots: (JsonObject | null)[] = [];
    const result = await runAgentStep(
      makeOptions({
        config,
        processRunner: runner,
        workingDirectory,
        artifactDirectory,
        activityCallback: (event) => {
          events.push(event);
        },
        onActivity: (activity) => {
          activitySnapshots.push(activity === null ? null : (JSON.parse(JSON.stringify(activity)) as JsonObject));
        },
      }),
    );

    assert.equal(result.status, "succeeded");
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "agent.progress");
    assert.equal(events[0].phase, "started");
    assert.equal(events[0].runId, "test-run");
    assert.ok(events.some((event) => event.phase === "heartbeat"));
    assert.equal(activitySnapshots.at(-1), null);
    assert.ok(activitySnapshots.length >= 2, "expected at least a started snapshot and the final null clear");
    assert.equal(activitySnapshots[0]?.kind, "agent");
  });
});
