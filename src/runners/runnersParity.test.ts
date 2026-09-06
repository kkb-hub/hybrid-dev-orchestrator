// ADR-0001 phase 5, WP-H: single pwsh-oracle parity test for the core runner
// modules (`src/core/runners/**`). Unlike `src/process/processParity.test.ts` and
// `src/cli/configParity.test.ts` (which each spawn one pwsh process per test case),
// this file batches EVERY case into ONE JSON spec, runs ONE pwsh process against
// `src/HybridDevOrchestrator/Private/Runner.ps1`'s private functions (via the same
// `Import-Module` + `& $module { ... }` session-state trick those files use), and
// computes the TypeScript side by calling the pure, importable `src/core/runners/*`
// functions directly in this same process (no subprocess needed for the TS side -
// these are pure functions, not host/CLI behaviour).
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH. The oracle batch
// itself runs once at module load (not inside a test), so a harness-level failure
// (pwsh crash, bad script) throws immediately at import time with a clear message
// instead of failing every individual case identically.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { IssueContract, JsonObject, JsonValue, ProjectContract } from "../core/contracts/types.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { compileSchema } from "../core/contracts/validate.ts";
import { getClaudeArguments, getClaudeInputText } from "../core/runners/claudeArguments.ts";
import {
  extractClaudeOutput,
  ollamaRecoveryRejectedMessage,
  recoverOllamaStructuredOutput,
  type JsonValidationResult,
  type OllamaRecoveryDiagnostic,
} from "../core/runners/claudeOutput.ts";
import { toClaudeTransportSchema, toClaudeTransportSchemaJson } from "../core/runners/claudeSchema.ts";
import { getCodexArguments } from "../core/runners/codexArguments.ts";
import { toCodexTransportSchema, toCodexTransportSchemaJson } from "../core/runners/codexSchema.ts";
import { getClaudeFailureDetail, getCodexFailureDetail } from "../core/runners/failureDetail.ts";
import { buildFixPrompt, buildImplementationPrompt, buildPlanPrompt, buildReviewPrompt, type PromptDiff } from "../core/runners/prompts.ts";
import { getRunnerEnvironment } from "../core/runners/runnerEnvironment.ts";
import { testReviewResult } from "../core/runners/reviewResult.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas");
const RUNTIME_FIXTURES_DIR = resolve(REPO_ROOT, "tests", "fixtures", "runtime");
const SCHEMA_FIXTURES_DIR = resolve(REPO_ROOT, "tests", "fixtures", "schema");

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

// ---------------------------------------------------------------------------
// Fixture / config loading helpers
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadRuntimeFixtureText(name: string): string {
  return readFileSync(resolve(RUNTIME_FIXTURES_DIR, name), "utf8");
}

function loadSchema(name: string): SchemaObject {
  return readJsonFile(resolve(SCHEMAS_DIR, `${name}.schema.json`)) as SchemaObject;
}

interface ConfigFileShape {
  runners?: Record<string, JsonObject>;
}

function loadConfigRunners(relativePath: string): Record<string, JsonObject> {
  const parsed = readJsonFile(resolve(REPO_ROOT, relativePath)) as ConfigFileShape;
  return parsed.runners ?? {};
}

function loadIssueContract(): IssueContract {
  return readJsonFile(resolve(SCHEMA_FIXTURES_DIR, "issue.valid.json")) as IssueContract;
}

function loadTaskContract(): JsonValue {
  return readJsonFile(resolve(SCHEMA_FIXTURES_DIR, "task.valid.json")) as JsonValue;
}

function loadProjectContract(): ProjectContract {
  return readJsonFile(resolve(REPO_ROOT, ".hdo", "project.json")) as ProjectContract;
}

function loadReviewValid(): JsonObject {
  return readJsonFile(resolve(SCHEMA_FIXTURES_DIR, "review.valid.json")) as JsonObject;
}

function loadReviewInvalid(name: string): JsonObject {
  return readJsonFile(resolve(SCHEMA_FIXTURES_DIR, name)) as JsonObject;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Case model - one flexible shape covers every kind; each kind only reads the
// fields it needs. `label` doubles as the node:test test name.
// ---------------------------------------------------------------------------

interface Case {
  kind: string;
  label: string;
  runner?: JsonObject;
  schemaJson?: string;
  modelOverride?: string;
  workingDirectory?: string;
  schemaPath?: string;
  finalPath?: string;
  prompt?: string;
  schemaName?: string;
  expectThrow?: boolean;
  stdout?: string;
  stderr?: string;
  envelopeJson?: string;
  review?: JsonObject;
  previous?: JsonObject | null;
  expectedRound?: number;
  runId?: string;
  baseCommit?: string;
  diffHash?: string;
  promptKind?: "plan" | "implementation" | "fix" | "review";
  issueContract?: IssueContract;
  projectContract?: ProjectContract;
  taskContract?: JsonValue;
  validation?: JsonValue;
  diff?: PromptDiff;
  previousReview?: JsonObject | null;
  round?: number;
  iteration?: number;
}

// ---------------------------------------------------------------------------
// (a) claude-arguments / codex-arguments / claude-input / runner-environment -
// every runner of config/hdo.default.json and the 4 config/examples/*.json files,
// derived dynamically (so the case list tracks the real config, not a hand-copy),
// plus the ad-hoc dicts from tests/run-tests.ps1.
// ---------------------------------------------------------------------------

const CONFIG_FILES = [
  "config/hdo.default.json",
  "config/examples/cloud-only.json",
  "config/examples/ollama-hybrid.json",
  "config/examples/claude-only.json",
  "config/examples/ollama-lean-worker.json",
];

const FIXED_CLAUDE_SCHEMA_JSON = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
});
const FIXED_PROMPT_TEXT = "work";
const FIXED_CODEX_WORKDIR = "C:\\worktree";
const FIXED_CODEX_SCHEMA_PATH = "C:\\artifacts\\schema.json";
const FIXED_CODEX_FINAL_PATH = "C:\\artifacts\\final.json";

