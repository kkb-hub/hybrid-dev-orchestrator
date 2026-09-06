// Pure port of `Get-HdoOllamaContextModelName` (Runner.ps1:373-388): derives a
// deterministic Ollama model tag for a given (model, contextTokens) pair.
//
// Deterministic so repeated runs with the same (model, contextTokens) pair reuse the
// same tag: `ollama create` on an unchanged Modelfile is a fast metadata-only
// overwrite, not a new copy of the model weights. Sanitizing `model` for the tag is
// lossy (e.g. `qwen:3` and `qwen-3` both sanitize to `qwen-3`), so a short hash of the
// exact original model string is appended to keep distinct models from colliding onto,
// and silently overwriting, the same derived model name.
//
// `sha256Hex` is injected rather than imported from `node:crypto` directly: this file
// lives under `src/core/**`, which `boundary.test.ts` forbids from importing any
// `node:crypto`/`node:fs`/`node:os`/`node:child_process` module (ADR-0001 phase 5 plan
// §7 risk 17). The host module (`src/runners/ollamaContextModel.ts`) supplies the real
// `sha256Hex` (from `src/git/index.ts`, itself backed by `node:crypto`).
//
// PS `[regex]::Replace($Model, '[^a-zA-Z0-9._-]', '-')` and JS
// `model.replace(/[^a-zA-Z0-9._-]/g, '-')` agree for every BMP character: both replace
// per UTF-16 code unit, and the character class here contains only ASCII code points,
// so there is no .NET-vs-JS regex divergence to document for this specific pattern
// (contrast the broader caveats in `core/process/redact.ts`'s banner, which apply to
// patterns with Unicode-sensitive classes like `\s`).
//
// Oracle value pinned in `ollamaContextModelName.test.ts` (pwsh 7.6.5, this worktree):
// `Get-HdoOllamaContextModelName -Model 'qwen3.8:27b-q4_K_M' -ContextTokens 65536` ->
// `hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536`.
export function getOllamaContextModelName(
  model: string,
  contextTokens: number,
  sha256Hex: (text: string) => string,
): string {
  const sanitized = model.replace(/[^a-zA-Z0-9._-]/g, "-");
  const modelHash = sha256Hex(model).slice(0, 8);
  return `hdo-ctx-${sanitized}-${modelHash}-${contextTokens}`;
}
