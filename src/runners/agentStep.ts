// Host port of `Invoke-HdoAgentStep` (Runner.ps1:530-760): resolves which runner a
// step's binding names, builds that runner's CLI invocation, executes it through an
// injected `ProcessRunner`, and validates/redacts the resulting structured output.
// This is the ADR-0001 phase 5 "top" host adapter: every pure decision it needs
// (step-binding resolution, argument-template expansion, transport-schema
// derivation, per-CLI argv/stdin construction, runner environment, failure-detail
// extraction, Claude envelope extraction, Ollama recovery) is a `src/core/runners/**`
// function; this module owns only the impure orchestration - artifact directory
// creation, file reads/writes, process execution, and progress plumbing.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import type { SchemaName, SchemaRegistry } from "../core/contracts/schemas.ts";
import { getValue } from "../core/config/value.ts";
import { protectObject, protectText } from "../core/process/redact.ts";
import {
  DEFAULT_MAXIMUM_OUTPUT_BYTES,
  type ProcessHeartbeatEvent,
  type ProcessResult,
  type ProcessRunner,
} from "../core/process/types.ts";
import { getStepBinding } from "../core/runners/stepBinding.ts";
import { expandArgumentTemplate } from "../core/runners/argumentTemplate.ts";
import { toClaudeTransportSchemaJson } from "../core/runners/claudeSchema.ts";
import { toCodexTransportSchemaJson } from "../core/runners/codexSchema.ts";
import { getClaudeArguments, getClaudeInputText } from "../core/runners/claudeArguments.ts";
import { getCodexArguments } from "../core/runners/codexArguments.ts";
import { getRunnerEnvironment } from "../core/runners/runnerEnvironment.ts";
import { getClaudeFailureDetail, getCodexFailureDetail } from "../core/runners/failureDetail.ts";
import { extractClaudeOutput } from "../core/runners/claudeOutput.ts";
import { asNumber, asString, equalsIgnoreCase, hdoArrayItems, isTruthy } from "../core/runners/psSemantics.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { isRegularFile, protectLogFile, readBoundedTextFile, writeJsonFile, writeTextFile } from "./artifacts.ts";
import { resolveOllamaContextModel } from "./ollamaContextModel.ts";
import { resolveOllamaStructuredOutputArtifacts, validateJsonAgainstSchema } from "./ollamaStructuredOutput.ts";

export type AgentStepName = "plan" | "implement" | "review" | "fix";

/** The subset of the persistent Run record this function reads (Runner.ps1:572, 616, 620, 636). */
export interface AgentStepRun {
  id: string;
  state: string;
  artifactPath?: string;
}

export interface AgentStepOptions {
  /** Resolved configuration (steps/runners). */
  config: JsonObject;
  run: AgentStepRun;
  step: AgentStepName;
  iteration: number;
  workingDirectory: string;
  prompt: string;
  artifactDirectory: string;
  outputSchema: SchemaName;
  schemas: SchemaRegistry;
  /** Directory holding the canonical schema files - only used for the `{schemaFile}` token and the "not found" message text (Resolve-HdoSchemaPath, Runner.ps1:21-22); this function never reads schema files itself. */
  schemasDir: string;
  /** `{hdoRoot}` command-runner token (Runner.ps1:577). */
  hdoRoot: string;
  platform: PlatformAdapter;
  processRunner: ProcessRunner;
  /** Defaults to `process.env`, matching `Get-HdoRunnerEnvironment`'s ambient default. */
  ambientEnvironment?: Record<string, string | undefined>;
  /** `agent.progress` events (Runner.ps1:632-643, 657-668). Errors thrown by this callback are swallowed, mirroring `Invoke-HdoProgressAction`. */
  activityCallback?: (event: JsonObject) => unknown;
  /** `Run.activity` set (Runner.ps1:618-628), heartbeat updates (:652-653), cleared in `finally` (:677). Phase 6 is expected to persist `run.json` from here; this function never touches the filesystem for it. */
  onActivity?: (activity: JsonObject | null) => void;
  /** Default 30, range 1..3600 (Runner.ps1:541). */
  progressIntervalSeconds?: number;
}