const configDerivedCases: Case[] = [];
for (const configFile of CONFIG_FILES) {
  const runners = loadConfigRunners(configFile);
  for (const [runnerName, runner] of Object.entries(runners)) {
    const label = `${configFile}#${runnerName}`;
    const type = String(runner.type ?? "");
    if (type === "claude") {
      configDerivedCases.push({ kind: "claude-arguments", label: `claude-arguments: ${label}`, runner, schemaJson: FIXED_CLAUDE_SCHEMA_JSON });
      configDerivedCases.push({ kind: "claude-input", label: `claude-input: ${label}`, runner, prompt: FIXED_PROMPT_TEXT, schemaJson: FIXED_CLAUDE_SCHEMA_JSON });
      configDerivedCases.push({ kind: "runner-environment", label: `runner-environment: ${label}`, runner });
    } else if (type === "codex") {
      configDerivedCases.push({
        kind: "codex-arguments",
        label: `codex-arguments: ${label}`,
        runner,
        workingDirectory: FIXED_CODEX_WORKDIR,
        schemaPath: FIXED_CODEX_SCHEMA_PATH,
        finalPath: FIXED_CODEX_FINAL_PATH,
      });
      configDerivedCases.push({ kind: "runner-environment", label: `runner-environment: ${label}`, runner });
    } else if (type === "command") {
      configDerivedCases.push({ kind: "runner-environment", label: `runner-environment: ${label}`, runner });
    }
  }
}

// Oracle: tests/run-tests.ps1 ad-hoc runner dicts (claudeWriteArguments,
// ollamaClaudeArguments, ollamaReadOnlyArguments, modelOverrideArguments,
// claudeReadArguments).
const claudeArgumentsAdHocCases: Case[] = [
  {
    kind: "claude-arguments",
    label: "claude-arguments: workspace-write + HIGH effort + allowedTools (run-tests ad hoc)",
    runner: { sandbox: "workspace-write", model: "opus", reasoningEffort: "HIGH", allowedTools: ["Read", "Bash"], extraArgs: [] },
    schemaJson: "{}",
  },
  {
    kind: "claude-arguments",
    label: "claude-arguments: claude/ollama workspace-write (run-tests ad hoc)",
    runner: { sandbox: "workspace-write", type: "claude", provider: "ollama", model: "qwen3.8:27b-q4_K_M", reasoningEffort: "medium", extraArgs: [] },
    schemaJson: '{"type":"object"}',
  },
  {
    kind: "claude-arguments",
    label: "claude-arguments: claude/ollama read-only (run-tests ad hoc)",
    runner: { sandbox: "read-only", type: "claude", provider: "ollama", model: "qwen3.8:27b-q4_K_M", extraArgs: [] },
    schemaJson: '{"type":"object"}',
  },
  {
    kind: "claude-arguments",
    label: "claude-arguments: modelOverride wins over configured model (run-tests ad hoc)",
    runner: { sandbox: "workspace-write", type: "claude", provider: "ollama", model: "qwen3.8:27b-q4_K_M", extraArgs: [] },
    schemaJson: '{"type":"object"}',
    modelOverride: "hdo-ctx-fixed-override-model-65536",
  },
  {
    kind: "claude-arguments",
    label: "claude-arguments: read-only never forwards extraArgs (run-tests ad hoc)",
    runner: { sandbox: "read-only", extraArgs: ["--injected-extra-argument"] },
    schemaJson: "{}",
  },
];

const claudeInputAdHocCases: Case[] = [
  { kind: "claude-input", label: "claude-input: ollama embeds local-worker constraints + schema (run-tests ad hoc)", runner: { provider: "ollama" }, prompt: "work", schemaJson: '{"type":"object"}' },
  { kind: "claude-input", label: "claude-input: cloud returns prompt unchanged", runner: { provider: "cloud" }, prompt: "work", schemaJson: '{"type":"object"}' },
];

// Oracle: tests/run-tests.ps1 ad-hoc codexArgumentRunner dict.
const codexArgumentsAdHocCases: Case[] = [
  {
    kind: "codex-arguments",
    label: "codex-arguments: ollama + effort + contextTokens (run-tests ad hoc)",
    runner: { sandbox: "workspace-write", provider: "ollama", model: "local-model", reasoningEffort: "medium", contextTokens: 32768, extraArgs: [] },
    workingDirectory: FIXED_CODEX_WORKDIR,
    schemaPath: FIXED_CODEX_SCHEMA_PATH,
    finalPath: FIXED_CODEX_FINAL_PATH,
  },
  {
    kind: "codex-arguments",
    label: "codex-arguments: lmstudio provider + extraArgs passthrough, no model/effort/contextTokens",
    runner: { sandbox: "read-only", provider: "lmstudio", extraArgs: ["--foo", "bar"] },
    workingDirectory: FIXED_CODEX_WORKDIR,
    schemaPath: FIXED_CODEX_SCHEMA_PATH,
    finalPath: FIXED_CODEX_FINAL_PATH,
  },
];

// Oracle: tests/run-tests.ps1 ollamaClaudeEnvironment/ollamaClaudeContextEnvironment/
// inheritedContextEnvironment/cloudInheritedEnvironment ad-hoc dicts. The ambient
// (HDO_PARITY_PASSTHROUGH=1, HDO_PARITY_TOKEN=x, CLAUDE_CODE_MAX_CONTEXT_TOKENS=4096)
// is fixed for the WHOLE batch (see AMBIENT_ENV below), so every runner-environment
// case here only needs to vary `runner`.
const runnerEnvironmentAdHocCases: Case[] = [
  { kind: "runner-environment", label: "runner-environment: claude/cloud keeps inherited context window (ambient passthrough)", runner: { type: "claude", provider: "cloud", passEnvironment: [] } },
  { kind: "runner-environment", label: "runner-environment: claude/ollama strips inherited context window when unset", runner: { type: "claude", provider: "ollama", passEnvironment: [] } },
  { kind: "runner-environment", label: "runner-environment: claude/ollama contextTokens overrides inherited window", runner: { type: "claude", provider: "ollama", contextTokens: 65536, passEnvironment: [] } },
  { kind: "runner-environment", label: "runner-environment: claude/ollama allow-lists a TOKEN-suffixed passEnvironment entry", runner: { type: "claude", provider: "ollama", passEnvironment: ["HDO_PARITY_TOKEN"] } },
  { kind: "runner-environment", label: "runner-environment: command/ollama (lean worker shape) gets no Claude/Ollama vars", runner: { type: "command", provider: "ollama", passEnvironment: [] } },
  { kind: "runner-environment", label: "runner-environment: codex/cloud (type guard sanity)", runner: { type: "codex", provider: "cloud", passEnvironment: [] } },
];

