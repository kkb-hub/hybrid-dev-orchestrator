// Tests for `resolveOllamaStructuredOutputArtifacts`/`validateJsonAgainstSchema`
// (the host half of `Resolve-HdoOllamaStructuredOutput`, Runner.ps1:431-487) against
// the REAL `worker-result` schema compiled through Ajv (`compileSchema`), so these
// tests exercise the actual validator every production caller uses - not a hand-rolled
// stand-in. The pure recovery DECISION (`recoverOllamaStructuredOutput`) already has
// its own exhaustive edge-case matrix in `../core/runners/claudeOutput.test.ts`; this
// file focuses on what is specific to the host adapter: which artifacts get written,
// with what exact (redacted) content, and only for the `recovered`/`rejected` cases -
// never for `valid`.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileSchema, type CompiledValidator } from "../core/contracts/validate.ts";
import { resolveOllamaStructuredOutputArtifacts, validateJsonAgainstSchema } from "./ollamaStructuredOutput.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "runtime");

const workerResultSchema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "worker-result.schema.json"), "utf8"));
const validator: CompiledValidator = compileSchema(workerResultSchema);

const VALID_WORKER_RESULT = {
  schemaVersion: 1,
  summary: "Created fixture",
  changedFiles: ["hdo-ollama-smoke.txt"],
  tests: ["Verified exact bytes"],
  notes: [],
  blockers: [],
};

function makeArtifactDirectory(): string {
  return mkdtempSync(join(tmpdir(), "hdo-ollamaStructuredOutput-test-"));
}

function envelope(overrides: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...overrides });
}

test("validateJsonAgainstSchema: reports 'Invalid JSON: ...' for unparseable text", () => {
  const result = validateJsonAgainstSchema("{not json", validator);
  assert.equal(result.valid, false);
  assert.ok(result.error?.startsWith("Invalid JSON: "));
});

test("validateJsonAgainstSchema: reports 'Schema validation failed: ...' for well-formed JSON that fails the schema", () => {
  const result = validateJsonAgainstSchema("{}", validator);
  assert.equal(result.valid, false);
  assert.ok(result.error?.startsWith("Schema validation failed: "));
});

test("validateJsonAgainstSchema: valid input against the real worker-result schema", () => {
  const result = validateJsonAgainstSchema(JSON.stringify(VALID_WORKER_RESULT), validator);
  assert.deepEqual(result, { valid: true, error: null });
});

test("resolveOllamaStructuredOutputArtifacts: a JSON-only result is unchanged and writes no artifacts", () => {
  const artifactDirectory = makeArtifactDirectory();
  try {
    const envelopeJson = envelope({ result: JSON.stringify(VALID_WORKER_RESULT) });
    const finalJson = resolveOllamaStructuredOutputArtifacts({ envelopeJson, schemaValidator: validator, artifactDirectory });
    assert.equal(finalJson, JSON.stringify(VALID_WORKER_RESULT));
    for (const name of ["result.original.txt", "recovery.input.txt", "recovery.output.txt", "structured-output.json"]) {
      assert.equal(existsSync(join(artifactDirectory, name)), false, `expected no ${name} for a valid result`);
    }
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaStructuredOutputArtifacts: recovers a real Ollama prose-prefixed result and writes all four diagnostic artifacts", () => {
  const artifactDirectory = makeArtifactDirectory();
  try {
    const envelopeJson = readFileSync(join(FIXTURES_DIR, "claude-ollama-prose.json"), "utf8");
    const finalJson = resolveOllamaStructuredOutputArtifacts({ envelopeJson, schemaValidator: validator, artifactDirectory });

    const recoveredValue = JSON.parse(finalJson);
    assert.equal(recoveredValue.schemaVersion, 1);
    assert.equal(recoveredValue.summary, "Created fixture");

    // Oracle: tests/run-tests.ps1:1189-1193.
    for (const name of ["result.original.txt", "recovery.input.txt", "recovery.output.txt", "structured-output.json"]) {
      assert.ok(existsSync(join(artifactDirectory, name)), `expected ${name} to exist`);
    }
    const diagnostic = JSON.parse(readFileSync(join(artifactDirectory, "structured-output.json"), "utf8"));
    assert.equal(diagnostic.recovery, "succeeded");
    assert.equal(diagnostic.attempts, 1);
    assert.equal(diagnostic.maximumAttempts, 1);

    const original = readFileSync(join(artifactDirectory, "result.original.txt"), "utf8");
    assert.ok(!original.endsWith("\n"), "result.original.txt must have no trailing newline (-NoNewline)");
    assert.equal(readFileSync(join(artifactDirectory, "recovery.input.txt"), "utf8"), original);
    const recoveryOutput = readFileSync(join(artifactDirectory, "recovery.output.txt"), "utf8");
    assert.equal(JSON.parse(recoveryOutput).summary, "Created fixture");
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaStructuredOutputArtifacts: redacts a credential-shaped secret out of the prose before writing artifacts", () => {
  const artifactDirectory = makeArtifactDirectory();
  try {
    const prose = "Done, token=ghp_abcdefghijklmnopqrstuvwxyz123456 is set.\n" + JSON.stringify(VALID_WORKER_RESULT);
    const envelopeJson = envelope({ result: prose });
    resolveOllamaStructuredOutputArtifacts({ envelopeJson, schemaValidator: validator, artifactDirectory });

    const original = readFileSync(join(artifactDirectory, "result.original.txt"), "utf8");
    assert.ok(!original.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));
    assert.ok(original.includes("[REDACTED]"));
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaStructuredOutputArtifacts: an ambiguous/invalid recovery throws the exact rejection message and leaves a 'rejected' diagnostic", () => {
  const artifactDirectory = makeArtifactDirectory();
  try {
    // No newline before the JSON object - PREFIX_PATTERN requires one, so recovery never runs.
    const envelopeJson = envelope({ result: `Done. ${JSON.stringify(VALID_WORKER_RESULT)}` });
    assert.throws(
      () => resolveOllamaStructuredOutputArtifacts({ envelopeJson, schemaValidator: validator, artifactDirectory }),
      /^Error: Claude\/Ollama structured-output noncompliance; recovery rejected \(1\/1\): No unambiguous plain-prose prefix followed by one JSON object\. See structured-output\.json and result\.original\.txt\.$/,
    );
    const diagnostic = JSON.parse(readFileSync(join(artifactDirectory, "structured-output.json"), "utf8"));
    assert.equal(diagnostic.recovery, "rejected");
    assert.ok(diagnostic.finalValidationError);
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaStructuredOutputArtifacts: an envelope-level failure (is_error/non-success subtype) throws before writing any artifact", () => {
  const artifactDirectory = makeArtifactDirectory();
  try {
    const envelopeJson = JSON.stringify({ is_error: true, result: "boom" });
    assert.throws(
      () => resolveOllamaStructuredOutputArtifacts({ envelopeJson, schemaValidator: validator, artifactDirectory }),
      /^Error: Claude\/Ollama envelope failure: /,
    );
    for (const name of ["result.original.txt", "recovery.input.txt", "recovery.output.txt", "structured-output.json"]) {
      assert.equal(existsSync(join(artifactDirectory, name)), false);
    }
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});
