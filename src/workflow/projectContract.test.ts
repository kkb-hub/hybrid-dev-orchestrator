// Covers `loadProjectContract`'s own file-reading/schema-validating half (the pure
// post-validation checks it delegates to - schemaVersion, gate id uniqueness, etc -
// are already covered by src/core/config/projectContract.test.ts against
// `checkProjectContract` directly).
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { loadProjectContract } from "./projectContract.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const SCHEMAS_DIR = resolvePath(REPO_ROOT, "schemas");

function loadSchemas(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(resolvePath(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const schemas = loadSchemas();

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "hdo-projectContract-test-"));
}

test("loadProjectContract throws 'Project contract was not found: <path>' for a missing path", () => {
  const dir = makeTempDir();
  try {
    const missing = join(dir, "does-not-exist.json");
    assert.throws(() => loadProjectContract(missing, schemas), new RegExp(`Project contract was not found: .*does-not-exist\\.json$`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContract throws the 'Invalid JSON in ...' text for malformed JSON", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "malformed.json");
    writeFileSync(path, "{not valid json", "utf8");
    assert.throws(() => loadProjectContract(path, schemas), new RegExp(`Invalid JSON in '.*malformed\\.json': `));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContract throws the schema-validation-failed prefix for a schema-invalid contract", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "invalid-contract.json");
    // Missing every required top-level property (schemaVersion, validationGates, ...).
    writeFileSync(path, JSON.stringify({}), "utf8");
    assert.throws(
      () => loadProjectContract(path, schemas),
      new RegExp(`Project contract schema validation failed for '.*invalid-contract\\.json': `),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContract loads this repository's own .hdo/project.json and reports 2 validation gates", () => {
  const path = resolvePath(REPO_ROOT, ".hdo", "project.json");
  const contract = loadProjectContract(path, schemas);
  assert.equal(contract.schemaVersion, 1);
  assert.ok(Array.isArray(contract.validationGates));
  assert.equal((contract.validationGates as unknown[]).length, 2);
});