// ---------------------------------------------------------------------------
// (b) Schema conversion - task-contract/worker-result/review-result (the three
// schemas adapters actually transport) plus issue-contract and project-contract.
// Empirically verified (not the plan draft's guess) which one pins the Codex
// throw: `toCodexTransportSchemaJson` on project-contract.schema.json throws
// because $defs.validationGate declares `description`/`workingDirectory` as
// optional properties; issue-contract.schema.json has no optional object
// properties anywhere and converts cleanly for Codex too.
// ---------------------------------------------------------------------------

const CLAUDE_SCHEMA_NAMES = ["task-contract", "worker-result", "review-result", "issue-contract", "project-contract"];
const claudeSchemaCases: Case[] = CLAUDE_SCHEMA_NAMES.map((name) => ({
  kind: "claude-schema",
  label: `claude-schema: ${name}`,
  schemaName: name,
  expectThrow: false,
}));

const codexSchemaCases: Case[] = [
  { kind: "codex-schema", label: "codex-schema: task-contract", schemaName: "task-contract", expectThrow: false },
  { kind: "codex-schema", label: "codex-schema: worker-result", schemaName: "worker-result", expectThrow: false },
  { kind: "codex-schema", label: "codex-schema: review-result", schemaName: "review-result", expectThrow: false },
  { kind: "codex-schema", label: "codex-schema: issue-contract (no optional object properties - succeeds)", schemaName: "issue-contract", expectThrow: false },
  { kind: "codex-schema", label: "codex-schema: project-contract (validationGate optional properties - throws)", schemaName: "project-contract", expectThrow: true },
];

// ---------------------------------------------------------------------------
// (f) codex-failure / claude-failure - Oracle: tests/run-tests.ps1 (Codex/Claude
// failure-detail ad-hoc fixtures, including the Ollama context-overflow hint).
// ---------------------------------------------------------------------------

const CODEX_FAILURE_JSONL = [
  `{"type":"thread.started","thread_id":"test"}`,
  `{"type":"error","message":"{\\"error\\":{\\"code\\":\\"invalid_json_schema\\",\\"message\\":\\"Invalid schema for response_format: schema must have a type key.\\"},\\"status\\":400}"}`,
  `{"type":"turn.failed","error":{"message":"{\\"error\\":{\\"code\\":\\"invalid_json_schema\\",\\"message\\":\\"Invalid schema for response_format: schema must have a type key.\\"},\\"status\\":400}"}}`,
].join("\n");

const codexFailureCases: Case[] = [
  { kind: "codex-failure", label: "codex-failure: de-duplicated JSONL error over unrelated stderr", stdout: CODEX_FAILURE_JSONL, stderr: "unrelated warning on stderr" },
  {
    kind: "codex-failure",
    label: "codex-failure: tool-router root cause preserved over downstream stream error",
    stdout: '{"type":"turn.failed","error":{"message":"stream disconnected before completion: no user query found in messages"}}',
    stderr: "2026-09-03 ERROR codex_core::tools::router: error=unsupported call: bash",
  },
  { kind: "codex-failure", label: "codex-failure: falls back to stderr when no JSONL error event exists", stdout: "", stderr: "plain stderr failure" },
  {
    kind: "codex-failure",
    label: "codex-failure: Ollama context-overflow diagnosis",
    stdout: '{"type":"turn.failed","error":{"message":"no user query found in messages"}}',
    stderr: "",
  },
];

const CLAUDE_FAILURE_ENVELOPE_TWO_DENIALS =
  '{"is_error":true,"terminal_reason":"api_error","result":"API Error: response exceeded the output token maximum.","permission_denials":[{"tool_name":"Bash"},{"tool_name":"Bash"}]}';

const claudeFailureCases: Case[] = [
  {
    kind: "claude-failure",
    label: "claude-failure: result envelope root cause over misleading stderr, terminal_reason + permission denials retained",
    stdout: CLAUDE_FAILURE_ENVELOPE_TWO_DENIALS,
    stderr: "[claude-code:unrecognized_model] local-model",
  },
  {
    kind: "claude-failure",
    label: "claude-failure: real fixture claude-failure-envelope.json (single permission denial)",
    stdout: loadRuntimeFixtureText("claude-failure-envelope.json"),
    stderr: "",
  },
  { kind: "claude-failure", label: "claude-failure: falls back to stderr when no envelope is available", stdout: "", stderr: "plain stderr failure" },
  {
    kind: "claude-failure",
    label: "claude-failure: Ollama context-overflow diagnosis survives truncation of a long detail",
    stdout: `{"is_error":true,"terminal_reason":"api_error","result":"${"x".repeat(5000)} API Error: 500 no user query found in messages."}`,
    stderr: "",
  },
];

// ---------------------------------------------------------------------------
// claude-output - ConvertFrom-HdoClaudeOutput / extractClaudeOutput.
// ---------------------------------------------------------------------------

const claudeOutputCases: Case[] = [
  { kind: "claude-output", label: "claude-output: string result returned as-is", envelopeJson: '{"type":"result","result":"plain text"}' },
  { kind: "claude-output", label: "claude-output: structured_output preferred over result", envelopeJson: '{"type":"result","result":"ignored","structured_output":{"schemaVersion":1}}' },
  { kind: "claude-output", label: "claude-output: explicit null result serializes to the text 'null'", envelopeJson: '{"type":"result","result":null}' },
  { kind: "claude-output", label: "claude-output: neither structured_output nor result returns the compact envelope", envelopeJson: '{"type":"result","subtype":"success"}' },
  { kind: "claude-output", label: "claude-output: real fixture claude-envelope.json (structured_output object)", envelopeJson: loadRuntimeFixtureText("claude-envelope.json") },
];