export interface AgentStepResult {
  status: "succeeded";
  step: AgentStepName;
  iteration: number;
  runner: string;
  requested: {
    provider: string;
    model: JsonValue | null;
    reasoningEffort: JsonValue | null;
    contextTokens: JsonValue | null;
    sandbox: JsonValue | null;
  };
  process: {
    exitCode: number;
    timedOut: boolean;
    outputLimitExceeded: boolean;
    maximumOutputBytes: number;
    stdoutBytes: number;
    stderrBytes: number;
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
  artifacts: {
    prompt: string;
    events: string;
    stdout: string;
    stderr: string;
    final: string;
  };
  output: JsonValue;
}

/** Mirrors PowerShell's `[ValidateRange(1, 3600)]` on `Invoke-HdoAgentStep`'s own `-ProgressIntervalSeconds` parameter. */
function validateProgressIntervalSeconds(value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > 3600) {
    throw new RangeError(`progressIntervalSeconds must be between 1 and 3600 (got ${value}).`);
  }
}

export async function runAgentStep(options: AgentStepOptions): Promise<AgentStepResult> {
  const { config, run, step, iteration, prompt, artifactDirectory, outputSchema, schemas, schemasDir, hdoRoot, platform, processRunner } =
    options;
  const activityCallback = options.activityCallback;
  const onActivity = options.onActivity;
  const progressIntervalSeconds = options.progressIntervalSeconds ?? 30;
  validateProgressIntervalSeconds(progressIntervalSeconds);

  // Oracle: Runner.ps1:544-546.
  const binding = getStepBinding(config, step);
  if (!binding.enabled) throw new Error(`Step '${step}' is disabled.`);
  const runner = binding.runner;
  const runnerObject: JsonObject = runner ?? {};

  // Oracle: Runner.ps1:547, `$type = [string]$runner.type` (a direct property read,
  // not `Get-HdoValue`); comparisons are case-insensitive (ADR-0001 phase 5 plan §7
  // risk 1) but the "Unsupported runner type" message below uses the ORIGINAL casing,
  // so `rawType` (not lower-cased) is what gets embedded in that throw text.
  const rawType = asString(runner?.type);
  const type = rawType.toLowerCase();

  // Oracle: Runner.ps1:547, `$type = [string]$runner.type` throws (PS strict mode)
  // BEFORE `New-Item` ever runs, but ONLY when `runner` itself is `$null` (or a
  // PSCustomObject lacking a `type` property at all) - that is the `rawType === ""`
  // case here (review round 1 deep-review N-6: no artifact directory, no
  // `prompt.md`, for that throw). For a non-empty but UNRECOGNIZED type (e.g.
  // `"Gemini"`), `[string]$runner.type` at :547 resolves fine, and PS goes on to
  // create the artifact directory, resolve the schema path, and write `prompt.md`
  // (:549-558) before finally reaching the `else { throw "Unsupported runner type
  // '$type'." }` at the end of the type dispatch (:610-611) - see the matching
  // `else` branch below, after the codex/claude/command dispatch, which is where
  // that second throw is now reproduced (review round 2 should-fix 1: an earlier fix
  // over-corrected this by moving BOTH cases here, which regressed the non-empty
  // case's artifact-side-effect parity).
  if (rawType === "") {
    throw new Error(`Unsupported runner type '${rawType}'.`);
  }

  // Oracle: Runner.ps1:548-549.
  const agentWorkingDirectory = platform.comparableFullPath(options.workingDirectory);
  mkdirSync(artifactDirectory, { recursive: true });

  // Oracle: Runner.ps1:550-556. Codex emits a JSONL event stream on stdout; Claude's
  // `--output-format json` emits a single envelope object, so the copied artifact is
  // named for what it actually is.
  const promptPath = join(artifactDirectory, "prompt.md");
  const eventsPath = join(artifactDirectory, type === "claude" ? "envelope.json" : "events.jsonl");
  const stdoutPath = join(artifactDirectory, "stdout.log");
  const stderrPath = join(artifactDirectory, "stderr.log");
  const finalPath = join(artifactDirectory, "final.json");

  // Oracle: Runner.ps1:21-22, 557, `Resolve-HdoSchemaPath`.
  const schemaPath = join(schemasDir, `${outputSchema}.schema.json`);
  if (!isRegularFile(schemaPath)) throw new Error(`Output schema was not found: ${schemaPath}`);

  // Oracle: Runner.ps1:558. PS `Set-Content` appends `[Environment]::NewLine` (CRLF on
  // Windows); this writes a single trailing LF instead (ADR-0001 phase 5 plan §7 risk 10).
  writeTextFile(promptPath, `${protectText(prompt)}\n`);

  // Oracle: Runner.ps1:563-578, insertion order matters (`Expand-HdoArgumentTemplate`
  // iterates `Tokens.Keys` in order).
  const tokens: Record<string, unknown> = {
    promptFile: promptPath,
    outputFile: finalPath,
    schemaFile: schemaPath,
    workingDirectory: agentWorkingDirectory,
    model: asString(getValue(runnerObject, "model", "")),
    contextTokens: asString(getValue(runnerObject, "contextTokens", "")),
    step,
    iteration,
    runId: asString(run.id),
    hdoRoot,
  };

  let args: string[] = [];
  // Oracle: Runner.ps1:562, `$inputText = $Prompt` - the default for every runner type
  // that never reassigns it (codex keeps this; command keeps it unless the transport
  // is `file`).
  let inputText: string | undefined = prompt;
  // Only meaningful once `type === 'claude'`; read again after the process succeeds
  // (Runner.ps1:711) to decide whether to run the Ollama recovery step.
  let claudeProvider = "cloud";

  // A future in-process runner (Issue #48) would plug in here, alongside the
  // codex/claude/command branches below, and would receive the exact same
  // validation/redaction/artifact handling the rest of this function already provides.
  if (type === "codex") {
    // Oracle: Runner.ps1:580-585.
    const codexSchemaPath = join(artifactDirectory, "output.schema.json");
    writeTextFile(codexSchemaPath, `${toCodexTransportSchemaJson(schemas.getDocument(outputSchema))}\n`);
    args = getCodexArguments(runnerObject, agentWorkingDirectory, codexSchemaPath, finalPath);
  } else if (type === "claude") {
    // Oracle: Runner.ps1:586-600.
    const claudeSchemaJson = toClaudeTransportSchemaJson(schemas.getDocument(outputSchema));
    let claudeModelOverride: string | null = null;
    claudeProvider = asString(getValue(runnerObject, "provider", "cloud"), "cloud");
    if (equalsIgnoreCase(claudeProvider, "ollama") && isTruthy(getValue(runnerObject, "contextTokens"))) {
      // Oracle: Runner.ps1:591-597. `ollama create` only writes a model manifest (it
      // does not duplicate or reload weights), so it is bounded independently of the
      // runner's own `timeoutSeconds` instead of consuming the full step budget on
      // top of the Claude process that follows it.
      const contextModelTimeoutSeconds = Math.min(300, Math.trunc(asNumber(runnerObject.timeoutSeconds, 0)));
      claudeModelOverride = await resolveOllamaContextModel({
        runner: processRunner,
        model: asString(runnerObject.model),
        contextTokens: Math.trunc(asNumber(runnerObject.contextTokens, 0)),
        workingDirectory: agentWorkingDirectory,
        timeoutSeconds: contextModelTimeoutSeconds,
        ambientEnvironment: options.ambientEnvironment,
      });
    }
    args = getClaudeArguments(runnerObject, claudeSchemaJson, claudeModelOverride);
    inputText = getClaudeInputText(runnerObject, prompt, claudeSchemaJson);
  } else if (type === "command") {
    // Oracle: Runner.ps1:602-608.
    for (const argument of hdoArrayItems(getValue(runnerObject, "extraArgs", []))) {
      args.push(expandArgumentTemplate(asString(argument), tokens));
    }
    const transport = asString(getValue(runnerObject, "promptTransport", "stdin"), "stdin");
    if (equalsIgnoreCase(transport, "file")) {
      inputText = undefined;
    } else if (!equalsIgnoreCase(transport, "stdin")) {
      throw new Error(`Unsupported command promptTransport '${transport}'.`);
    }
  } else {
    // Oracle: Runner.ps1:610-611, `else { throw "Unsupported runner type '$type'." }`
    // - reached for a non-empty but unrecognized `rawType` (e.g. `"Gemini"`), AFTER
    // the artifact directory was created and `prompt.md` was written above, matching
    // PS exactly (review round 2 should-fix 1).
    throw new Error(`Unsupported runner type '${rawType}'.`);
  }

  // Oracle: Runner.ps1:614-615.
  const environment = getRunnerEnvironment(runnerObject, options.ambientEnvironment ?? process.env);
  const maximumOutputBytes = DEFAULT_MAXIMUM_OUTPUT_BYTES;

  // Oracle: Runner.ps1:616-643.
  const activityArtifactPath = run.artifactPath ?? "";
  const activityStartedAt = new Date().toISOString();
  const activity: JsonObject = {
    kind: "agent",
    state: run.state,
    step,
    iteration,
    runner: binding.runnerName,
    provider: asString(getValue(runnerObject, "provider", "cloud"), "cloud"),
    startedAt: activityStartedAt,
    lastHeartbeatAt: activityStartedAt,
    elapsedSeconds: 0,
  };
  onActivity?.(activity);

  // Oracle: Common.ps1:730-742, `Invoke-HdoProgressAction` - a no-op when no callback
  // is registered; otherwise redacts the event and swallows anything the callback
  // itself throws or returns, since progress is an observability channel and a closed
  // parent stream must not turn a still-running process into a failed HDO run.
  const invokeActivityCallback = (event: JsonObject): void => {
    if (!activityCallback) return;
    try {
      activityCallback(protectObject(event) as JsonObject);
    } catch {
      // swallow
    }
  };

  invokeActivityCallback({
    type: "agent.progress",
    phase: "started",
    at: activityStartedAt,
    runId: run.id,
    state: run.state,
    step,
    iteration,
    runner: binding.runnerName,
    artifactPath: activityArtifactPath,
    elapsedSeconds: 0,
  });

  // Oracle: Runner.ps1:644-669. Kept as a distinct name from the outer
  // `activityCallback` so the process-level progress translation below can never be
  // confused with the caller's own agent-level callback.
  const processProgressAction = (processProgress: ProcessHeartbeatEvent): void => {
    const heartbeatAt = processProgress.at;
    const elapsedSeconds = processProgress.elapsedSeconds;
    activity.lastHeartbeatAt = heartbeatAt;
    activity.elapsedSeconds = elapsedSeconds;
    onActivity?.(activity);
    invokeActivityCallback({
      type: "agent.progress",
      phase: "heartbeat",
      at: heartbeatAt,
      runId: run.id,
      state: run.state,
      step,
      iteration,
      runner: binding.runnerName,
      artifactPath: activityArtifactPath,
      elapsedSeconds,
    });
  };

  let result: ProcessResult;
  try {
    // Oracle: Runner.ps1:670-674.
    result = await processRunner.run({
      command: asString(runner?.command),
      arguments: args,
      workingDirectory: agentWorkingDirectory,
      inputText,
      // A missing timeoutSeconds becomes 0 here and fails validateRange with a clear
      // message, where PS instead fails with a strict-mode "property cannot be found"
      // error; unreachable via a schema-valid config either way (review round 1
      // deep-review N-7).
      timeoutSeconds: Math.trunc(asNumber(runnerObject.timeoutSeconds, 0)),
      environment,
      standardOutputPath: stdoutPath,
      standardErrorPath: stderrPath,
      maximumOutputBytes,
      activityCallback: processProgressAction,
      progressIntervalSeconds,
    });
  } finally {
    // Oracle: Runner.ps1:676-680 - `Run.activity` is always cleared, whether the
    // process succeeded, failed, or threw.
    onActivity?.(null);
  }

  // Oracle: Runner.ps1:682-684.
  protectLogFile(stdoutPath, maximumOutputBytes);
  protectLogFile(stderrPath, maximumOutputBytes);
  copyFileSync(stdoutPath, eventsPath);

  if (result.exitCode !== 0) {
    // Oracle: Runner.ps1:686-696.
    const kind = result.timedOut ? "timed_out" : "failed";
    let failureDetail: string;
    if (type === "codex") {
      failureDetail = getCodexFailureDetail(result.stdout, result.stderr);
    } else if (type === "claude") {
      failureDetail = getClaudeFailureDetail(readBoundedTextFile(stdoutPath, maximumOutputBytes), result.stderr);
    } else {
      failureDetail = result.stderr.trim();
    }
    throw new Error(`Agent step '${step}' ${kind} with exit code ${result.exitCode}. ${failureDetail}`);
  }

  // Oracle: Runner.ps1:698-702. Codex and file-transport command adapters write this
  // file directly; redact it before parsing so even malformed/schema-invalid output
  // cannot persist secrets. `protectLogFile` is already a no-op when the file does not
  // exist (or is not a regular file), matching the PS `Test-Path` guard.
  protectLogFile(finalPath, maximumOutputBytes);

  let finalJson: string;
  if (type === "codex") {
    // Oracle: Runner.ps1:704-707.
    if (!isRegularFile(finalPath)) throw new Error(`Codex step '${step}' did not write its final output.`);
    finalJson = readBoundedTextFile(finalPath, maximumOutputBytes);
  } else if (type === "claude") {
    // Oracle: Runner.ps1:708-716.
    try {
      finalJson = extractClaudeOutput(readBoundedTextFile(stdoutPath, maximumOutputBytes));
    } catch (error) {
      throw new Error(`Claude step '${step}' returned invalid envelope JSON: ${(error as Error).message}`);
    }
    if (equalsIgnoreCase(claudeProvider, "ollama")) {
      finalJson = resolveOllamaStructuredOutputArtifacts({
        envelopeJson: readBoundedTextFile(stdoutPath, maximumOutputBytes),
        schemaValidator: schemas.get(outputSchema),
        artifactDirectory,
      });
    }
    // Trailing "\n" mirrors PS `Set-Content`'s appended newline (review round 1 finding
    // 12); only observable if schema validation below rejects this raw text and throws
    // before it is overwritten by the pretty-printed `writeJsonFile` call further down.
    writeTextFile(finalPath, `${finalJson}\n`);
  } else {
    // Oracle: Runner.ps1:717-720.
    if (isRegularFile(finalPath)) {
      finalJson = readBoundedTextFile(finalPath, maximumOutputBytes);
    } else {
      finalJson = readBoundedTextFile(stdoutPath, maximumOutputBytes);
      // Trailing "\n" mirrors PS `Set-Content`'s appended newline (review round 1
      // finding 12); same rationale as the Claude branch above.
      writeTextFile(finalPath, `${finalJson}\n`);
    }
  }

  // Oracle: Runner.ps1:722-723.
  const schemaValidation = validateJsonAgainstSchema(finalJson, schemas.get(outputSchema));
  if (!schemaValidation.valid) {
    throw new Error(`Agent step '${step}' produced invalid structured output: ${schemaValidation.error}`);
  }
  // Oracle: Runner.ps1:724.
  const structured = protectObject(JSON.parse(finalJson)) as JsonValue;
  // Oracle: Runner.ps1:725-726. `Test-HdoObjectSchema` round-trips `$structured`
  // through `ConvertTo-Json`/`Test-HdoJsonSchema` again; validating the already-parsed
  // object directly against the same compiled validator is equivalent (and the
  // "Invalid JSON" branch is unreachable here, since `structured` is our own
  // `JSON.parse` result, never re-serialized text).
  const redactedValidationErrors = schemas.get(outputSchema)(structured);
  if (!redactedValidationErrors.valid) {
    throw new Error(
      `Agent step '${step}' output became invalid after credential redaction: Schema validation failed: ${redactedValidationErrors.errors.join("; ")}`,
    );
  }
  // Oracle: Runner.ps1:727.
  writeJsonFile(finalPath, structured);

  // Oracle: Runner.ps1:728-759.
  return {
    status: "succeeded",
    step,
    iteration,
    runner: binding.runnerName ?? "",
    requested: {
      provider: asString(getValue(runnerObject, "provider", "cloud"), "cloud"),
      model: getValue(runnerObject, "model") ?? null,
      reasoningEffort: getValue(runnerObject, "reasoningEffort") ?? null,
      contextTokens: getValue(runnerObject, "contextTokens") ?? null,
      sandbox: runner?.sandbox ?? null,
    },
    process: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      maximumOutputBytes: result.maximumOutputBytes,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
    },
    artifacts: {
      prompt: promptPath,
      events: eventsPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      final: finalPath,
    },
    output: structured,
  };
}
