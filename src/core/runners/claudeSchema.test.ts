// Oracle: tests/run-tests.ps1:730-769 (the Claude-normalization portion of the
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
import { normalizeClaudeSchemaNode, toClaudeTransportSchema, toClaudeTransportSchemaJson } from "./claudeSchema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");
const FIXTURES_DIR = resolvePath(REPO_ROOT, "tests", "fixtures", "schema");

function loadSchema(name: string): SchemaObject {
  return JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
}

const CLAUDE_SCHEMA_NAMES = ["task-contract", "worker-result", "review-result"] as const;

// Oracle: tests/run-tests.ps1:733, "Claude-normalized $claudeSchemaName schema drops
// `$schema and default minContains".
test("Claude-normalized schema JSON drops $schema and default minContains, for every shipped schema", () => {
  for (const name of CLAUDE_SCHEMA_NAMES) {
    const json = toClaudeTransportSchemaJson(loadSchema(name));
    assert.ok(!json.includes('"$schema"'), `${name}: expected no "$schema" in ${json}`);
    assert.ok(!json.includes('"minContains"'), `${name}: expected no "minContains" in ${json}`);
  }
});

// Oracle: tests/run-tests.ps1:738, "Claude-normalized $claudeSchemaName schema has no
// top-level oneOf/allOf/anyOf".
test("Claude-normalized schema has no top-level oneOf/allOf/anyOf, for every shipped schema", () => {
  for (const name of CLAUDE_SCHEMA_NAMES) {
    const normalized = toClaudeTransportSchema(loadSchema(name));
    assert.equal("oneOf" in normalized, false, `${name}: expected no top-level oneOf`);
    assert.equal("allOf" in normalized, false, `${name}: expected no top-level allOf`);
    assert.equal("anyOf" in normalized, false, `${name}: expected no top-level anyOf`);
  }
});

const normalizedReview = toClaudeTransportSchema(loadSchema("review-result")) as JsonObject;

// Oracle: tests/run-tests.ps1:742, "Claude-normalized review schema keeps referencing
// the finding definition".
test("Claude-normalized review schema keeps properties.findings.items.$ref pointing at #/$defs/finding", () => {
  const findings = normalizedReview.properties as JsonObject;
  const items = (findings.findings as JsonObject).items as JsonObject;
  assert.equal(items["$ref"], "#/$defs/finding");
});

// Oracle: tests/run-tests.ps1:743, "Claude schema normalization keeps nested
// (non-root) composition under $defs".
test("Claude-normalized review schema keeps nested $defs.finding.allOf composition", () => {
  const defs = normalizedReview["$defs"] as JsonObject;
  const finding = defs.finding as JsonObject;
  const allOf = finding.allOf as JsonObject[];
  const ifBlock = allOf[0].if as JsonObject;
  const properties = ifBlock.properties as JsonObject;
  const actionable = properties.actionable as JsonObject;
  assert.equal(actionable.const, true);
});

// Oracle: tests/run-tests.ps1:747, "valid review fixture passes the
// Claude-normalized schema" (Test-Json in PS; compileSchema/Ajv here, per ADR-0001
// phase 5 plan §WP-A).
test("tests/fixtures/schema/review.valid.json validates against the Claude-normalized review schema", () => {
  const validate = compileSchema(normalizedReview);
  const fixture = JSON.parse(readFileSync(resolvePath(FIXTURES_DIR, "review.valid.json"), "utf8"));
  const result = validate(fixture);
  assert.equal(result.valid, true, `expected the fixture to validate: ${result.errors.join("; ")}`);
});

// Oracle: tests/run-tests.ps1:758, "Claude schema normalization adds the explicit
// array type strict mode requires".
test("Claude schema normalization adds type: 'array' when only array keywords are present", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: { tags: { minItems: 1, uniqueItems: true } },
  };
  const normalized = toClaudeTransportSchema(schema) as JsonObject;
  const tags = (normalized.properties as JsonObject).tags as JsonObject;
  assert.equal(tags.type, "array");
});

// Oracle: tests/run-tests.ps1:768-769, "Claude schema normalization leaves enum/
// default data values untouched" - a literal enum/default value containing keys that
// look like schema keywords ($schema, minItems, minContains) must round-trip
// unchanged, with no "type" added inside it.
test("Claude schema normalization never rewrites const/enum/default data-keyword literals", () => {
  const schema: SchemaObject = {
    type: "object",
    properties: {
      x: {
        enum: [{ $schema: "literal", minItems: 1 }],
        default: { minContains: 1 },
      },
    },
  };
  const normalized = toClaudeTransportSchema(schema) as JsonObject;
  const x = (normalized.properties as JsonObject).x as JsonObject;
  const enumLiteral = (x.enum as JsonObject[])[0];
  assert.equal(enumLiteral["$schema"], "literal");
  assert.equal(enumLiteral.minItems, 1);
  assert.equal("type" in enumLiteral, false);
  const defaultLiteral = x.default as JsonObject;
  assert.equal(defaultLiteral.minContains, 1);
  assert.equal("type" in defaultLiteral, false);
});

// Verified against pwsh 7.6.5 (see claudeSchema.ts's normalizeClaudeSchemaNode
// comment): only a numeric minContains equal to 1 (or 1.0) is dropped; the string
// "1" is NOT dropped (.NET strings are IEnumerable, which excludes them from
// Runner.ps1:60-62's drop condition) - this corrects an inaccurate note in the
// ADR-0001 phase 5 plan draft, which claimed "1" was also covered.
test("Claude schema normalization keeps a string minContains value of '1' (only numeric 1/1.0 are dropped)", () => {
  const schema: SchemaObject = { minContains: "1" };
  const normalized = toClaudeTransportSchema(schema) as JsonObject;
  assert.equal(normalized.minContains, "1");
  assert.equal(normalized.type, "array");
});

test("Claude schema normalization drops a numeric minContains value of 1 or 1.0", () => {
  assert.equal("minContains" in (toClaudeTransportSchema({ minContains: 1 }) as JsonObject), false);
  assert.equal("minContains" in (toClaudeTransportSchema({ minContains: 1.0 }) as JsonObject), false);
  // A non-default value survives (and still triggers the array-type append).
  const kept = toClaudeTransportSchema({ minContains: 2 }) as JsonObject;
  assert.equal(kept.minContains, 2);
  assert.equal(kept.type, "array");
});

test("Claude schema normalization is deterministic and never mutates the input document", () => {
  for (const name of CLAUDE_SCHEMA_NAMES) {
    const original = loadSchema(name);
    const snapshot = structuredClone(original);
    const first = normalizeClaudeSchemaNode(original as unknown as JsonObject, true);
    const second = normalizeClaudeSchemaNode(original as unknown as JsonObject, true);
    assert.deepEqual(first, second, `${name}: expected normalizing twice to produce deep-equal output`);
    assert.deepEqual(original, snapshot, `${name}: expected the input document not to be mutated`);
  }
});