// ---------------------------------------------------------------------------
// ollama-recovery - the 4 real Ollama prose fixtures (expect a recovered
// candidate) plus 3 negative variants derived from one of them (expect a
// rejected recovery), plus 2 envelope-failure variants that throw before any
// recovery attempt (is_error / non-success subtype).
// ---------------------------------------------------------------------------

const workerResultSchema = loadSchema("worker-result");
function makeValidateJson(schema: SchemaObject): (json: string) => JsonValidationResult {
  const validate = compileSchema(schema);
  return (json: string): JsonValidationResult => {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch (error) {
      return { valid: false, error: `Invalid JSON: ${(error as Error).message}` };
    }
    const result = validate(data);
    if (result.valid) return { valid: true, error: null };
    return { valid: false, error: `Schema validation failed: ${result.errors.join("; ")}` };
  };
}
const validateWorkerResult = makeValidateJson(workerResultSchema);

const PROSE_FIXTURE_NAMES = ["claude-ollama-prose.json", "claude-ollama-inline-prose.json", "claude-ollama-list-prose.json", "claude-ollama-symbol-prose.json"];

const proseFixtureRaw = JSON.parse(loadRuntimeFixtureText("claude-ollama-prose.json")) as Record<string, unknown>;
const proseOutcomeForSeed = recoverOllamaStructuredOutput(JSON.stringify(proseFixtureRaw), validateWorkerResult);
if (proseOutcomeForSeed.kind !== "recovered") {
  throw new Error("test setup: claude-ollama-prose.json must recover to seed the negative-variant fixtures below");
}
const validWorkerResultJson = proseOutcomeForSeed.finalJson;

function withResult(bad: string): string {
  return JSON.stringify({ ...proseFixtureRaw, result: bad });
}

const ollamaRecoveryCases: Case[] = [
  ...PROSE_FIXTURE_NAMES.map((name) => ({
    kind: "ollama-recovery",
    label: `ollama-recovery: real prose fixture recovers - ${name}`,
    envelopeJson: loadRuntimeFixtureText(name),
    schemaName: "worker-result",
  })),
  { kind: "ollama-recovery", label: "ollama-recovery: negative variant - empty result", envelopeJson: withResult(""), schemaName: "worker-result" },
  { kind: "ollama-recovery", label: "ollama-recovery: negative variant - ambiguous prose then empty object", envelopeJson: withResult("Done.\n{}"), schemaName: "worker-result" },
  { kind: "ollama-recovery", label: "ollama-recovery: negative variant - fenced code block prefix", envelopeJson: withResult("```json\n" + validWorkerResultJson), schemaName: "worker-result" },
  {
    kind: "ollama-recovery",
    label: "ollama-recovery: is_error envelope throws before any recovery attempt",
    envelopeJson: JSON.stringify({ is_error: true, subtype: "success", result: "boom" }),
    schemaName: "worker-result",
  },
  {
    kind: "ollama-recovery",
    label: "ollama-recovery: non-success subtype throws before any recovery attempt",
    envelopeJson: JSON.stringify({ is_error: false, subtype: "error_max_turns", result: "boom" }),
    schemaName: "worker-result",
  },
];

// ---------------------------------------------------------------------------
// review-result - Test-HdoReviewResult / testReviewResult. Oracle:
// tests/run-tests.ps1 (missingFindingReview/carriedFindingReview/
// duplicateFindingReview mutations of review.valid.json) plus the 3 shipped
// invalid review fixtures.
// ---------------------------------------------------------------------------

const reviewValid = loadReviewValid();
const REVIEW_VALID_RUN_ID = String(reviewValid.runId);
const REVIEW_VALID_BASE_COMMIT = String(reviewValid.baseCommit);
const REVIEW_VALID_DIFF_HASH = String(reviewValid.diffHash);

function cloneReviewValid(): JsonObject {
  return deepClone(reviewValid);
}

const missingFindingReview = cloneReviewValid();
missingFindingReview.reviewRound = 2;
missingFindingReview.decision = "approve";
missingFindingReview.summary = "The prior finding disappeared.";
missingFindingReview.findings = [];

const carriedFindingReview = cloneReviewValid();
carriedFindingReview.reviewRound = 2;
carriedFindingReview.decision = "approve";
carriedFindingReview.summary = "The prior finding is resolved.";
{
  const findings = carriedFindingReview.findings as JsonObject[];
  findings[0].status = "resolved";
  findings[0].actionable = false;
  findings[0].requiredAction = null;
}

const duplicateFindingReview = cloneReviewValid();
{
  const findings = duplicateFindingReview.findings as JsonObject[];
  const caseVariant = deepClone(findings[0]);
  caseVariant.id = String(caseVariant.id).toLowerCase();
  findings.push(caseVariant);
}

const reviewResultCases: Case[] = [
  {
    kind: "review-result",
    label: "review-result: valid review matches expected round/runId/baseCommit/diffHash",
    review: cloneReviewValid(),
    expectedRound: 1,
    runId: REVIEW_VALID_RUN_ID,
    baseCommit: REVIEW_VALID_BASE_COMMIT,
    diffHash: REVIEW_VALID_DIFF_HASH,
  },
  {
    kind: "review-result",
    label: "review-result: reviewRound mismatch is invalid",
    review: cloneReviewValid(),
    expectedRound: 5,
    runId: REVIEW_VALID_RUN_ID,
    baseCommit: REVIEW_VALID_BASE_COMMIT,
    diffHash: REVIEW_VALID_DIFF_HASH,
  },
  {
    kind: "review-result",
    label: "review-result: runId mismatch is invalid",
    review: cloneReviewValid(),
    expectedRound: 1,
    runId: "a-different-run-id",
    baseCommit: REVIEW_VALID_BASE_COMMIT,
    diffHash: REVIEW_VALID_DIFF_HASH,
  },
  { kind: "review-result", label: "review-result: a finding disappearing across rounds is invalid", review: missingFindingReview, previous: cloneReviewValid(), expectedRound: 2 },
  { kind: "review-result", label: "review-result: a finding carried forward with a terminal status is valid", review: carriedFindingReview, previous: cloneReviewValid(), expectedRound: 2 },
  { kind: "review-result", label: "review-result: duplicate finding ids (case-insensitive) are invalid", review: duplicateFindingReview },
  { kind: "review-result", label: "review-result: shipped invalid fixture - approve with open blocker", review: loadReviewInvalid("review.invalid-approve-open-blocker.json") },
  {
    kind: "review-result",
    label: "review-result: shipped invalid fixture - missing viewpoint without escalation",
    review: loadReviewInvalid("review.invalid-missing-viewpoint-non-escalate.json"),
  },
  { kind: "review-result", label: "review-result: shipped invalid fixture - request_changes with no actionable finding", review: loadReviewInvalid("review.invalid-request-changes-empty.json") },
];

