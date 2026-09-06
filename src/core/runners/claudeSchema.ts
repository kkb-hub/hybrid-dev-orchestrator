// Port of `Convert-HdoClaudeSchemaNode` / `ConvertTo-HdoClaudeJsonSchema` /
// `Get-HdoJsonSchemaValueType` (Runner.ps1:37-118): derives the Claude CLI's
// `--json-schema` transport copy of a canonical HDO schema document. The canonical
// schema file stays the single source of truth - normalization only produces a copy
// the CLI's own strict-mode Ajv (and the Anthropic Messages API's tool schema rules)
// can accept; the adapter re-validates the model's final output against the
// untouched canonical schema afterward (unaffected by anything dropped here).
//
// This module never reads a schema file itself (`core` has no filesystem access -
// see ADR-0001 phase 5 plan §2): callers pass an already-parsed document, typically
// `SchemaRegistry.getDocument(name)`.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import type { SchemaObject } from "../contracts/validate.ts";
import { isPlainObject } from "./psSemantics.ts";

// Oracle: Runner.ps1:51, "$mapKeywords = @('properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas')".
// Values are property-name -> schema maps: keys are data names (never schema
// keywords), so each value recurses with `isSchema = false`.
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

// Oracle: Runner.ps1:55, "$dataKeywords = @('const', 'enum', 'default', 'examples')".
// These keywords hold literal data values, not nested schemas: copied verbatim (deep
// copy - see below) so a literal that happens to contain "$schema"/an array keyword
// name is never mistaken for a schema node and rewritten.
const DATA_KEYWORDS = ["const", "enum", "default", "examples"];

// Oracle: Runner.ps1:67, "$arrayKeywords = @('minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains')".
const ARRAY_KEYWORDS = ["minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains"];

/**
 * JSON Schema keyword names are matched case-SENSITIVELY here, deliberately
 * diverging from PowerShell's `-eq`/`-in` (case-insensitive on strings, ADR-0001
 * phase 5 plan §7 risk 1): JSON Schema keywords are a case-sensitive vocabulary by
 * spec, and every schema this module ever sees (`schemas/*.schema.json`, loaded
 * through `SchemaRegistry`) is authored in canonical lowercase. Exact-name matching
 * is therefore both correct and simpler; this comment is the single place that
 * documents the divergence for every keyword-name comparison in this file.
 */

/**
 * Oracle: Runner.ps1:37-81, `Convert-HdoClaudeSchemaNode`. Recursively normalizes a
 * JSON Schema document (or subtree) for the Claude CLI's strict-mode Ajv validation:
 * drops `$schema` and a redundant default `minContains: 1`, copies data-holding
 * keywords (`const`/`enum`/`default`/`examples`) verbatim without rewriting them as
 * schemas, and appends an explicit `type: 'array'` when only array-only keywords are
 * present (strict mode requires it). `isSchema` mirrors the PS parameter: `true` when
 * `node` is itself a schema (its keys are rewritten as schema keywords), `false` when
 * `node` is a property-name -> schema map (its keys are data names, e.g. under
 * `properties`, and must never be interpreted as keywords). Never mutates `node`.
 */
