// Covers the N1/N2/N4 hardening in readJsonFile (configCommand.ts): rejecting
// non-object JSON top-level values, treating a directory like PowerShell's
// `Test-Path -PathType Leaf` (not a "leaf"), and stripping a leading UTF-8 BOM the
// way `Get-Content -Raw` does.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { parseSetStepOverrides, readJsonFile, resolveCliConfig } from "./configCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const platform = getPlatform();
const schemas = loadSchemaRegistry();

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "hdo-configCommand-test-"));
}

test("readJsonFile throws 'JSON file was not found' for a missing path", () => {
  const dir = makeTempDir();
  try {
    const missing = join(dir, "does-not-exist.json");
    assert.throws(() => readJsonFile(missing), new RegExp(`JSON file was not found: .*does-not-exist\\.json`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile throws 'JSON file was not found' for a directory (Test-Path -PathType Leaf semantics)", () => {
  const dir = makeTempDir();
  try {
    const subdir = join(dir, "a-directory.json");
    mkdirSync(subdir);
    assert.throws(() => readJsonFile(subdir), new RegExp(`JSON file was not found: .*a-directory\\.json`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, content] of [
  ["a JSON array", "[]"],
  ["a JSON number", "42"],
  ["a JSON string", '"hello"'],
  ["JSON null", "null"],
  ["a JSON boolean", "true"],
] as const) {
  test(`readJsonFile rejects ${label} with 'expected a JSON object'`, () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "overlay.json");
      writeFileSync(path, content, "utf8");
      assert.throws(() => readJsonFile(path), new RegExp(`Invalid JSON in '.*overlay\\.json': expected a JSON object`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("readJsonFile still throws the JSON parse error message for malformed JSON", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "malformed.json");
    writeFileSync(path, "{not valid json", "utf8");
    assert.throws(() => readJsonFile(path), new RegExp(`Invalid JSON in '.*malformed\\.json': `));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile strips a leading UTF-8 BOM before parsing", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "bom.json");
    writeFileSync(path, "\uFEFF" + JSON.stringify({ workflow: { maxFixAttempts: 3 } }), "utf8");
    const result = readJsonFile(path);
    assert.deepEqual(result, { workflow: { maxFixAttempts: 3 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonFile accepts a plain JSON object", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify({ a: 1 }), "utf8");
    assert.deepEqual(readJsonFile(path), { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- parseSetStepOverrides (hdo.ps1:93-99) -----------------------------------------

test("parseSetStepOverrides: parses one step=runner entry per step name", () => {
  assert.deepEqual(parseSetStepOverrides(["plan=my-planner", "fix=my-fixer"]), { plan: "my-planner", fix: "my-fixer" });
});

test("parseSetStepOverrides: step names are matched case-insensitively (hdo.ps1's -notmatch has no /i, but PS regex is case-insensitive by default)", () => {
  assert.deepEqual(parseSetStepOverrides(["IMPLEMENT=custom-runner"]), { IMPLEMENT: "custom-runner" });
});

test("parseSetStepOverrides: empty input yields an empty object", () => {
  assert.deepEqual(parseSetStepOverrides([]), {});
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const bad of ["plan", "plan=", "bogus=runner", "plan=has space", "plan=has/slash"]) {
  test(`parseSetStepOverrides: rejects '${bad}' with "Invalid -SetStep '<value>'. Expected step=runner."`, () => {
    // Unanchored (no `^...$`): `assert.throws` matches a RegExp against
    // `String(error)` ("Error: <message>"), not just `.message` (same convention as
    // `src/core/config/projectContract.test.ts`).
    assert.throws(() => parseSetStepOverrides([bad]), new RegExp(`Invalid -SetStep '${escapeRegExp(bad)}'\\. Expected step=runner\\.`));
  });
}

// --- resolveCliConfig: profile/stepOverrides overrides (used by selectIssue's route-hint re-resolution) --

test("resolveCliConfig: an explicit `profile` option overrides `parsed.profile`", async () => {
  const dir = makeTempDir();
  try {
    const overlayPath = join(dir, "overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        profiles: {
          mock: { steps: { plan: "claude-planner", implement: "claude-implementer", review: "claude-reviewer", fix: "claude-implementer" } },
        },
      }),
      "utf8",
    );
    const parsed = parseArgs(["config", "-Config", overlayPath, "-RepositoryPath", REPO_ROOT]);
    assert.equal(parsed.profile, undefined);
    const resolved = await resolveCliConfig({ parsed, platform, schemas, profile: "mock" });
    assert.equal(resolved.resolvedProfile, "mock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCliConfig: `stepOverrides` are applied on top of the resolved profile's steps", async () => {
  const parsed = parseArgs(["config", "-RepositoryPath", REPO_ROOT]);
  // `plan` requires a read-only runner; `claude-reviewer` (also read-only, but
  // distinct from the default profile's `claude-planner`) satisfies that constraint.
  const resolved = await resolveCliConfig({ parsed, platform, schemas, stepOverrides: parseSetStepOverrides(["plan=claude-reviewer"]) });
  assert.equal((resolved.steps as { plan: string }).plan, "claude-reviewer");
  // Unmentioned steps are untouched.
  assert.equal((resolved.steps as { implement: string }).implement, "claude-implementer");
});

test("resolveCliConfig: absent `profile`/`stepOverrides` behaves exactly like before (parsed.profile only, no -SetStep)", async () => {
  const parsed = parseArgs(["config", "-RepositoryPath", REPO_ROOT]);
  const resolved = await resolveCliConfig({ parsed, platform, schemas });
  assert.equal(resolved.resolvedProfile, "claude-only");
  assert.equal((resolved.steps as { implement: string }).implement, "claude-implementer");
});