// ---------------------------------------------------------------------------
// prompt - the four New-Hdo*Prompt here-strings, built from the real fixtures
// named in the phase-5 plan: issue.valid.json, task.valid.json, review.valid.json,
// .hdo/project.json, a synthetic validation summary, and a synthetic diff.
// ---------------------------------------------------------------------------

const issueContract = loadIssueContract();
const taskContract = loadTaskContract();
const projectContract = loadProjectContract();
const reviewForFix = loadReviewValid();

// PARITY MISMATCH (not a WP-A/B/C bug - a PS-side landmine independent of any
// ported function, discovered by this harness): PowerShell's `ConvertFrom-Json`
// (with or without `-AsHashtable`) silently converts ANY string value that looks
// like an ISO-8601 timestamp into a `[DateTime]`, regardless of field name or
// schema. A "Z"-suffixed (UTC) value happens to round-trip back through
// `ConvertTo-Json` unchanged (verified), but a value with an explicit numeric
// offset - exactly the format `Get-HdoUtcTimestamp` actually produces, e.g.
// "2026-09-05T15:43:50.7777426+00:00" (Runner.ps1 risk 13) - gets its `[DateTime]`
// constructed with `Kind=Local` and is silently CONVERTED TO THE LOCAL TIME ZONE;
// re-emitting it then renders the mutated local time with a shorter
// fractional-second format (verified: "2026-01-01T00:00:00.0000000+00:00" round-trips
// to "2026-01-01T09:00:00+09:00" on a UTC+9 machine). This bit this test harness
// itself (the oracle script's one spec parse silently rewrote a literal
// `completedAt` value before handing it to New-HdoFixPrompt/New-HdoReviewPrompt) -
// worked around here by using a non-date-shaped literal - but the same landmine
// would silently corrupt any REAL persisted timestamp that flows through a PS
// read-modify-write JSON round-trip (`Read-HdoJsonFile` + later `ConvertTo-Json`,
// e.g. run-state reload/re-save) if that value uses `Get-HdoUtcTimestamp`'s own
// offset format. TypeScript's `JSON.parse`/`JSON.stringify` never do this: every
// string value round-trips byte-for-byte regardless of shape. Reported to WP-G for
// the phase-5 §16.4 divergence list.
const SYNTHETIC_VALIDATION: JsonValue = {
  allRequiredPassed: true,
  passed: 2,
  failed: 0,
  indeterminate: 0,
  gates: [
    { id: "tests", required: true, status: "pass", command: ["pwsh", "-NoProfile", "-File", "tests/test-suite.ps1"], exitCode: 0, timedOut: false, skipped: false, durationMs: 1234, artifact: "tests.log" },
    { id: "schemas", required: true, status: "pass", command: ["pwsh", "-NoProfile", "-File", "tests/test-schemas.ps1"], exitCode: 0, timedOut: false, skipped: false, durationMs: 567, artifact: "schemas.log" },
  ],
  completedAt: "SYNTHETIC-VALIDATION-COMPLETED-AT-NOT-A-REAL-TIMESTAMP",
};

const SYNTHETIC_DIFF: PromptDiff = {
  baseCommit: "a".repeat(40),
  hash: "b".repeat(64),
  patch: "diff --git a/x b/x\n",
};

const promptCases: Case[] = [
  { kind: "prompt", label: "prompt: plan", promptKind: "plan", issueContract, projectContract },
  { kind: "prompt", label: "prompt: implementation (iteration 1)", promptKind: "implementation", issueContract, taskContract, projectContract, iteration: 1 },
  {
    kind: "prompt",
    label: "prompt: fix (iteration 2)",
    promptKind: "fix",
    issueContract,
    taskContract,
    projectContract,
    review: reviewForFix,
    validation: SYNTHETIC_VALIDATION,
    iteration: 2,
  },
  {
    kind: "prompt",
    label: "prompt: review, round 1, previousReview null",
    promptKind: "review",
    issueContract,
    taskContract,
    projectContract,
    validation: SYNTHETIC_VALIDATION,
    diff: SYNTHETIC_DIFF,
    previousReview: null,
    round: 1,
    runId: "run-1",
  },
  {
    kind: "prompt",
    label: "prompt: review, round 2, previousReview present",
    promptKind: "review",
    issueContract,
    taskContract,
    projectContract,
    validation: SYNTHETIC_VALIDATION,
    diff: SYNTHETIC_DIFF,
    previousReview: reviewForFix,
    round: 2,
    runId: "run-2",
  },
];

// ---------------------------------------------------------------------------
// Full case list
// ---------------------------------------------------------------------------

const CASES: Case[] = [
  ...configDerivedCases,
  ...claudeArgumentsAdHocCases,
  ...claudeInputAdHocCases,
  ...codexArgumentsAdHocCases,
  ...runnerEnvironmentAdHocCases,
  ...claudeSchemaCases,
  ...codexSchemaCases,
  ...codexFailureCases,
  ...claudeFailureCases,
  ...claudeOutputCases,
  ...ollamaRecoveryCases,
  ...reviewResultCases,
  ...promptCases,
];

// ---------------------------------------------------------------------------
// PS oracle: one pwsh invocation for the entire CASES batch.
// ---------------------------------------------------------------------------

