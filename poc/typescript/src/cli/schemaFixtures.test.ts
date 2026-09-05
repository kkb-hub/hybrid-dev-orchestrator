// AC-03: validate every fixture under tests/fixtures/schema/ against the real,
// unmodified schema files, and assert the valid/invalid outcome documented by
// tests/test-schemas.ps1 (the PowerShell suite's own source of truth for this
// mapping): "*.valid.json" must validate, "*.invalid-*.json" must not.
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { compileSchema, type SchemaObject } from "../core/contracts/validate.ts";
import { SCHEMAS_DIR, SCHEMA_FIXTURES_DIR } from "./paths.ts";

// Fixture filename prefix -> schema file basename (without ".schema.json"), copied
// from the case table in tests/test-schemas.ps1.
const SCHEMA_BY_FIXTURE_PREFIX: Record<string, string> = {
  issue: "issue-contract",
  task: "task-contract",
  worker: "worker-result",
  review: "review-result",
  "repository-config": "hdo-repository-config",
};

interface FixtureCase {
  fileName: string;
  schemaName: string;
  expectedValid: boolean;
}

function classifyFixture(fileName: string): FixtureCase | undefined {
  const validMatch = fileName.match(/^(.+)\.valid\.json$/);
  if (validMatch) {
    const prefix = validMatch[1];
    const schemaName = SCHEMA_BY_FIXTURE_PREFIX[prefix];
    if (!schemaName) return undefined;
    return { fileName, schemaName, expectedValid: true };
  }
  const invalidMatch = fileName.match(/^(.+)\.invalid-.+\.json$/);
  if (invalidMatch) {
    const prefix = invalidMatch[1];
    const schemaName = SCHEMA_BY_FIXTURE_PREFIX[prefix];
    if (!schemaName) return undefined;
    return { fileName, schemaName, expectedValid: false };
  }
  return undefined;
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("every schema fixture validates with the expected valid/invalid outcome", async () => {
  const entries = await readdir(SCHEMA_FIXTURES_DIR);
  const cases = entries.map(classifyFixture).filter((entry): entry is FixtureCase => entry !== undefined);

  // Guard against a silently-empty test: this must cover at least the 9 fixture
  // files present at the time this PoC was written.
  assert.ok(cases.length >= 9, `expected at least 9 classified fixtures, found ${cases.length} among ${entries.join(", ")}`);

  const schemaCache = new Map<string, ReturnType<typeof compileSchema>>();
  const failures: string[] = [];

  for (const testCase of cases) {
    let validate = schemaCache.get(testCase.schemaName);
    if (!validate) {
      const schema = (await loadJson(join(SCHEMAS_DIR, `${testCase.schemaName}.schema.json`))) as SchemaObject;
      validate = compileSchema(schema);
      schemaCache.set(testCase.schemaName, validate);
    }
    const data = await loadJson(join(SCHEMA_FIXTURES_DIR, testCase.fileName));
    const result = validate(data);
    if (result.valid !== testCase.expectedValid) {
      failures.push(
        `${testCase.fileName} against ${testCase.schemaName}.schema.json: expected valid=${testCase.expectedValid}, got valid=${result.valid} (errors: ${result.errors.join("; ")})`,
      );
    }
  }

  assert.deepEqual(failures, [], `schema fixture mismatches:\n${failures.join("\n")}`);
});

test("the default config and this repository's project contract validate against their schemas", async () => {
  const { CONFIG_DEFAULT_PATH, REPO_ROOT } = await import("./paths.ts");
  const configSchema = (await loadJson(join(SCHEMAS_DIR, "hdo-config.schema.json"))) as SchemaObject;
  const config = await loadJson(CONFIG_DEFAULT_PATH);
  assert.equal(compileSchema(configSchema)(config).valid, true);

  const projectContractSchema = (await loadJson(join(SCHEMAS_DIR, "project-contract.schema.json"))) as SchemaObject;
  const projectContract = await loadJson(join(REPO_ROOT, ".hdo", "project.json"));
  assert.equal(compileSchema(projectContractSchema)(projectContract).valid, true);
});
