// Unit tests for `SchemaRegistry.getDocument` (ADR-0001 phase 5 plan §WP-0): hosts
// hand the canonical, already-parsed schema document straight to
// `claudeSchema`/`codexSchema` without re-reading a schema file, so `getDocument`
// must return the exact same object identity the registry was constructed with (no
// copy, no re-parse), and must fail exactly like `get()` does for an unknown name.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "./schemas.ts";
import type { SchemaObject } from "./validate.ts";

function fakeDocuments(): SchemaDocumentMap {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    // A distinct object per schema name (not a real JSON Schema - these tests only
    // care about registry bookkeeping, not schema content) so identity comparisons
    // below cannot pass by accident.
    documents[name] = { $id: `fake://${name}`, type: "object" } as SchemaObject;
  }
  return documents;
}

test("getDocument returns the exact injected document object for a known name", () => {
  const documents = fakeDocuments();
  const registry = new SchemaRegistry(documents);
  for (const name of SCHEMA_NAMES) {
    assert.equal(registry.getDocument(name), documents[name], `expected getDocument('${name}') to return the same object reference`);
  }
});

test("getDocument throws the same 'Unknown schema name' text as get() for an unknown name", () => {
  const documents = fakeDocuments();
  const registry = new SchemaRegistry(documents);
  const unknownName = "not-a-real-schema" as unknown as (typeof SCHEMA_NAMES)[number];

  assert.throws(
    () => registry.getDocument(unknownName),
    (error: unknown) => error instanceof Error && error.message === `Unknown schema name 'not-a-real-schema'. Known schemas: ${SCHEMA_NAMES.join(", ")}`,
  );
  assert.throws(
    () => registry.get(unknownName),
    (error: unknown) => error instanceof Error && error.message === `Unknown schema name 'not-a-real-schema'. Known schemas: ${SCHEMA_NAMES.join(", ")}`,
  );
});