interface OracleEntry {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface OracleOutcome {
  results: OracleEntry[];
}

const ORACLE_SCRIPT = `
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$SpecPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$ArtifactRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $RepositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator
$spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json -Depth 100

$results = & $module {
    param($Cases, $RepositoryRoot, $ArtifactRoot)

    function Get-SpecProperty {
        param($Spec, [Parameter(Mandatory)][string]$Name)
        if ($null -eq $Spec) { return $null }
        if ($Spec.PSObject.Properties.Match($Name).Count -eq 0) { return $null }
        return $Spec.$Name
    }

    $caseResults = [Collections.Generic.List[object]]::new()
    $caseIndex = 0
    foreach ($case in $Cases) {
        $kind = [string]$case.kind
        $entry = $null
        try {
            switch ($kind) {
                'claude-arguments' {
                    $runner = ConvertTo-HdoHashtable $case.runner
                    $modelOverride = Get-SpecProperty $case 'modelOverride'
                    $value = if ($modelOverride) {
                        @(Get-HdoClaudeArguments -Runner $runner -SchemaJson ([string]$case.schemaJson) -ModelOverride ([string]$modelOverride))
                    } else {
                        @(Get-HdoClaudeArguments -Runner $runner -SchemaJson ([string]$case.schemaJson))
                    }
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'codex-arguments' {
                    $runner = ConvertTo-HdoHashtable $case.runner
                    $value = @(Get-HdoCodexArguments -Runner $runner -WorkingDirectory ([string]$case.workingDirectory) -SchemaPath ([string]$case.schemaPath) -FinalPath ([string]$case.finalPath))
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'claude-input' {
                    $runner = ConvertTo-HdoHashtable $case.runner
                    $value = Get-HdoClaudeInputText -Runner $runner -Prompt ([string]$case.prompt) -SchemaJson ([string]$case.schemaJson)
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'claude-schema' {
                    $schemaPath = Join-Path $RepositoryRoot "schemas/$($case.schemaName).schema.json"
                    try {
                        $json = ConvertTo-HdoClaudeJsonSchema $schemaPath
                        $entry = [ordered]@{ ok = $true; value = ($json | ConvertFrom-Json -Depth 100) }
                    } catch {
                        $entry = [ordered]@{ ok = $false; error = $_.Exception.Message }
                    }
                }
                'codex-schema' {
                    $schemaPath = Join-Path $RepositoryRoot "schemas/$($case.schemaName).schema.json"
                    try {
                        $json = ConvertTo-HdoCodexJsonSchema $schemaPath
                        $entry = [ordered]@{ ok = $true; value = ($json | ConvertFrom-Json -Depth 100) }
                    } catch {
                        $entry = [ordered]@{ ok = $false; error = $_.Exception.Message }
                    }
                }
                'runner-environment' {
                    $runner = ConvertTo-HdoHashtable $case.runner
                    $value = Get-HdoRunnerEnvironment -Runner $runner
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'codex-failure' {
                    $value = Get-HdoCodexFailureDetail ([string]$case.stdout) ([string]$case.stderr)
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'claude-failure' {
                    $value = Get-HdoClaudeFailureDetail ([string]$case.stdout) ([string]$case.stderr)
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'claude-output' {
                    $value = ConvertFrom-HdoClaudeOutput ([string]$case.envelopeJson)
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'ollama-recovery' {
                    $schemaPath = Join-Path $RepositoryRoot "schemas/$($case.schemaName).schema.json"
                    $artifactDir = Join-Path $ArtifactRoot "case-$caseIndex"
                    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
                    $resultValue = $null
                    $errorMessage = $null
                    try {
                        $resultValue = Resolve-HdoOllamaStructuredOutput -EnvelopeJson ([string]$case.envelopeJson) -SchemaPath $schemaPath -ArtifactDirectory $artifactDir
                    } catch {
                        $errorMessage = $_.Exception.Message
                    }
                    $diagnostic = $null
                    $diagnosticPath = Join-Path $artifactDir 'structured-output.json'
                    if (Test-Path -LiteralPath $diagnosticPath -PathType Leaf) {
                        $diagnostic = Get-Content -LiteralPath $diagnosticPath -Raw | ConvertFrom-Json -AsHashtable -Depth 20
                        $diagnostic.Remove('originalValidationError')
                        $diagnostic.Remove('finalValidationError')
                    }
                    $entry = [ordered]@{ ok = $true; value = [ordered]@{ result = $resultValue; error = $errorMessage; diagnostic = $diagnostic } }
                }
                'review-result' {
                    $review = ConvertTo-HdoHashtable $case.review
                    $previousRaw = Get-SpecProperty $case 'previous'
                    $previous = if ($null -ne $previousRaw) { ConvertTo-HdoHashtable $previousRaw } else { $null }
                    $expectedRoundRaw = Get-SpecProperty $case 'expectedRound'
                    $runIdRaw = Get-SpecProperty $case 'runId'
                    $baseCommitRaw = Get-SpecProperty $case 'baseCommit'
                    $diffHashRaw = Get-SpecProperty $case 'diffHash'
                    $expectedRound = if ($null -ne $expectedRoundRaw) { [int]$expectedRoundRaw } else { 0 }
                    $runId = if ($null -ne $runIdRaw) { [string]$runIdRaw } else { '' }
                    $baseCommit = if ($null -ne $baseCommitRaw) { [string]$baseCommitRaw } else { '' }
                    $diffHash = if ($null -ne $diffHashRaw) { [string]$diffHashRaw } else { '' }
                    $value = Test-HdoReviewResult -Review $review -PreviousReview $previous -ExpectedRound $expectedRound -ExpectedRunId $runId -ExpectedBaseCommit $baseCommit -ExpectedDiffHash $diffHash
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                'prompt' {
                    $promptKind = [string]$case.promptKind
                    $value = switch ($promptKind) {
                        'plan' { New-HdoPlanPrompt -IssueContract $case.issueContract -ProjectContract $case.projectContract }
                        'implementation' { New-HdoImplementationPrompt -IssueContract $case.issueContract -TaskContract $case.taskContract -ProjectContract $case.projectContract -Iteration ([int]$case.iteration) }
                        'fix' { New-HdoFixPrompt -IssueContract $case.issueContract -TaskContract $case.taskContract -ProjectContract $case.projectContract -Review $case.review -Validation $case.validation -Iteration ([int]$case.iteration) }
                        'review' {
                            $previousReview = Get-SpecProperty $case 'previousReview'
                            New-HdoReviewPrompt -IssueContract $case.issueContract -TaskContract $case.taskContract -ProjectContract $case.projectContract -Validation $case.validation -Diff $case.diff -PreviousReview $previousReview -Round ([int]$case.round) -RunId ([string]$case.runId)
                        }
                        default { throw "unknown promptKind '$promptKind'" }
                    }
                    $entry = [ordered]@{ ok = $true; value = $value }
                }
                default { throw "unknown case kind '$kind'" }
            }
        }
        catch {
            $entry = [ordered]@{ ok = $false; error = $_.Exception.Message }
        }
        $caseResults.Add($entry)
        $caseIndex++
    }
    return ,$caseResults
} $spec.cases $RepositoryRoot $ArtifactRoot

@{ results = $results } | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
`;

// The ambient environment for the WHOLE batch (fixed for every runner-environment
// case, per the phase-5 plan): HDO_PARITY_PASSTHROUGH/HDO_PARITY_TOKEN exercise the
// safe-environment allow/deny-list, CLAUDE_CODE_MAX_CONTEXT_TOKENS exercises the
// inherited-context-window strip/override. Neither pwsh (via spawnSync `env`) nor
// TypeScript (via the explicit `ambient` parameter) reads the real process
// environment for this - both see exactly this snapshot.
const AMBIENT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HDO_PARITY_PASSTHROUGH: "1",
  HDO_PARITY_TOKEN: "x",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "4096",
};

