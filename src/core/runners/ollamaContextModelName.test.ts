import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getOllamaContextModelName } from "./ollamaContextModelName.ts";

// Same as `src/git/index.ts`'s `sha256Hex` (Get-HdoSha256, Common.ps1): UTF-8 bytes,
// lowercase hex SHA-256. Reimplemented here (rather than imported from `src/git/`)
// because this is a `src/core/**` test file and must not depend on a host module -
// `node:crypto` itself is fine to import from a `*.test.ts` file (boundary.test.ts
// only scans non-test source under `src/core/**`).
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("getOllamaContextModelName matches the pwsh oracle exactly", () => {
  // Oracle: tests/run-tests.ps1:541-545, "Get-HdoOllamaContextModelName sanitizes the
  // model ID into a deterministic derived model tag" - pinned value captured via
  // `pwsh -NoProfile -Command "Import-Module ./src/HybridDevOrchestrator/HybridDevOrchestrator.psd1; & (Get-Module HybridDevOrchestrator) { Get-HdoOllamaContextModelName -Model 'qwen3.8:27b-q4_K_M' -ContextTokens 65536 }"`
  // on this worktree (pwsh 7.6.5): `hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536`.
  const result = getOllamaContextModelName("qwen3.8:27b-q4_K_M", 65536, sha256Hex);
  assert.equal(result, "hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536");
  assert.match(result, /^hdo-ctx-qwen3\.8-27b-q4_K_M-[0-9a-f]{8}-65536$/);
});

test("getOllamaContextModelName is deterministic for the same model and contextTokens", () => {
  // Oracle: tests/run-tests.ps1:546-550, "Get-HdoOllamaContextModelName is
  // deterministic for the same model and contextTokens".
  const first = getOllamaContextModelName("qwen3.8:27b-q4_K_M", 65536, sha256Hex);
  const second = getOllamaContextModelName("qwen3.8:27b-q4_K_M", 65536, sha256Hex);
  assert.equal(first, second);
});

test("getOllamaContextModelName keeps colliding-sanitized model IDs from colliding on the same derived name", () => {
  // Oracle: tests/run-tests.ps1:551-556, "Get-HdoOllamaContextModelName keeps model
  // IDs that sanitize to the same text from colliding on the same derived model" -
  // `qwen3.8:27b-q4_K_M` and `qwen3.8-27b-q4_K_M` both sanitize to
  // `qwen3.8-27b-q4_K_M` (the ':' becomes '-', which was already '-'), but their
  // SHA-256 hashes differ, so the derived names differ too.
  const withColon = getOllamaContextModelName("qwen3.8:27b-q4_K_M", 65536, sha256Hex);
  const withDash = getOllamaContextModelName("qwen3.8-27b-q4_K_M", 65536, sha256Hex);
  assert.equal("qwen3.8:27b-q4_K_M".replace(/[^a-zA-Z0-9._-]/g, "-"), "qwen3.8-27b-q4_K_M");
  assert.notEqual(withColon, withDash);
});

test("getOllamaContextModelName sanitizes every non [a-zA-Z0-9._-] character", () => {
  // "weird model/name@v1!" sanitizes to "weird-model-name-v1-" (the trailing '!'
  // becomes a trailing '-'); the template's own literal '-' joining it to the hash
  // then produces a double dash ("v1--<hash>"), exactly like the PS
  // `"hdo-ctx-$sanitized-$modelHash-$ContextTokens"` string interpolation would.
  const result = getOllamaContextModelName("weird model/name@v1!", 4096, sha256Hex);
  assert.match(result, /^hdo-ctx-weird-model-name-v1--[0-9a-f]{8}-4096$/);
});

test("getOllamaContextModelName embeds contextTokens verbatim", () => {
  const result = getOllamaContextModelName("llama3", 8192, sha256Hex);
  assert.ok(result.endsWith("-8192"));
});
