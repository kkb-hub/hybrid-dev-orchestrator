// Mirrors `Get-HdoValue` in Common.ps1: walks a dotted path through nested plain
// objects, returning `defaultValue` as soon as a segment is missing or the current
// node stops being a plain object (arrays, strings, numbers, null are all "not a
// dictionary" in the PowerShell sense - `-isnot [System.Collections.IDictionary]`).
import type { JsonValue } from "../contracts/types.ts";

function isPlainObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getValue<T = JsonValue | undefined>(
  object: JsonValue,
  dottedPath: string,
  defaultValue?: T,
): JsonValue | T | undefined {
  let current: JsonValue = object;
  for (const segment of dottedPath.split(".")) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return defaultValue;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Case-insensitive key lookup for user-keyed maps (`profiles`, `runners`, `steps`)
 * whose PowerShell counterpart is an `[ordered]` dictionary/`Hashtable` - both of
 * which compare string keys with `Contains`/the indexer case-insensitively by
 * default, regardless of platform. Returns the actual key from `object` that
 * matches `key` case-insensitively (preserving whatever casing that key already
 * has), or `undefined` if no such key exists. Faithful port of the semantics behind
 * every `$dict.Contains($name)` / `$dict[$name]` pair ported from PowerShell where
 * `$name` may not have gone through a schema's lowercase-only `name` pattern (e.g.
 * a `-Profile`/`-SetStep` CLI value).
 */
export function findKeyIgnoreCase(object: { [key: string]: JsonValue } | undefined, key: string): string | undefined {
  if (!object) return undefined;
  const target = key.toLowerCase();
  for (const candidate of Object.keys(object)) {
    if (candidate.toLowerCase() === target) return candidate;
  }
  return undefined;
}

/**
 * Faithful port of assigning `$dict[$key] = $value` on a PowerShell
 * `OrderedDictionary`/`Hashtable`: if an existing key matches `key`
 * case-insensitively, the entry's VALUE is replaced and its key TEXT is
 * rewritten to `key`'s exact casing, all while keeping the entry at its
 * original position (verified: `$h["abc"]=1; $h["ABC"]=2` yields a
 * single entry keyed `ABC`, at the original position, count 1). If no
 * such key exists, a new entry is appended at the end (matching
 * `OrderedDictionary`'s append-on-insert behavior).
 *
 * Rebuilds the object from an ordered entries list to move the key text
 * without disturbing position, since a plain reassignment of a
 * differently-cased key would append rather than replace in place.
 * Object property order is insertion order for all string keys used
 * anywhere in HDO config (schema-enforced `^[a-z0-9][a-z0-9._-]*$`
 * names plus fixed identifiers) - none are array-index-like ("integer
 * index" keys, which JS would otherwise iterate first in numeric order
 * regardless of insertion order.
 */
export function setKeyIgnoreCase(object: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  const existingKey = findKeyIgnoreCase(object, key);
  if (existingKey === undefined) {
    object[key] = value;
    return;
  }
  if (existingKey === key) {
    object[existingKey] = value;
    return;
  }
  // Renaming a key in place (without disturbing position) requires deleting and
  // re-adding EVERY entry in original order - deleting/re-adding just the target
  // key one at a time would move it (and any entry re-added after it) to the end,
  // since `delete` followed by assignment always appends.
  const originalKeys = Object.keys(object);
  const entries: Array<[string, JsonValue]> = originalKeys.map((candidate) =>
    candidate === existingKey ? [key, value] : [candidate, object[candidate]],
  );
  for (const candidate of originalKeys) delete object[candidate];
  for (const [entryKey, entryValue] of entries) object[entryKey] = entryValue;
}
