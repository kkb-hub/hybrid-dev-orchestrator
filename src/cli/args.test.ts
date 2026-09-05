import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseArgs } from "./args.ts";

test("parseArgs reads the first positional as the command", () => {
  const parsed = parseArgs(["config"]);
  assert.equal(parsed.command, "config");
});

test("parseArgs recognizes -Json as a switch, case-insensitively", () => {
  assert.equal(parseArgs(["config", "-Json"]).json, true);
  assert.equal(parseArgs(["config", "-json"]).json, true);
  assert.equal(parseArgs(["config", "-JSON"]).json, true);
  assert.equal(parseArgs(["config"]).json, false);
});

test("parseArgs also accepts a GNU-style -- alias", () => {
  assert.equal(parseArgs(["config", "--json"]).json, true);
});

// Repeated -Config is a deliberate TypeScript-only extension: PowerShell's
// [CmdletBinding()] parameter binder rejects ANY repeated named parameter with a
// binding error (exit 1) rather than concatenating it - even though -Config is
// declared [string[]] (array-typed), a second `-Config` is still rejected
// ("parameter 'Config' is specified more than once"); PowerShell arrays are for
// comma-separating a SINGLE occurrence's value, not for repeating the flag. ADR-0001
// permits TS's repetition-with-concatenation as a superset since every existing
// invocation (single -Config) still behaves identically. See docs/architecture.md 16
// "PowerShell 実装との意図的な差異".
test("parseArgs splits a comma-separated -Config value and supports repetition (TypeScript-only superset, see comment above)", () => {
  const parsed = parseArgs(["config", "-Config", "a.json,b.json", "-Config", "c.json"]);
  assert.deepEqual(parsed.config, ["a.json", "b.json", "c.json"]);
});

test("parseArgs trims whitespace around comma-separated -Config entries", () => {
  const parsed = parseArgs(["config", "-Config", " a.json , b.json "]);
  assert.deepEqual(parsed.config, ["a.json", "b.json"]);
});

test("parseArgs supports --config=value inline syntax", () => {
  const parsed = parseArgs(["config", "--config=a.json,b.json"]);
  assert.deepEqual(parsed.config, ["a.json", "b.json"]);
});

test("parseArgs reads -Profile's value", () => {
  assert.equal(parseArgs(["config", "-Profile", "cloud-only"]).profile, "cloud-only");
});

test("parseArgs supports repeated -SetStep as raw strings", () => {
  const parsed = parseArgs(["run", "-SetStep", "implement=runner-a", "-SetStep", "fix=runner-b"]);
  assert.deepEqual(parsed.setStep, ["implement=runner-a", "fix=runner-b"]);
});

test("parseArgs recognizes -IgnoreRepositoryConfig", () => {
  assert.equal(parseArgs(["config", "-IgnoreRepositoryConfig"]).ignoreRepositoryConfig, true);
});

test("parseArgs defaults -RepositoryPath to the current working directory", () => {
  const parsed = parseArgs(["config"]);
  assert.equal(parsed.repositoryPath, process.cwd());
});

test("parseArgs reads -RepositoryPath's value", () => {
  assert.equal(parseArgs(["config", "-RepositoryPath", "/some/repo"]).repositoryPath, "/some/repo");
});

test("parseArgs reads -Issue as a number", () => {
  assert.equal(parseArgs(["run", "-Issue", "42"]).issue, 42);
});

test("parseArgs throws on a non-numeric -Issue value", () => {
  assert.throws(() => parseArgs(["run", "-Issue", "not-a-number"]), /Invalid -Issue value 'not-a-number'\./);
});

test("parseArgs recognizes -Pick/-DryRun/-NoWriteBack/-Apply/-Force/-WhatIf switches", () => {
  const parsed = parseArgs(["run", "-Pick", "-DryRun", "-NoWriteBack", "-Apply", "-Force", "-WhatIf"]);
  assert.equal(parsed.pick, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.noWriteBack, true);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.force, true);
  assert.equal(parsed.whatIf, true);
});

test("parseArgs reads -Repository and -RunId values", () => {
  const parsed = parseArgs(["status", "-Repository", "owner/repo", "-RunId", "run-123"]);
  assert.equal(parsed.repository, "owner/repo");
  assert.equal(parsed.runId, "run-123");
});

test("parseArgs throws on an unknown option", () => {
  assert.throws(() => parseArgs(["config", "-Bogus"]), /Unknown option '-Bogus'\./);
});

test("parseArgs collects positionals after the command", () => {
  const parsed = parseArgs(["config", "extra1", "extra2"]);
  assert.equal(parsed.command, "config");
  assert.deepEqual(parsed.positionals, ["extra1", "extra2"]);
});
