import { strict as assert } from "node:assert";
import { test } from "node:test";
import { expandArgumentTemplate } from "./argumentTemplate.ts";

// Oracle: tests/run-tests.ps1:893, "command argument templates can explicitly consume contextTokens".
test("expandArgumentTemplate substitutes a numeric token into a stringified argument", () => {
  assert.equal(expandArgumentTemplate("--context={contextTokens}", { contextTokens: 8192 }), "--context=8192");
});

// Oracle: tests/run-tests.ps1:901, "command argument templates can locate files shipped alongside HDO".
test("expandArgumentTemplate substitutes {hdoRoot} without treating '/' as a path-joining operator", () => {
  assert.equal(
    expandArgumentTemplate("{hdoRoot}/workers/hdo-ollama-worker.ps1", { hdoRoot: "C:\\install\\hdo" }),
    "C:\\install\\hdo/workers/hdo-ollama-worker.ps1",
  );
});

// Oracle: Runner.ps1:33, `$expanded.Replace(...)` replaces every literal occurrence of
// `{key}`, not just the first.
test("a token appearing twice in the template is replaced at every occurrence", () => {
  assert.equal(expandArgumentTemplate("{x}-{x}", { x: "a" }), "a-a");
});

// Oracle: Runner.ps1:33, only keys present in `Tokens` are substituted - an unknown
// placeholder is left untouched.
test("an unknown {token} placeholder is left untouched", () => {
  assert.equal(expandArgumentTemplate("--flag={unknown}", { contextTokens: 1 }), "--flag={unknown}");
});

// Oracle: Runner.ps1:33, `[string]$Tokens[$key]` - PowerShell's `[string]` cast of
// `$null` is the empty string.
test("a null token value expands to the empty string", () => {
  assert.equal(expandArgumentTemplate("--model={model}", { model: null }), "--model=");
});

test("an undefined token value also expands to the empty string", () => {
  assert.equal(expandArgumentTemplate("--model={model}", { model: undefined }), "--model=");
});

test("a template with no matching tokens is returned unchanged", () => {
  assert.equal(expandArgumentTemplate("--fixed-flag", {}), "--fixed-flag");
});
