// Port of `Convert-HdoCodexSchemaNode` / `ConvertTo-HdoCodexJsonSchema` (Runner.ps1:
// 120-188): derives the Codex CLI's `--output-schema` transport copy of a canonical
// HDO schema document, restricted to the subset OpenAI Structured Outputs supports.
// The canonical schema file stays the single source of truth - the unmodified
// canonical schema is applied again after generation, so review-only composition
// rules dropped here are never actually weakened, only the model's own generation
// guidance is.
//
// This module never reads a schema file itself (this package never touches the
// filesystem - see ADR-0001 phase 5 plan §2): callers pass an already-parsed
// document, typically `SchemaRegistry.getDocument(name)`.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import type { SchemaObject } from "../contracts/validate.ts";
import { jsonSchemaValueType } from "./claudeSchema.ts";
import { asString, hdoArrayItems, inIgnoreCase, isPlainObject, isTruthy } from "./psSemantics.ts";

// Oracle: Runner.ps1:136-140, "$unsupportedKeywords = @('$schema', '$id', 'title',
// 'default', 'examples', 'allOf', 'not', 'dependentRequired', 'dependentSchemas',
// 'if', 'then', 'else', 'contains', 'minContains', 'maxContains', 'uniqueItems')",
// PLUS 'oneOf' (issue #22): the OpenAI Structured Outputs API rejects `oneOf` as a
// top-level keyword the same way the Anthropic Messages API rejects Claude's
// top-level `oneOf`/`allOf`/`anyOf` (`claudeSchema.ts`'s `toClaudeTransportSchema`).
// WP-P adds the identical one-liner to Runner.ps1:138 so both implementations agree;
// unlike Claude, this list applies at every depth (not just the document root),
// which is why a *nested* `oneOf` is stripped here too - `anyOf` is deliberately NOT
// added, so a root (or nested) `anyOf` survives Codex normalization even though
// Claude's normalization strips `anyOf` specifically at the document root. This
// asymmetry ("only Claude strips root composition") is intentional and covered by a
// dedicated test.
const UNSUPPORTED_KEYWORDS = [
  "$schema",
  "$id",
  "title",
  "default",
  "examples",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "oneOf",
];

// Oracle: Runner.ps1:141, "$mapKeywords = @('properties', '$defs', 'definitions')"
// (narrower than Claude's: no `patternProperties`/`dependentSchemas`, since
// `dependentSchemas` is itself unsupported and Codex's canonical schemas never use
// `patternProperties`).
const MAP_KEYWORDS = ["properties", "$defs", "definitions"];

// Oracle: Runner.ps1:142, "$dataKeywords = @('const', 'enum')" (narrower than
// Claude's: `default`/`examples` are unsupported keywords here, not data keywords).
const DATA_KEYWORDS = ["const", "enum"];

/**
 * Oracle: Runner.ps1:120-180, `Convert-HdoCodexSchemaNode`. Recursively normalizes a
 * JSON Schema document (or subtree) to the OpenAI Structured Outputs subset: drops
 * every keyword in `UNSUPPORTED_KEYWORDS` at any depth, copies `const`/`enum`
 * verbatim, infers a missing `type` from `const`/`enum` when unambiguous, and - for
 * any node whose (possibly just-inferred) `type` is `'object'` - enforces the two
 * Structured Outputs invariants the CLI itself requires: `additionalProperties` must
 * be `false`, and every declared property must be `required`. `isSchema` mirrors the
 * PS parameter exactly like `claudeSchema.ts`'s `normalizeClaudeSchemaNode`. Throws
 * (does not return) when an object schema violates either invariant - mirrors
 * `Convert-HdoCodexSchemaNode` throwing PS `[string]` exceptions, which
 * `ConvertTo-HdoCodexJsonSchema`'s caller lets propagate. Never mutates `node`.
 */
