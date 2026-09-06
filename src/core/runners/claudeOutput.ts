// Ports `ConvertFrom-HdoClaudeOutput` and the pure part of
// `Resolve-HdoOllamaStructuredOutput` (Runner.ps1:416-429, 431-487). The host (WP-E)
// owns the impure parts: writing `result.original.txt`/`recovery.input.txt`/
// `recovery.output.txt`/`structured-output.json` to the artifact directory, and
// throwing `ollamaRecoveryRejectedMessage(...)` only AFTER those artifacts are
// written.
import { getValue } from "../config/value.ts";
import type { JsonValue } from "../contracts/types.ts";
import { asString, equalsIgnoreCase, isPlainObject } from "./psSemantics.ts";
import { getClaudeFailureDetail } from "./failureDetail.ts";

/**
 * Port of `ConvertFrom-HdoClaudeOutput` (Runner.ps1:416-429). A `JSON.parse` failure
 * propagates to the caller uncaught, matching PS's un-try-caught `ConvertFrom-Json`
 * (the host wraps it as `Claude step '<step>' returned invalid envelope JSON: <message>`).
 */
export function extractClaudeOutput(envelopeJson: string): string {
  const envelope = JSON.parse(envelopeJson) as JsonValue;
  if (isPlainObject(envelope)) {
    if (Object.prototype.hasOwnProperty.call(envelope, "structured_output") && envelope.structured_output !== null) {
      const structuredOutput = envelope.structured_output;
      return typeof structuredOutput === "string" ? structuredOutput : JSON.stringify(structuredOutput);
    }
    if (Object.prototype.hasOwnProperty.call(envelope, "result")) {
      const result = envelope.result;
      return typeof result === "string" ? result : JSON.stringify(result);
    }
  }
  // Non-object envelope (array/primitive) falls through to the same branch as a plain
  // object with neither `structured_output` nor `result`: the whole envelope, compact.
  return JSON.stringify(envelope);
}

export interface OllamaRecoveryDiagnostic {
  classification: "structured-output noncompliance";
  strategy: "single-object-after-plain-prose-v1";
  maximumAttempts: 1;
  attempts: 1;
  originalValidationError: string | null;
  recovery: "succeeded" | "rejected";
  finalValidationError: string | null;
}

export type OllamaRecoveryOutcome =
  | { kind: "valid"; finalJson: string }
  | {
      kind: "recovered" | "rejected";
      finalJson: string;
      original: string;
      candidate: string;
      diagnostic: OllamaRecoveryDiagnostic;
    };

export interface JsonValidationResult {
  valid: boolean;
  error: string | null;
}

// Require a newline before the object and plain prose without JSON/container, quoting,
// or fence delimiters (short inline code tokens are allowed). PS `\A`/`\z` (no `m`
// flag) become `^`/`$` here (ADR-0001 phase 5 plan §7 risk 7); `\x60` is the backtick.
// Oracle: Runner.ps1:474.
const PREFIX_PATTERN =
  /^(?:(?!`)[\p{L}\p{N}\p{Pd}\p{S}\s.,!?:;()\/_*]|`[\p{L}\p{N} ._\/\\-]+`)+\r?\n[ \t]*$/u;
const HAS_LETTER_PATTERN = /\p{L}/u;

/**
 * Pure part of `Resolve-HdoOllamaStructuredOutput` (Runner.ps1:431-487): parses the
 * envelope and attempts the single-shot "plain-prose-prefix then one JSON object"
 * recovery, without touching the filesystem. `validateJson` mirrors `Test-HdoJsonSchema`
 * (see WP-E) - `{valid:false, error:'Invalid JSON: ' + message}` on a JSON.parse
 * failure, `{valid:false, error:'Schema validation failed: ' + errors.join('; ')}` on
 * an Ajv failure (the tail differs from PS `Test-Json`; only the prefixes are
 * contractual, ADR-0001 phase 5 plan §7 risk 16).
 */
export function recoverOllamaStructuredOutput(
  envelopeJson: string,
  validateJson: (json: string) => JsonValidationResult,
): OllamaRecoveryOutcome {
  const envelope = JSON.parse(envelopeJson) as JsonValue;

  const isError = getValue(envelope, "is_error", false) === true;
  // `asString`'s own null-fallback ("") must NOT be overridden with "success" here: a
  // present `subtype: null` mirrors PS `[string]$null` -> "" (empty), not the
  // `Get-HdoValue` default text, which only ever applies when the key is missing
  // (ADR-0001 phase 5 plan §7 risk 3).
  const subtype = asString(getValue(envelope, "subtype", "success"));
  if (isError || !equalsIgnoreCase(subtype, "success")) {
    throw new Error(`Claude/Ollama envelope failure: ${getClaudeFailureDetail(envelopeJson, "")}`);
  }

  const original = extractClaudeOutput(envelopeJson);
  const validation: JsonValidationResult =
    original.trim() === "" ? { valid: false, error: "Empty structured result." } : validateJson(original);
  if (validation.valid) return { kind: "valid", finalJson: original };

  const diagnostic: OllamaRecoveryDiagnostic = {
    classification: "structured-output noncompliance",
    strategy: "single-object-after-plain-prose-v1",
    maximumAttempts: 1,
    attempts: 1,
    originalValidationError: validation.error,
    recovery: "rejected",
    finalValidationError: "No unambiguous plain-prose prefix followed by one JSON object.",
  };

  let candidate = "";
  const offset = original.indexOf("{");
  const structuredOutputValue = getValue(envelope, "structured_output");
  const resultValue = getValue(envelope, "result");
  const resultSubtypeValue = getValue(envelope, "subtype", "");
  if (
    original.length <= 1048576 &&
    offset > 0 &&
    (structuredOutputValue === undefined || structuredOutputValue === null) &&
    typeof resultValue === "string" &&
    equalsIgnoreCase(asString(resultSubtypeValue), "success") &&
    getValue(envelope, "is_error") === false
  ) {
    const prefix = original.slice(0, offset);
    if (PREFIX_PATTERN.test(prefix) && HAS_LETTER_PATTERN.test(prefix)) {
      candidate = original.slice(offset).trim();
      const candidateValidation = validateJson(candidate);
      diagnostic.finalValidationError = candidateValidation.error;
      if (candidateValidation.valid) diagnostic.recovery = "succeeded";
    }
  }

  return {
    kind: diagnostic.recovery === "succeeded" ? "recovered" : "rejected",
    finalJson: candidate,
    original,
    candidate,
    diagnostic,
  };
}

/**
 * Exact throw text for a rejected recovery (Runner.ps1:484). The host must write
 * `structured-output.json`/`result.original.txt` BEFORE throwing this.
 */
export function ollamaRecoveryRejectedMessage(finalValidationError: string | null): string {
  return `Claude/Ollama structured-output noncompliance; recovery rejected (1/1): ${finalValidationError} See structured-output.json and result.original.txt.`;
}
