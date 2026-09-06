// Host adapter for the impure half of `Resolve-HdoOllamaStructuredOutput`
// (Runner.ps1:431-487): `../core/runners/claudeOutput.ts`'s `recoverOllamaStructuredOutput`
// owns the pure recovery decision (parsing the envelope, extracting the original
// text, attempting the single-shot plain-prose-prefix recovery); this module supplies
// the Ajv-backed `validateJson` closure that decision needs and writes the diagnostic
// artifacts (`result.original.txt`, `recovery.input.txt`, `recovery.output.txt`,
// `structured-output.json`) to the artifact directory BEFORE throwing on a rejected
// recovery, exactly like the PowerShell function does (Set-Content/Write-HdoJsonFile
// calls at Runner.ps1:460-461, 481-484 all happen before the `throw` at :484).
import { join } from "node:path";
import type { JsonValue } from "../core/contracts/types.ts";
import type { CompiledValidator } from "../core/contracts/validate.ts";
import { protectObject, protectText } from "../core/process/redact.ts";
import {
  ollamaRecoveryRejectedMessage,
  recoverOllamaStructuredOutput,
  type JsonValidationResult,
} from "../core/runners/claudeOutput.ts";
import { writeJsonFile, writeTextFile } from "./artifacts.ts";

/**
 * Wraps an Ajv `CompiledValidator` (typically `SchemaRegistry.get(outputSchema)`) into
 * the `validateJson(json: string)` shape `recoverOllamaStructuredOutput` (and the
 * agent-step host's own final structured-output validation) needs: parses `json`,
 * reporting `Invalid JSON: <message>` on a parse failure, otherwise runs the compiled
 * validator and reports `Schema validation failed: <errors>` (joined by `; `) on a
 * schema failure. Mirrors `Test-HdoJsonSchema` (Common.ps1:467-491) - only the message
 * PREFIXES are contractual (ADR-0001 phase 5 plan §7 risk 16); Ajv's own error text
 * differs from PowerShell's `Test-Json`.
 */
export function validateJsonAgainstSchema(json: string, validator: CompiledValidator): JsonValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { valid: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
  const result = validator(parsed);
  return result.valid
    ? { valid: true, error: null }
    : { valid: false, error: `Schema validation failed: ${result.errors.join("; ")}` };
}

export interface ResolveOllamaStructuredOutputArtifactsOptions {
  envelopeJson: string;
  schemaValidator: CompiledValidator;
  artifactDirectory: string;
}

/**
 * Host port of `Resolve-HdoOllamaStructuredOutput` (Runner.ps1:431-487). On a
 * `kind: 'valid'` outcome, writes nothing and returns the original structured text
 * unchanged (PS returns at :447, before any file write). On `recovered`/`rejected`,
 * writes the four diagnostic artifacts - `result.original.txt`/`recovery.input.txt`
 * (both `protectText(original)`, no trailing newline - PS `-NoNewline`),
 * `recovery.output.txt` (`protectText(candidate)`, also no trailing newline), and
 * `structured-output.json` (the redacted diagnostic object, pretty-printed) - and
 * THEN throws `ollamaRecoveryRejectedMessage(...)` for `rejected`, never before the
 * artifacts exist.
 */
export function resolveOllamaStructuredOutputArtifacts(options: ResolveOllamaStructuredOutputArtifactsOptions): string {
  const validateJson = (json: string): JsonValidationResult => validateJsonAgainstSchema(json, options.schemaValidator);
  const outcome = recoverOllamaStructuredOutput(options.envelopeJson, validateJson);
  if (outcome.kind === "valid") return outcome.finalJson;

  writeTextFile(join(options.artifactDirectory, "result.original.txt"), protectText(outcome.original));
  writeTextFile(join(options.artifactDirectory, "recovery.input.txt"), protectText(outcome.original));
  writeTextFile(join(options.artifactDirectory, "recovery.output.txt"), protectText(outcome.candidate));
  writeJsonFile(join(options.artifactDirectory, "structured-output.json"), protectObject(outcome.diagnostic) as JsonValue);

  if (outcome.kind === "rejected") {
    throw new Error(ollamaRecoveryRejectedMessage(outcome.diagnostic.finalValidationError));
  }
  return outcome.finalJson;
}
