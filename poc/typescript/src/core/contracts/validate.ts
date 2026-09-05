// Ajv (draft 2020-12) wrapper. This file is the ONLY place in `core` that is allowed
// to import a runtime dependency (ajv / ajv-formats are pure JS with no filesystem or
// process access, so they do not violate the core/platform boundary).
//
// Ajv options note (see README "Ajv options"): the canonical schemas under `schemas/`
// were authored for PowerShell's `Test-Json` (a .NET/Newtonsoft-based validator) and
// are NOT modified for this PoC. Constructing Ajv with default `strict: true` throws
// at compile time on those schemas (e.g. unevaluated `if`/`then` siblings and numeric
// keyword combinations that Ajv's strict mode flags as likely mistakes even though they
// are valid, intentional JSON Schema 2020-12). We therefore construct Ajv with
// `strict: false`. No schema file is edited to accommodate Ajv.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats ships a `.d.ts` written as an ES `export default`, compiled to a CJS
// file that does `module.exports = exports = formatsPlugin`. Under this project's
// `moduleResolution: nodenext`, TypeScript's static type for the default import ends
// up as the module's namespace type (non-callable) even though the value Node binds
// at runtime IS the callable plugin function (verified: `require("ajv-formats")` is
// a function). This one cast documents and isolates that mismatch.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

/** An already-parsed JSON Schema document. Not `JsonObject`: a schema is arbitrary JSON, not domain config. */
export type SchemaObject = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface CompiledValidator {
  (data: unknown): ValidationResult;
}

function formatErrors(validateFn: ValidateFunction): string[] {
  return (validateFn.errors ?? []).map((error) => {
    const path = error.instancePath || "(root)";
    return `${path} ${error.message ?? "is invalid"}`.trim();
  });
}

/**
 * Compiles a schema into a reusable validator. A fresh Ajv instance is created per
 * compiled schema (instead of sharing one Ajv instance across every schema in the
 * process) so that two schema objects that happen to share a JSON Schema `$id`
 * never collide during `ajv.compile`.
 */
export function compileSchema(schema: SchemaObject): CompiledValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validateFn = ajv.compile(schema);
  return (data: unknown): ValidationResult => {
    const valid = validateFn(data) === true;
    return { valid, errors: valid ? [] : formatErrors(validateFn) };
  };
}

/** Convenience one-shot validation when the schema is only used once. */
export function validateAgainstSchema(schema: SchemaObject, data: unknown): ValidationResult {
  return compileSchema(schema)(data);
}