let PS_RESULTS: OracleEntry[] = [];
let artifactRootForCleanup: string | null = null;

if (PWSH_AVAILABLE) {
  const tempDir = mkdtempSync(join(tmpdir(), "hdo-runners-parity-"));
  const artifactRoot = mkdtempSync(join(tmpdir(), "hdo-runners-parity-artifacts-"));
  artifactRootForCleanup = artifactRoot;
  try {
    const scriptPath = join(tempDir, "oracle.ps1");
    const specPath = join(tempDir, "spec.json");
    const outputPath = join(tempDir, "output.json");
    writeFileSync(scriptPath, ORACLE_SCRIPT, "utf8");
    writeFileSync(specPath, JSON.stringify({ cases: CASES }), "utf8");
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-File", scriptPath, "-RepositoryRoot", REPO_ROOT, "-SpecPath", specPath, "-OutputPath", outputPath, "-ArtifactRoot", realpathSync.native(artifactRoot)],
      { encoding: "utf8", windowsHide: true, env: AMBIENT_ENV },
    );
    if (result.status !== 0) {
      throw new Error(`runnersParity oracle harness script failed (exit ${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    const outcome = JSON.parse(readFileSync(outputPath, "utf8")) as OracleOutcome;
    if (outcome.results.length !== CASES.length) {
      throw new Error(`runnersParity oracle returned ${outcome.results.length} results for ${CASES.length} cases`);
    }
    PS_RESULTS = outcome.results;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Recursively sorts object keys, for an order-independent deep comparison. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Parses and canonicalizes the element right after `--json-schema` (if present) so JSON formatting differences never fail the comparison; every other element is compared as a plain string. */
function canonicalizeArgv(argv: string[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json-schema" && i + 1 < argv.length) {
      out.push(argv[i]);
      out.push(canonicalize(JSON.parse(argv[i + 1])));
      i++;
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}

const RUNNER_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "HDO_PARITY_PASSTHROUGH",
  "HDO_PARITY_TOKEN",
];

function pickKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key];
  }
  return out;
}

function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

interface OllamaRecoveryComparable {
  result: string | null;
  error: string | null;
  diagnostic: Record<string, unknown> | null;
}

/**
 * Mirrors the split between the pure `recoverOllamaStructuredOutput` and the host
 * (WP-E)'s impure `Resolve-HdoOllamaStructuredOutput`-equivalent responsibility:
 * the real host writes artifacts then throws `ollamaRecoveryRejectedMessage(...)`
 * for a rejected recovery. This composes the same two pieces so the comparison is
 * against what the full PS function actually does, not just the pure half.
 */
function runOllamaRecoveryTs(envelopeJson: string, validateJson: (json: string) => JsonValidationResult): OllamaRecoveryComparable {
  try {
    const outcome = recoverOllamaStructuredOutput(envelopeJson, validateJson);
    if (outcome.kind === "valid") {
      return { result: outcome.finalJson, error: null, diagnostic: null };
    }
    const { originalValidationError: _originalValidationError, finalValidationError: _finalValidationError, ...rest } = outcome.diagnostic as OllamaRecoveryDiagnostic;
    if (outcome.kind === "recovered") {
      return { result: outcome.finalJson, error: null, diagnostic: rest };
    }
    return { result: null, error: ollamaRecoveryRejectedMessage(outcome.diagnostic.finalValidationError), diagnostic: rest };
  } catch (error) {
    return { result: null, error: (error as Error).message, diagnostic: null };
  }
}

const REJECTED_RECOVERY_MARKER = "recovery rejected (1/1):";

/** Truncates a message at the fixed `recovery rejected (1/1):` marker (inclusive) so the varying Ajv/Test-Json validation-error tail never fails the comparison; a message without the marker (the envelope-failure throw path) is compared in full, since `getClaudeFailureDetail` is deterministic. */
function comparableOllamaError(message: string | null): string | null {
  if (message === null) return null;
  const index = message.indexOf(REJECTED_RECOVERY_MARKER);
  return index === -1 ? message : message.slice(0, index + REJECTED_RECOVERY_MARKER.length);
}

function computeTsPrompt(c: Case): string {
  switch (c.promptKind) {
    case "plan":
      return buildPlanPrompt(c.issueContract!, c.projectContract!);
    case "implementation":
      return buildImplementationPrompt(c.issueContract!, c.taskContract!, c.projectContract!, c.iteration!);
    case "fix":
      return buildFixPrompt(c.issueContract!, c.taskContract!, c.projectContract!, c.review as unknown as import("../core/contracts/types.ts").ReviewResult, c.validation!, c.iteration!);
    case "review":
      return buildReviewPrompt(
        c.issueContract!,
        c.taskContract!,
        c.projectContract!,
        c.validation!,
        c.diff!,
        (c.previousReview ?? undefined) as import("../core/contracts/types.ts").ReviewResult | undefined,
        c.round!,
        c.runId!,
      );
    default:
      throw new Error(`unknown promptKind ${String(c.promptKind)}`);
  }
}

// ---------------------------------------------------------------------------
// One node:test per case.
// ---------------------------------------------------------------------------

for (let index = 0; index < CASES.length; index++) {
  const c = CASES[index];
  test(c.label, { skip: SKIP_REASON }, () => {
    const ps = PS_RESULTS[index];
    switch (c.kind) {
      case "claude-arguments": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsArgs = c.modelOverride ? getClaudeArguments(c.runner!, c.schemaJson!, c.modelOverride) : getClaudeArguments(c.runner!, c.schemaJson!);
        assert.deepStrictEqual(canonicalizeArgv(tsArgs), canonicalizeArgv(ps.value as string[]));
        break;
      }
      case "codex-arguments": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsArgs = getCodexArguments(c.runner!, c.workingDirectory!, c.schemaPath!, c.finalPath!);
        assert.deepStrictEqual(tsArgs, ps.value as string[]);
        break;
      }
      case "claude-input": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = getClaudeInputText(c.runner!, c.prompt!, c.schemaJson!);
        // Exact comparison, no CRLF normalization: `Get-HdoClaudeInputText` joins with
        // backtick-n only (no `ConvertTo-Json`), so a CRLF here would be a real
        // divergence, unlike the prompt-builder case below which legitimately emits
        // CRLF on Windows (review round 1 finding 9a).
        assert.equal(tsValue, ps.value as string);
        break;
      }
      case "claude-schema": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = toClaudeTransportSchema(loadSchema(c.schemaName!));
        assert.deepStrictEqual(canonicalize(tsValue), canonicalize(ps.value));
        // Also exercises the string-producing wrapper end to end.
        assert.equal(JSON.parse(toClaudeTransportSchemaJson(loadSchema(c.schemaName!))) !== undefined, true);
        break;
      }
      case "codex-schema": {
        if (c.expectThrow) {
          assert.equal(ps.ok, false, "expected the PS oracle to throw");
          assert.throws(() => toCodexTransportSchemaJson(loadSchema(c.schemaName!)));
          let tsMessage = "";
          try {
            toCodexTransportSchemaJson(loadSchema(c.schemaName!));
          } catch (error) {
            tsMessage = (error as Error).message;
          }
          assert.equal(tsMessage, ps.error);
        } else {
          assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
          const tsValue = toCodexTransportSchema(loadSchema(c.schemaName!));
          assert.deepStrictEqual(canonicalize(tsValue), canonicalize(ps.value));
        }
        break;
      }
      case "runner-environment": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = getRunnerEnvironment(c.runner!, AMBIENT_ENV as Record<string, string | undefined>);
        assert.deepStrictEqual(pickKeys(tsValue, RUNNER_ENV_KEYS), pickKeys(ps.value as Record<string, unknown>, RUNNER_ENV_KEYS));
        break;
      }
      case "codex-failure": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = getCodexFailureDetail(c.stdout!, c.stderr!);
        assert.equal(tsValue, ps.value as string);
        break;
      }
      case "claude-failure": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = getClaudeFailureDetail(c.stdout!, c.stderr!);
        assert.equal(tsValue, ps.value as string);
        break;
      }
      case "claude-output": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = extractClaudeOutput(c.envelopeJson!);
        assert.equal(tsValue, ps.value as string);
        break;
      }
      case "ollama-recovery": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const psComparable = ps.value as OllamaRecoveryComparable;
        const tsComparable = runOllamaRecoveryTs(c.envelopeJson!, validateWorkerResult);
        assert.equal(tsComparable.result, psComparable.result, "result mismatch");
        assert.equal(comparableOllamaError(tsComparable.error), comparableOllamaError(psComparable.error), "error mismatch");
        assert.deepStrictEqual(tsComparable.diagnostic, psComparable.diagnostic ?? null, "diagnostic mismatch");
        break;
      }
      case "review-result": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const psValue = ps.value as { valid: boolean; errors: string[] };
        const tsValue = testReviewResult(c.review!, c.previous ?? undefined, c.expectedRound ?? 0, c.runId ?? "", c.baseCommit ?? "", c.diffHash ?? "");
        assert.equal(tsValue.valid, psValue.valid, "valid mismatch");
        assert.deepStrictEqual([...tsValue.errors].sort(), [...psValue.errors].sort(), "errors mismatch");
        break;
      }
      case "prompt": {
        assert.equal(ps.ok, true, `PS oracle failed: ${ps.error}`);
        const tsValue = computeTsPrompt(c);
        assert.equal(normalizeCrlf(tsValue), normalizeCrlf(ps.value as string));
        break;
      }
      default:
        throw new Error(`no comparison wired up for case kind '${c.kind}'`);
    }
  });
}

test("runnersParity: oracle result count matches the case count and every case kind is exercised", { skip: SKIP_REASON }, () => {
  assert.equal(PS_RESULTS.length, CASES.length);
  const kinds = new Set(CASES.map((c) => c.kind));
  const expectedKinds = [
    "claude-arguments",
    "codex-arguments",
    "claude-input",
    "claude-schema",
    "codex-schema",
    "runner-environment",
    "codex-failure",
    "claude-failure",
    "claude-output",
    "ollama-recovery",
    "review-result",
    "prompt",
  ];
  for (const kind of expectedKinds) {
    assert.ok(kinds.has(kind), `expected at least one case of kind '${kind}'`);
  }
});

test.after(() => {
  if (artifactRootForCleanup) {
    rmSync(artifactRootForCleanup, { recursive: true, force: true });
  }
});