export function normalizeClaudeSchemaNode(node: JsonValue, isSchema = true): JsonValue {
  if (isPlainObject(node)) {
    if (!isSchema) {
      // Oracle: Runner.ps1:46-49, a property-name -> schema map: keys pass through
      // unchanged, values always recurse with isSchema = true.
      const result: JsonObject = {};
      for (const key of Object.keys(node)) {
        result[key] = normalizeClaudeSchemaNode(node[key], true);
      }
      return result;
    }

    const result: JsonObject = {};
    for (const name of Object.keys(node)) {
      const value = node[name];
      // Oracle: Runner.ps1:59, "if ($name -eq '$schema') { continue }".
      if (name === "$schema") continue;
      // Oracle: Runner.ps1:60-62, "if ($name -eq 'minContains' -and $value -isnot
      // [IDictionary] -and $value -isnot [IEnumerable] -and $value -isnot [bool] -and
      // [string]$value -eq '1') { continue }". Verified against pwsh 7.6.5
      // (`'1' -is [System.Collections.IEnumerable]` is `True` - .NET strings are
      // enumerable - so this drop can only ever reach numeric `1`/`1.0`, NEVER the
      // string `"1"`; confirmed end-to-end by running the real
      // `ConvertTo-HdoClaudeJsonSchema` against a schema with `minContains` set to
      // `1`, `1.0`, `"1"`, and `2`: only the two numeric-`1` cases were dropped, the
      // string `"1"` was kept (with `type: 'array'` added). This corrects the plan
      // draft's note that `"1"` is also covered - it is not.
      if (name === "minContains" && !isPlainObject(value) && !Array.isArray(value) && typeof value !== "string" && typeof value !== "boolean" && String(value) === "1") {
        continue;
      }
      if (DATA_KEYWORDS.includes(name)) {
        // Oracle: Runner.ps1:63, "$result[$name] = $value" - the PS assignment shares
        // the reference (hashtables/arrays are reference types), which is harmless
        // there because nothing mutates the output afterward. `structuredClone` here
        // makes the "do not mutate the input document" contract (ADR-0001 phase 5
        // plan §WP-A, §7 risk 18) hold even if a caller later mutates the transport
        // copy, at the cost of a deep copy PS does not actually perform.
        result[name] = structuredClone(value);
      } else if (MAP_KEYWORDS.includes(name)) {
        // Oracle: Runner.ps1:64, "$result[$name] = Convert-HdoClaudeSchemaNode $value $false".
        result[name] = normalizeClaudeSchemaNode(value, false);
      } else {
        // Oracle: Runner.ps1:65, "$result[$name] = Convert-HdoClaudeSchemaNode $value $true".
        result[name] = normalizeClaudeSchemaNode(value, true);
      }
    }

    // Oracle: Runner.ps1:67-72, append "type: 'array'" LAST when an array-only
    // keyword survived and no "type" was set - strict-mode Ajv requires typed
    // subschemas, but the canonical schemas often omit "type" for array constraints.
    if (!("type" in result) && ARRAY_KEYWORDS.some((keyword) => keyword in result)) {
      result.type = "array";
    }
    return result;
  }

  if (Array.isArray(node)) {
    // Oracle: Runner.ps1:75-79, map each element with the same `isSchema` flag.
    return node.map((item) => normalizeClaudeSchemaNode(item, isSchema));
  }

  // Oracle: Runner.ps1:80, "return $Node" - primitives (string/number/boolean/null) pass through as-is.
  return node;
}

/**
 * Oracle: Runner.ps1:83-103, `ConvertTo-HdoClaudeJsonSchema`, adapted to take an
 * already-parsed schema document instead of a file path (this package never reads
 * files - see the module banner; `SchemaRegistry.getDocument(name)` is the intended
 * source). Normalizes `schema`, then drops a top-level `oneOf`/`allOf`/`anyOf`: the
 * Anthropic Messages API rejects composition as a top-level key of
 * `tools[].custom.input_schema` with a 400 ("does not support ... at the top level"),
 * even though the CLI's own Ajv strict-mode pass accepts it (issue #21). Nested
 * composition (e.g. under `$defs`) is unaffected - only the document root is
 * stripped. Returns a new object; `schema` (typically a shared `SchemaRegistry`
 * document) is never mutated (ADR-0001 phase 5 plan §7 risk 18).
 */
export function toClaudeTransportSchema(schema: SchemaObject): SchemaObject {
  const normalized = normalizeClaudeSchemaNode(schema as unknown as JsonObject, true) as JsonObject;
  // Oracle: Runner.ps1:99-101, "foreach ($topLevelCompositionKeyword in @('oneOf', 'allOf', 'anyOf')) { $normalized.Remove($topLevelCompositionKeyword) }".
  for (const topLevelCompositionKeyword of ["oneOf", "allOf", "anyOf"]) {
    delete normalized[topLevelCompositionKeyword];
  }
  return normalized as unknown as SchemaObject;
}

/**
 * Oracle: Runner.ps1:102, "return ($normalized | ConvertTo-Json -Depth 100 -Compress)".
 * `JSON.stringify` with no indentation argument is `ConvertTo-Json -Compress`'s
 * equivalent (no inserted whitespace); `-Depth 100` has no TS analogue and is not
 * needed (`JSON.stringify` has no depth cap - ADR-0001 phase 5 plan §7 risk 6).
 */
export function toClaudeTransportSchemaJson(schema: SchemaObject): string {
  return JSON.stringify(toClaudeTransportSchema(schema));
}

/**
 * Oracle: Runner.ps1:105-118, `Get-HdoJsonSchemaValueType`. Divergence (ADR-0001
 * phase 5 plan §WP-A): PowerShell's `ConvertFrom-Json` distinguishes an integral
 * .NET type from `[double]` (so a JSON literal `1.0` is a `[double]` -> `'number'`),
 * but `JSON.parse` produces a single JS `number` for both `1` and `1.0` - this
 * function therefore always reports `'integer'` for a whole-number value, even one
 * originally written as `1.0`. This only matters for a `const`/`enum` value of
 * exactly `1.0`; no shipped schema (`schemas/*.schema.json`) has one.
 */
export function jsonSchemaValueType(value: JsonValue): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (isPlainObject(value)) return "object";
  if (Array.isArray(value)) return "array";
  return undefined;
}
