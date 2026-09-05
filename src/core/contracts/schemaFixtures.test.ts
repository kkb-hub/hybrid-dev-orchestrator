// AC-01/ADR-0001 phase 1 exit condition: reproduces tests/test-schemas.ps1's case
// table EXACTLY (9 valid + 5 invalid, by explicit list - not filename inference, so
// this test cannot silently drift from the PowerShell oracle if a fixture is
// renamed), plus the two ADR-required config/examples/*.json files test-schemas.ps1
// does not cover. A separate test enumerates every file under
// tests/fixtures/schema/ and config/examples/ and fails if one is not covered by any
// case, so a new fixture cannot be silently skipped.
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileSchema, type SchemaObject } from "./validate.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas");
const SCHEMA_FIXTURES_DIR = resolve(REPO_ROOT, "tests", "fixtures", "schema");
const CONFIG_DIR = resolve(REPO_ROOT, "config");
const CONFIG_EXAMPLES_DIR = resolve(CONFIG_DIR, "examples");
const PROJECT_CONTRACT_PATH = resolve(REPO_ROOT, ".hdo", "project.json");

interface Case {
  name: string;
  path: string;
  schemaName: string;
  expectedValid: boolean;
}

// Copied verbatim from tests/test-schemas.ps1's $validCases/$invalidCases tables
// (9 valid + 5 invalid) - do not derive this from a filename pattern.
const CASES: Case[] = [
  { name: "default config", path: resolve(CONFIG_DIR, "hdo.default.json"), schemaName: "hdo-config", expectedValid: true },
  { name: "cloud-only config", path: resolve(CONFIG_EXAMPLES_DIR, "cloud-only.json"), schemaName: "hdo-config", expectedValid: true },
  { name: "Ollama hybrid config", path: resolve(CONFIG_EXAMPLES_DIR, "ollama-hybrid.json"), schemaName: "hdo-config", expectedValid: true },
  {
    name: "repository Ollama hybrid routing config",
    path: resolve(CONFIG_EXAMPLES_DIR, "repository-ollama-hybrid.json"),
    schemaName: "hdo-repository-config",
    expectedValid: true,
  },
  { name: "project contract", path: PROJECT_CONTRACT_PATH, schemaName: "project-contract", expectedValid: true },
  { name: "issue contract fixture", path: resolve(SCHEMA_FIXTURES_DIR, "issue.valid.json"), schemaName: "issue-contract", expectedValid: true },
  { name: "task contract fixture", path: resolve(SCHEMA_FIXTURES_DIR, "task.valid.json"), schemaName: "task-contract", expectedValid: true },
  { name: "worker result fixture", path: resolve(SCHEMA_FIXTURES_DIR, "worker.valid.json"), schemaName: "worker-result", expectedValid: true },
  { name: "review result fixture", path: resolve(SCHEMA_FIXTURES_DIR, "review.valid.json"), schemaName: "review-result", expectedValid: true },
  {
    name: "repository config rejects executable commands",
    path: resolve(SCHEMA_FIXTURES_DIR, "repository-config.invalid-command.json"),
    schemaName: "hdo-repository-config",
    expectedValid: false,
  },
  {
    name: "repository config rejects environment forwarding",
    path: resolve(SCHEMA_FIXTURES_DIR, "repository-config.invalid-environment.json"),
    schemaName: "hdo-repository-config",
    expectedValid: false,
  },
  {
    name: "request_changes rejects empty findings",
    path: resolve(SCHEMA_FIXTURES_DIR, "review.invalid-request-changes-empty.json"),
    schemaName: "review-result",
    expectedValid: false,
  },
  {
    name: "approve rejects an open blocker",
    path: resolve(SCHEMA_FIXTURES_DIR, "review.invalid-approve-open-blocker.json"),
    schemaName: "review-result",
    expectedValid: false,
  },
  {
    name: "non-escalate rejects missing viewpoints",
    path: resolve(SCHEMA_FIXTURES_DIR, "review.invalid-missing-viewpoint-non-escalate.json"),
    schemaName: "review-result",
    expectedValid: false,
  },
];

