// Ports `ConvertFrom-HdoClaudeOutput`/`Resolve-HdoOllamaStructuredOutput` fixtures and
// their named assertions from `tests/run-tests.ps1:847-850, 1187-1221`. Reads the real
// `schemas/worker-result.schema.json` and `tests/fixtures/runtime/claude-ollama-*.json`
// files from disk (this is a *.test.ts file, exempt from the core boundary rule - see
// `src/core/boundary.test.ts`'s module banner).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SchemaObject } from "../contracts/validate.ts";
import { compileSchema } from "../contracts/validate.ts";
import {
  extractClaudeOutput,
  ollamaRecoveryRejectedMessage,
  recoverOllamaStructuredOutput,
  type JsonValidationResult,
} from "./claudeOutput.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");
const RUNTIME_FIXTURES_DIR = resolvePath(REPO_ROOT, "tests", "fixtures", "runtime");

function loadRuntimeFixtureText(name: string): string {
  return readFileSync(resolvePath(RUNTIME_FIXTURES_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// extractClaudeOutput - Oracle: tests/run-tests.ps1:847-850
// ---------------------------------------------------------------------------

// Oracle: tests/run-tests.ps1:847-848, "Claude envelope conversion returns string
// results as-is"
test("extractClaudeOutput returns string results as-is", () => {
  assert.equal(extractClaudeOutput('{"type":"result","result":"plain text"}'), "plain text");
});

// Oracle: tests/run-tests.ps1:849-850, "Claude envelope conversion prefers
// structured_output over result"
test("extractClaudeOutput prefers structured_output over result", () => {
  const output = extractClaudeOutput(
    '{"type":"result","result":"ignored","structured_output":{"schemaVersion":1}}',
  );
  assert.equal((JSON.parse(output) as { schemaVersion: number }).schemaVersion, 1);
});

// Not in the PS oracle test list directly, but named explicitly in the phase-5 plan
// (§WP-C): `result: null` must serialize to the literal text "null", matching PS
// `$null | ConvertTo-Json` (verified: prints `null`), not an empty/omitted value.
test("extractClaudeOutput: an explicit null result serializes to the string 'null'", () => {
  assert.equal(extractClaudeOutput('{"type":"result","result":null}'), "null");
});

test("extractClaudeOutput: an envelope with neither structured_output nor result returns the compact envelope JSON", () => {
  const envelopeJson = '{"type":"result","subtype":"success"}';
  assert.equal(extractClaudeOutput(envelopeJson), JSON.stringify(JSON.parse(envelopeJson)));
});

// ---------------------------------------------------------------------------
// recoverOllamaStructuredOutput - Oracle: tests/run-tests.ps1:1187-1221
// ---------------------------------------------------------------------------

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

const workerResultSchema = JSON.parse(
  readFileSync(resolvePath(SCHEMAS_DIR, "worker-result.schema.json"), "utf8"),
) as SchemaObject;
const validateWorkerResult = makeValidateJson(workerResultSchema);

const PROSE_FIXTURES = [
  "claude-ollama-prose.json",
  "claude-ollama-inline-prose.json",
  "claude-ollama-list-prose.json",
  "claude-ollama-symbol-prose.json",
];

// Oracle: tests/run-tests.ps1:1187-1205, "real Ollama smoke prose ... recovers
// without changing JSON" / "recovery is classified and bounded to one attempt"
test("recoverOllamaStructuredOutput recovers every real Ollama prose fixture, classified and bounded to one attempt", () => {
  for (const name of PROSE_FIXTURES) {
    const envelopeJson = loadRuntimeFixtureText(name);
    const outcome = recoverOllamaStructuredOutput(envelopeJson, validateWorkerResult);
    assert.equal(outcome.kind, "recovered", `${name}: expected kind 'recovered'`);
    if (outcome.kind !== "recovered") continue; // narrows for TS below
    assert.equal((JSON.parse(outcome.finalJson) as { schemaVersion: number }).schemaVersion, 1, name);
    assert.equal(outcome.diagnostic.recovery, "succeeded", name);
    assert.equal(outcome.diagnostic.attempts, 1, name);
  }
});

const proseFixture = JSON.parse(loadRuntimeFixtureText("claude-ollama-prose.json")) as Record<string, unknown>;
const proseOutcome = recoverOllamaStructuredOutput(JSON.stringify(proseFixture), validateWorkerResult);
if (proseOutcome.kind !== "recovered") {
  throw new Error("test setup: the prose fixture must recover to seed validJson for the tests below");
}
const validJson = proseOutcome.finalJson;

function withResult(bad: string): string {
  return JSON.stringify({ ...proseFixture, result: bad });
}

// Oracle: tests/run-tests.ps1:1206-1217, "invalid, multiple, ambiguous, and oversized
// output fails closed with recovery diagnosis" / "failed recovery retains final
// validation error"
test("recoverOllamaStructuredOutput rejects every ambiguous/invalid/oversized prose variant, with a non-empty final validation error", () => {
  const badResults = [
    "",
    " ",
    "```json" + "\n" + validJson,
    "Unclosed `token" + "\n" + validJson,
    "Done.\n{}",
    "Done.\n" + validJson + "\n{}",
    "Done.\n" + validJson + " trailing",
    "[prefix]\n" + validJson,
    `Quoted "prefix"\n` + validJson,
    "Done. " + validJson,
    "Done.\n{broken\n" + validJson,
    "Done.\n[" + validJson + "]",
    "x".repeat(1048577) + "\n" + validJson,
  ];
  for (const bad of badResults) {
    const outcome = recoverOllamaStructuredOutput(withResult(bad), validateWorkerResult);
    assert.equal(outcome.kind, "rejected", `bad result ${JSON.stringify(bad.slice(0, 40))}...`);
    if (outcome.kind !== "rejected") continue;
    assert.ok(outcome.diagnostic.finalValidationError, `bad result ${JSON.stringify(bad.slice(0, 40))}... expected a final validation error`);
  }
});

// Oracle: tests/run-tests.ps1:1219-1221, "valid JSON-only Ollama result is unchanged"
test("recoverOllamaStructuredOutput: a valid JSON-only result is unchanged (kind 'valid', byte-identical finalJson)", () => {
  const outcome = recoverOllamaStructuredOutput(withResult(validJson), validateWorkerResult);
  assert.equal(outcome.kind, "valid");
  assert.equal(outcome.finalJson, validJson);
});

// Oracle: tests/run-tests.ps1:1219-1221 area (is_error / subtype failure envelopes
// throw before any recovery attempt) - see Runner.ps1:439-442.
test("recoverOllamaStructuredOutput throws on an is_error envelope", () => {
  const envelopeJson = JSON.stringify({ is_error: true, subtype: "success", result: "boom" });
  assert.throws(
    () => recoverOllamaStructuredOutput(envelopeJson, validateWorkerResult),
    (error: unknown) => error instanceof Error && /^Claude\/Ollama envelope failure: /.test(error.message),
  );
});

test("recoverOllamaStructuredOutput throws on a non-success subtype", () => {
  const envelopeJson = JSON.stringify({ is_error: false, subtype: "error_max_turns", result: "boom" });
  assert.throws(
    () => recoverOllamaStructuredOutput(envelopeJson, validateWorkerResult),
    (error: unknown) => error instanceof Error && /^Claude\/Ollama envelope failure: /.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// ollamaRecoveryRejectedMessage - Oracle: Runner.ps1:484
// ---------------------------------------------------------------------------

test("ollamaRecoveryRejectedMessage produces the exact throw text the host raises after writing artifacts", () => {
  assert.equal(
    ollamaRecoveryRejectedMessage("No unambiguous plain-prose prefix followed by one JSON object."),
    "Claude/Ollama structured-output noncompliance; recovery rejected (1/1): No unambiguous plain-prose prefix followed by one JSON object. See structured-output.json and result.original.txt.",
  );
});
