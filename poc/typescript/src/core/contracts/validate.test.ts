import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compileSchema, validateAgainstSchema } from "./validate.ts";

const SAMPLE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    when: { type: "string", format: "date-time" },
  },
} as const;

test("validateAgainstSchema accepts a conforming document", () => {
  const result = validateAgainstSchema(SAMPLE_SCHEMA as Record<string, unknown>, { name: "ok" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateAgainstSchema rejects a missing required property with a readable error", () => {
  const result = validateAgainstSchema(SAMPLE_SCHEMA as Record<string, unknown>, {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("ajv-formats is wired up: format: date-time rejects a non-date string", () => {
  const validate = compileSchema(SAMPLE_SCHEMA as Record<string, unknown>);
  assert.equal(validate({ name: "x", when: "not-a-date" }).valid, false);
  assert.equal(validate({ name: "x", when: "2026-09-04T00:00:00Z" }).valid, true);
});

test("compileSchema returns a reusable validator across multiple calls", () => {
  const validate = compileSchema(SAMPLE_SCHEMA as Record<string, unknown>);
  assert.equal(validate({ name: "a" }).valid, true);
  assert.equal(validate({ name: "b" }).valid, true);
  assert.equal(validate({}).valid, false);
});
