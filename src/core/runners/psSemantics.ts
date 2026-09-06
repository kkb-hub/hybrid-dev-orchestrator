// Shared PowerShell-semantics helpers for `src/core/runners/**`. These are the same
// private helpers `src/core/config/validate.ts:32-88` already carries (copied
// verbatim, same names/semantics - `validate.ts`'s private copies are intentionally
// left untouched, see ADR-0001 phase 5 plan §WP-0), plus a handful of additional
// case-insensitive-comparison helpers every runner module needs. Verified against
// pwsh 7.6.5 (ADR-0001 phase 5 plan §7 risks 1-2):
//   [bool]@{}         -> True  (an empty hashtable is truthy)
//   [bool]'0'         -> True  (the string "0" is truthy; only [bool]0, the integer, is false)
//   [bool][string]::Empty -> False
//   [bool]0           -> False
//   [bool]@()         -> False (an empty array is falsy)
//   ('DEF' -eq 'def') -> True  (-eq is case-insensitive for strings)
//   ('DEF' -in @('abc','def')) -> True
//   [ordered]@{ ABC = 1 }.Remove('abc') removes the entry keyed 'ABC'
import type { JsonObject, JsonValue } from "../contracts/types.ts";

export function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: JsonValue | undefined, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * `[int]` cast equivalent. The JSON Schema already constrains these to integers
 * where it matters; `Number()` is a faithful enough coercion for the defensive
 * casts here (PowerShell's `[int]` uses banker's rounding on non-integers, which
 * cannot be reached through schema-valid input in the first place).
 */
export function asNumber(value: JsonValue | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/** PowerShell truthiness for the value shapes `Get-HdoValue` can return. */
export function isTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return true; // non-null plain object: PowerShell hashtables are truthy even when empty
}

/**
 * `@(Get-HdoValue $runner $key @()).Count`: a missing key defaults to an empty
 * array (count 0); an array value contributes its own length; any other present
 * value (including an explicit JSON `null`, matching `@($null).Count -eq 1`) counts
 * as exactly one element, mirroring PowerShell's `@(...)` array cast around a
 * scalar.
 */
export function hdoArrayCount(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

export function hdoArrayItems(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Case-insensitive `HashSet<string>.Add`: returns true iff `value` was newly added. */
export function addCaseInsensitive(set: Set<string>, value: string): boolean {
  const key = value.toLowerCase();
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

/** PowerShell `-eq` on two strings: ordinal, case-insensitive (verified: `'DEF' -eq 'def'` is `True`). */
export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * PowerShell `-in`/`-contains` on a list of strings: case-insensitive membership
 * (verified: `'DEF' -in @('abc','def')` and `@('abc','def') -contains 'DEF'` are
 * both `True`).
 */
export function inIgnoreCase(value: string, list: readonly string[]): boolean {
  return list.some((entry) => equalsIgnoreCase(entry, value));
}

/**
 * PowerShell `[ordered]@{...}.Remove($key)`: removes the entry whose key matches
 * `key` case-insensitively, if any (verified: `[ordered]@{ ABC = 1 }.Remove('abc')`
 * removes the entry keyed `ABC`). Mutates `record` in place; a no-op if no key
 * matches.
 */
export function removeKeyIgnoreCase(record: { [key: string]: JsonValue }, key: string): void {
  const target = key.toLowerCase();
  for (const candidate of Object.keys(record)) {
    if (candidate.toLowerCase() === target) {
      delete record[candidate];
      return;
    }
  }
}
