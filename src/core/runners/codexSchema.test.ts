// Oracle: tests/run-tests.ps1:771-808 (the Codex-normalization portion of the
// `runnersParity`/schema-normalization test case). Reads the real
// `schemas/*.schema.json` files from disk (this is a *.test.ts file, exempt from the
// core boundary rule - see src/core/boundary.test.ts's module banner) so
// normalization is proven against the canonical documents, not a hand-built stand-in.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../contracts/types.ts";
import type { SchemaObject } from "../contracts/validate.ts";
import { compileSchema } from "../contracts/validate.ts";
import { normalizeCodexSchemaNode, toCodexTransportSchema, toCodexTransportSchemaJson } from "./codexSchema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");
const FIXTURES_DIR = resolvePath(REPO_ROOT, "tests", "fixtures", "schema");

function loadSchema(name: string): SchemaObject {
  return JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
}

const CODEX_SCHEMA_NAMES = ["task-contract", "worker-result", "review-result"] as const;

// Oracle: tests/run-tests.ps1:775, "Codex-normalized $codexSchemaName schema drops
// unsupported Structured Outputs keywords".
test("Codex-normalized schema JSON drops unsupported Structured Outputs keywords, for every shipped schema", () => {
  for (const name of CODEX_SCHEMA_NAMES) {
    const json = toCodexTransportSchemaJson(loadSchema(name));
    for (const forbidden of ['"$schema"', '"allOf"', '"if"', '"then"', '"contains"']) {
      assert.ok(!json.includes(forbidden), `${name}: expected no ${forbidden} in ${json}`);
    }
  }
});

// Oracle: tests/run-tests.ps1:776, "Codex-normalized $codexSchemaName schema infers
// the integer const type".
test("Codex-normalized schema infers properties.schemaVersion.type === 'integer' from its const, for every shipped schema", () => {
  for (const name of CODEX_SCHEMA_NAMES) {
    const normalized = toCodexTransportSchema(loadSchema(name)) as JsonObject;
    const schemaVersion = (normalized.properties as JsonObject).schemaVersion as JsonObject;
    assert.equal(schemaVersion.type, "integer", `${name}: expected schemaVersion.type to be inferred as 'integer'`);
  }
});

const normalizedCodexReview = toCodexTransportSchema(loadSchema("review-result")) as JsonObject;

// Oracle: tests/run-tests.ps1:778, "Codex schema normalization infers string enum types".
test("Codex-normalized review schema infers properties.decision.type === 'string' from its enum", () => {
  const decision = (normalizedCodexReview.properties as JsonObject).decision as JsonObject;
  assert.equal(decision.type, "string");
});

// Oracle: tests/run-tests.ps1:779, "Codex review schema requires every root property".
test("Codex-normalized review schema's required array contains escalationReason", () => {
  assert.ok((normalizedCodexReview.required as string[]).includes("escalationReason"));
});

// Oracle: tests/run-tests.ps1:780, "Codex review schema represents the non-escalate
// reason as null".
test("Codex-normalized review schema's properties.escalationReason.type includes 'null'", () => {
  const escalationReason = (normalizedCodexReview.properties as JsonObject).escalationReason as JsonObject;
  assert.ok((escalationReason.type as string[]).includes("null"));
});

// Oracle: tests/run-tests.ps1:783, "valid review fixture passes the Codex transport
// schema" (Test-Json in PS; compileSchema/Ajv here, per ADR-0001 phase 5 plan §WP-A).
test("tests/fixtures/schema/review.valid.json validates against the Codex transport review schema", () => {
  const validate = compileSchema(normalizedCodexReview);
  const fixture = JSON.parse(readFileSync(resolvePath(FIXTURES_DIR, "review.valid.json"), "utf8"));
  const result = validate(fixture);
  assert.equal(result.valid, true, `expected the fixture to validate: ${result.errors.join("; ")}`);
});

// Oracle: tests/run-tests.ps1:808, "Codex schema normalization fails locally when a
// property is optional".
test("Codex schema normalization throws when an object property is not required", () => {
  const schema: SchemaObject = {
    type: "object",
    additionalProperties: false,
    properties: {
      requiredValue: { type: "string" },
      optionalValue: { type: "string" },
    },
    required: ["requiredValue"],
  };
  assert.throws(() => toCodexTransportSchema(schema), /requires every object property/);
  assert.throws(() => toCodexTransportSchema(schema), /Codex structured output requires every object property: optionalValue\./);
});

// Not directly covered by tests/run-tests.ps1 (its own case table only exercises the
// "optional property" throw), but the same guard (Runner.ps1:162-163) also throws
// when additionalProperties is missing or truthy - covered here for completeness
// (ADR-0001 phase 5 plan §WP-A: "plus a test for the additionalProperties throw text").
test("Codex schema normalization throws when additionalProperties is missing or not false", () => {
  const missing: SchemaObject = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.throws(() => toCodexTransportSchema(missing), /Codex structured output object schemas must set additionalProperties to false\./);

  const truthy: SchemaObject = { type: "object", additionalProperties: true, properties: { a: { type: "string" } }, required: ["a"] };
  assert.throws(() => toCodexTransportSchema(truthy), /Codex structured output object schemas must set additionalProperties to false\./);
});

// Issue #22: OpenAI Structured Outputs rejects a top-level oneOf the same way the
// Anthropic Messages API rejects Claude's top-level oneOf/allOf/anyOf, so Codex's
// unsupported-keyword list drops oneOf at EVERY depth (not just the root) - unlike
// Claude, which only strips composition specifically at the document root
// (claudeSchema.test.ts covers Claude's root-only stripping). anyOf is deliberately
// NOT added to Codex's unsupported list, so it survives untouched, at the root or
// nested - this is the "only Claude strips root composition" asymmetry ADR-0001
// phase 5 plan §WP-A calls out explicitly, mirrored deliberately by this test.
test("Codex schema normalization strips a nested oneOf but keeps a root anyOf (#22 asymmetry)", () => {
  const schema: SchemaObject = {
    type: "object",
    additionalProperties: false,
    properties: {
      a: { oneOf: [{ type: "string" }, { type: "number" }] },
    },
    required: ["a"],
  };
  const normalized = toCodexTransportSchema(schema) as JsonObject;
  const a = (normalized.properties as JsonObject).a as JsonObject;
  assert.equal("oneOf" in a, false, "expected the nested oneOf to be stripped");

  const rootAnyOf: SchemaObject = {
    anyOf: [
      { type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", additionalProperties: false, properties: { b: { type: "string" } }, required: ["b"] },
    ],
  };
  const normalizedRootAnyOf = toCodexTransportSchema(rootAnyOf) as JsonObject;
  assert.ok("anyOf" in normalizedRootAnyOf, "expected the root anyOf to survive Codex normalization");
});

test("Codex schema normalization is deterministic and never mutates the input document", () => {
  for (const name of CODEX_SCHEMA_NAMES) {
    const original = loadSchema(name);
    const snapshot = structuredClone(original);
    const first = normalizeCodexSchemaNode(original as unknown as JsonObject, true);
    const second = normalizeCodexSchemaNode(original as unknown as JsonObject, true);
    assert.deepEqual(first, second, `${name}: expected normalizing twice to produce deep-equal output`);
    assert.deepEqual(original, snapshot, `${name}: expected the input document not to be mutated`);
  }
});