export function normalizeCodexSchemaNode(node: JsonValue, isSchema = true): JsonValue {
  if (isPlainObject(node)) {
    if (!isSchema) {
      // Oracle: Runner.ps1:128-130, a property-name -> schema map: keys pass through
      // unchanged, values always recurse with isSchema = true.
      const result: JsonObject = {};
      for (const key of Object.keys(node)) {
        result[key] = normalizeCodexSchemaNode(node[key], true);
      }
      return result;
    }

    const result: JsonObject = {};
    for (const name of Object.keys(node)) {
      // Oracle: Runner.ps1:145, "if ($name -in $unsupportedKeywords) { continue }".
      if (UNSUPPORTED_KEYWORDS.includes(name)) continue;
      const value = node[name];
      if (DATA_KEYWORDS.includes(name)) {
        // Oracle: Runner.ps1:147, "$result[$name] = $value" - see claudeSchema.ts's
        // matching comment: `structuredClone` upgrades the PS reference-assignment to
        // an actual deep copy so the "never mutate the input" contract holds even if
        // a caller later mutates the transport copy.
        result[name] = structuredClone(value);
      } else if (MAP_KEYWORDS.includes(name)) {
        // Oracle: Runner.ps1:148, "$result[$name] = Convert-HdoCodexSchemaNode $value $false".
        result[name] = normalizeCodexSchemaNode(value, false);
      } else {
        // Oracle: Runner.ps1:149, "$result[$name] = Convert-HdoCodexSchemaNode $value $true".
        result[name] = normalizeCodexSchemaNode(value, true);
      }
    }

    // Oracle: Runner.ps1:152-155, "if (-not $result.Contains('type') -and
    // $result.Contains('const')) { $inferredType = Get-HdoJsonSchemaValueType
    // $result.const; if ($inferredType) { $result['type'] = $inferredType } }".
    if (!("type" in result) && "const" in result) {
      const inferredType = jsonSchemaValueType(result.const);
      if (inferredType) result.type = inferredType;
    }
    // Oracle: Runner.ps1:156-159, "if (-not $result.Contains('type') -and
    // $result.Contains('enum')) { $enumTypes = @($result.enum | ForEach-Object {
    // Get-HdoJsonSchemaValueType $_ } | Sort-Object -Unique); if ($enumTypes.Count -eq
    // 1 -and $enumTypes[0]) { $result['type'] = $enumTypes[0] } }". `Sort-Object
    // -Unique` only matters here for de-duplication (order is irrelevant to a
    // count/single-value check); a JS `Set` gives the same distinct-count semantics,
    // including "an `undefined` type (an enum literal `Get-HdoJsonSchemaValueType`
    // cannot classify - unreachable for real JSON) counts as one distinct falsy
    // entry", per ADR-0001 phase 5 plan §WP-A.
    if (!("type" in result) && "enum" in result) {
      const enumValues = Array.isArray(result.enum) ? result.enum : [];
      const enumTypes = new Set(enumValues.map((entry) => jsonSchemaValueType(entry)));
      if (enumTypes.size === 1) {
        const onlyType = enumTypes.values().next().value;
        if (onlyType) result.type = onlyType;
      }
    }

    // Oracle: Runner.ps1:161, "if ([string](Get-HdoValue $result 'type' '') -eq
    // 'object')" - PS `-eq` is case-insensitive on strings (ADR-0001 phase 5 plan §7
    // risk 1); every canonical schema uses the lowercase literal `'object'`, and
    // `type` is always a plain string (never a `type` array) on every object node
    // these three schemas define, so a direct string comparison is a faithful,
    // simpler port here (unlike `claudeSchema.ts`, which explicitly documents its
    // exact-match keyword names - this is a *value* comparison, not a keyword-name
    // comparison, so case-insensitivity still applies; it is simply moot for the
    // canonical, all-lowercase schemas this module ever normalizes).
    if (typeof result.type === "string" && result.type.toLowerCase() === "object") {
      // Oracle: Runner.ps1:162-163, "if (-not $result.Contains('additionalProperties')
      // -or [bool]$result.additionalProperties) { throw 'Codex structured output
      // object schemas must set additionalProperties to false.' }".
      if (!("additionalProperties" in result) || isTruthy(result.additionalProperties)) {
        throw new Error("Codex structured output object schemas must set additionalProperties to false.");
      }
      // Oracle: Runner.ps1:165, "$propertyNames = if ($result.Contains('properties'))
      // { @($result.properties.Keys) } else { @() }".
      const propertyNames = isPlainObject(result.properties) ? Object.keys(result.properties) : [];
      // Oracle: Runner.ps1:166, "$requiredNames = if ($result.Contains('required')) {
      // @($result.required) } else { @() }".
      const requiredNames = hdoArrayItems(result.required).map((entry) => asString(entry));
      // Oracle: Runner.ps1:167, "$optionalNames = @($propertyNames | Where-Object {
      // $_ -notin $requiredNames })" - PS `-notin` is case-insensitive on strings.
      const optionalNames = propertyNames.filter((name) => !inIgnoreCase(name, requiredNames));
      // Oracle: Runner.ps1:168-170, "if ($optionalNames.Count -gt 0) { throw
      // \"Codex structured output requires every object property: $($optionalNames
      // -join ', ').\" }".
      if (optionalNames.length > 0) {
        throw new Error(`Codex structured output requires every object property: ${optionalNames.join(", ")}.`);
      }
    }
    return result;
  }

  if (Array.isArray(node)) {
    // Oracle: Runner.ps1:174-178, map each element with the same `isSchema` flag.
    return node.map((item) => normalizeCodexSchemaNode(item, isSchema));
  }

  // Oracle: Runner.ps1:179, "return $Node" - primitives (string/number/boolean/null) pass through as-is.
  return node;
}

/**
 * Oracle: Runner.ps1:182-188, `ConvertTo-HdoCodexJsonSchema`, adapted to take an
 * already-parsed schema document instead of a file path, exactly like
 * `claudeSchema.ts`'s `toClaudeTransportSchema` (this package never reads files -
 * see the module banner; `SchemaRegistry.getDocument(name)` is the intended source).
 * Returns a new object; `schema` (typically a shared `SchemaRegistry` document) is
 * never mutated (ADR-0001 phase 5 plan §7 risk 18). May throw - see
 * `normalizeCodexSchemaNode`.
 */
export function toCodexTransportSchema(schema: SchemaObject): SchemaObject {
  return normalizeCodexSchemaNode(schema as unknown as JsonObject, true) as unknown as SchemaObject;
}

/**
 * Oracle: Runner.ps1:187, "return ($normalized | ConvertTo-Json -Depth 100 -Compress)" - see
 * `claudeSchema.ts`'s `toClaudeTransportSchemaJson` for the `JSON.stringify` equivalence note.
 */
export function toCodexTransportSchemaJson(schema: SchemaObject): string {
  return JSON.stringify(toCodexTransportSchema(schema));
}