// tests/test-schemas.ps1's own table only covers 2 of the 5 config/examples/*.json
// files (cloud-only, ollama-hybrid) as standalone hdo-config documents;
// repository-ollama-hybrid is a repository config (see CASES above), not an
// hdo-config. ollama-lean-worker.json is ALSO a complete, standalone hdo-config
// document (it declares every required top-level key), so it is added here as a
// standalone case even though test-schemas.ps1 does not cover it.
//
// claude-only.json IS included below - as an INVALID standalone case, not a
// missing one: unlike ollama-lean-worker.json, it declares only
// schemaVersion/activeProfile/profiles/runners and omits
// github/workflow/paths/projectContractPath entirely - by design, it exists to be
// layered onto config/hdo.default.json via `-Config`, not to stand alone, and
// PowerShell `Test-Json` rejects it standalone for exactly that reason. The
// merged-with-default case below (and the -Config-based CLI parity test) is the
// correct place to prove it actually works as shipped once layered.
const ADDITIONAL_HDO_CONFIG_EXAMPLE_CASES: Case[] = [
  {
    name: "ollama-lean-worker example",
    path: resolve(CONFIG_EXAMPLES_DIR, "ollama-lean-worker.json"),
    schemaName: "hdo-config",
    expectedValid: true,
  },
  // claude-only.json standalone (NOT merged onto config/hdo.default.json) is
  // PowerShell `Test-Json`'s own verdict for this file too: it is a partial overlay
  // (only schemaVersion/activeProfile/profiles/runners) and is missing
  // github/workflow/paths/projectContractPath, which hdo-config.schema.json requires
  // at the top level. This case documents that standalone verdict explicitly; its
  // valid, intended use (layered via `-Config`) is covered by the dedicated
  // "merged onto config/hdo.default.json" test above.
  {
    name: "claude-only example (standalone, not merged) is schema-invalid",
    path: resolve(CONFIG_EXAMPLES_DIR, "claude-only.json"),
    schemaName: "hdo-config",
    expectedValid: false,
  },
];

const ALL_CASES = [...CASES, ...ADDITIONAL_HDO_CONFIG_EXAMPLE_CASES];

test("claude-only example validates against hdo-config once merged onto config/hdo.default.json (its intended use via -Config)", async () => {
  const { deepMergeConfig } = await import("../config/merge.ts");
  const defaultConfig = (await loadJson(resolve(CONFIG_DIR, "hdo.default.json"))) as import("./types.ts").JsonObject;
  const overlay = (await loadJson(resolve(CONFIG_EXAMPLES_DIR, "claude-only.json"))) as import("./types.ts").JsonObject;
  const merged = deepMergeConfig(defaultConfig, overlay);
  const schema = (await loadJson(resolve(SCHEMAS_DIR, "hdo-config.schema.json"))) as SchemaObject;
  const result = compileSchema(schema)(merged);
  assert.equal(result.valid, true, `expected merged config to validate: ${result.errors.join("; ")}`);
});

test("schema fixture cases table has at least the 9 valid + 5 invalid cases from test-schemas.ps1", () => {
  assert.ok(CASES.length >= 14, `expected at least 14 cases (9 valid + 5 invalid), found ${CASES.length}`);
  assert.equal(CASES.filter((c) => c.expectedValid).length, 9);
  assert.equal(CASES.filter((c) => !c.expectedValid).length, 5);
});

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("every case validates with the same valid/invalid outcome as tests/test-schemas.ps1", async () => {
  const schemaCache = new Map<string, ReturnType<typeof compileSchema>>();
  const failures: string[] = [];

  for (const testCase of ALL_CASES) {
    let validate = schemaCache.get(testCase.schemaName);
    if (!validate) {
      const schema = (await loadJson(resolve(SCHEMAS_DIR, `${testCase.schemaName}.schema.json`))) as SchemaObject;
      validate = compileSchema(schema);
      schemaCache.set(testCase.schemaName, validate);
    }
    const data = await loadJson(testCase.path);
    const result = validate(data);
    if (result.valid !== testCase.expectedValid) {
      failures.push(
        `${testCase.name} (${testCase.path}) against ${testCase.schemaName}.schema.json: expected valid=${testCase.expectedValid}, got valid=${result.valid} (errors: ${result.errors.join("; ")})`,
      );
    }
  }

  assert.deepEqual(failures, [], `schema fixture mismatches:\n${failures.join("\n")}`);
});

test("every file under tests/fixtures/schema/ is covered by a case (no fixture can be silently skipped)", async () => {
  const entries = await readdir(SCHEMA_FIXTURES_DIR);
  const coveredPaths = new Set(CASES.map((c) => c.path));
  const uncovered = entries
    .map((entry) => resolve(SCHEMA_FIXTURES_DIR, entry))
    .filter((path) => !coveredPaths.has(path));
  assert.deepEqual(uncovered, [], `uncovered fixture(s) under tests/fixtures/schema/:\n${uncovered.join("\n")}`);
});

test("every file under config/examples/ is covered by a case (no example can be silently skipped)", async () => {
  const entries = await readdir(CONFIG_EXAMPLES_DIR);
  const coveredPaths = new Set(ALL_CASES.map((c) => c.path));
  const uncovered = entries
    .map((entry) => resolve(CONFIG_EXAMPLES_DIR, entry))
    .filter((path) => !coveredPaths.has(path));
  assert.deepEqual(uncovered, [], `uncovered example(s) under config/examples/:\n${uncovered.join("\n")}`);
});
