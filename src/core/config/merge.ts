// Deep merge mirroring `Merge-HdoHashtable` in Common.ps1: objects merge key by key
// (recursively), arrays and scalars are replaced wholesale by the later source, and
// the override always wins on type mismatch. No array concatenation. The result is
// always a fresh deep copy (never aliases part of `base` or `override`), matching
// `Merge-HdoHashtable`'s use of `ConvertTo-HdoHashtable` to clone `$Base` up front.
//
// `Merge-HdoHashtable` operates on `ConvertTo-HdoHashtable`'s output, which is a
// `System.Collections.Specialized.OrderedDictionary` - case-insensitive for
// `Contains`/the indexer. It iterates the override's keys and does
// `$result[$key] = ...`, so on an OrderedDictionary: a key matching an existing
// entry case-insensitively is merged/replaced IN PLACE (at the base entry's
// position) using the OVERRIDE's exact key casing; a key with no case-insensitive
// match is appended. This is ported here via `setKeyIgnoreCase` (see value.ts).
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { findKeyIgnoreCase, setKeyIgnoreCase } from "./value.ts";

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isPlainObject(value)) {
    const clone: JsonObject = {};
    for (const key of Object.keys(value)) clone[key] = deepClone(value[key]);
    return clone;
  }
  return value;
}

export function deepMergeConfig(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of Object.keys(base)) result[key] = deepClone(base[key]);
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    const existingKey = findKeyIgnoreCase(result, key);
    const baseValue = existingKey !== undefined ? result[existingKey] : undefined;
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      setKeyIgnoreCase(result, key, deepMergeConfig(baseValue, overrideValue));
    } else {
      setKeyIgnoreCase(result, key, deepClone(overrideValue));
    }
  }
  return result;
}
