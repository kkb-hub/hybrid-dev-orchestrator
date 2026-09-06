// Host port of `Resolve-HdoOllamaContextModel` (Runner.ps1:390-414): bakes a
// `num_ctx` override into a derived Ollama model (via a throwaway Modelfile and
// `ollama create`) and returns the derived model's name. Neither the Claude CLI nor
// Ollama's Anthropic-compatible endpoint exposes a context-window argument or a
// per-request override, so the only reliable lever is a Modelfile-baked `num_ctx` on a
// derived model. `FROM <model>` does not duplicate the underlying weights, so this is
// cheap enough to run before every step.
//
// This is a `src/runners/**` host module, not `src/core/**`: it is allowed
// `node:crypto`/`node:os` (unlike `getOllamaContextModelName`, the pure core function
// it wraps), but process execution happens ONLY through the injected `ProcessRunner`
// (ADR-0001 phase 5 plan §2 boundary), never `node:child_process` directly.
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSafeEnvironment } from "../core/process/safeEnvironment.ts";
import type { ProcessRunner } from "../core/process/types.ts";
import { getOllamaContextModelName } from "../core/runners/ollamaContextModelName.ts";

// Per ADR-0001 phase 5 plan §WP-E1: "sha256Hex from node:crypto (do not import
// src/git)" - `src/git/index.ts` already exports an identically-behaved `sha256Hex`
// (Get-HdoSha256, Common.ps1: UTF-8 bytes, lowercase hex SHA-256), but this module
// deliberately does not depend on `src/git/` for it, to keep the Ollama runner
// decoupled from the git host module.
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ResolveOllamaContextModelOptions {
  runner: ProcessRunner;
  model: string;
  contextTokens: number;
  workingDirectory: string;
  timeoutSeconds: number;
  /** Defaults to `process.env`, matching `Get-HdoSafeEnvironment` with no `-PassEnvironment` override. */
  ambientEnvironment?: Record<string, string | undefined>;
}

/**
 * Derives a per-(model, contextTokens) Ollama model tag (`getOllamaContextModelName`),
 * writes a throwaway Modelfile declaring `FROM <model>` + `PARAMETER num_ctx
 * <contextTokens>`, runs `ollama create <derived> -f <modelfile>` to completion, and
 * always deletes the Modelfile afterwards (even on failure) before returning the
 * derived model's name.
 *
 * Divergence from PowerShell (documented, ADR-0001 phase 5 plan §7 risk 10): PS
 * `Set-Content -Value @("FROM $Model", "PARAMETER num_ctx $ContextTokens") -Encoding
 * utf8NoBOM` joins the two lines with CRLF and appends a trailing CRLF on Windows; this
 * writes LF-joined content with a trailing LF instead. `ollama create` accepts both -
 * this divergence is behaviorally inert.
 *
 * The child process runs with `getSafeEnvironment(ambientEnvironment ?? process.env)`
 * (mirrors `Invoke-HdoProcess -Environment (Get-HdoSafeEnvironment)`): secrets such as
 * `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` are stripped before `ollama` ever sees them.
 *
 * `throwOnError: true` on the injected `ProcessRunner` mirrors PS's
 * `-ThrowOnError`: a non-zero `ollama create` exit code throws
 * `Command 'ollama' failed with exit code <N>. <stderr or stdout, trimmed>`
 * (`NodeProcessRunner`'s `formatProcessFailure` text, `src/process/runner.ts:591-598`),
 * matching `Invoke-HdoProcess -ThrowOnError`'s own throw text exactly.
 */
export async function resolveOllamaContextModel(options: ResolveOllamaContextModelOptions): Promise<string> {
  const derivedName = getOllamaContextModelName(options.model, options.contextTokens, sha256Hex);
  const modelfilePath = join(tmpdir(), `hdo-ollama-modelfile-${randomUUID().replace(/-/g, "")}.txt`);
  const modelfileContent = `FROM ${options.model}\nPARAMETER num_ctx ${options.contextTokens}\n`;

  try {
    await writeFile(modelfilePath, modelfileContent, "utf8");
    await options.runner.run({
      command: "ollama",
      arguments: ["create", derivedName, "-f", modelfilePath],
      workingDirectory: options.workingDirectory,
      timeoutSeconds: options.timeoutSeconds,
      environment: getSafeEnvironment(options.ambientEnvironment ?? process.env),
      throwOnError: true,
    });
  } finally {
    // Mirrors `Remove-Item -LiteralPath $modelfilePath -Force -ErrorAction
    // SilentlyContinue`: best-effort cleanup, errors (including "already gone")
    // swallowed.
    await rm(modelfilePath, { force: true }).catch(() => undefined);
  }
  return derivedName;
}
