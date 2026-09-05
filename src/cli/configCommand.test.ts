// Covers the N1/N2/N4 hardening in readJsonFile (configCommand.ts): rejecting
// non-object JSON top-level values, treating a directory like PowerShell's
// `Test-Path -PathType Leaf` (not a "leaf"), and stripping a leading UTF-8 BOM the
// way `Get-Content -Raw` does.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonFile } from "./configCommand.ts";

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
