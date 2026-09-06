// Unit tests for the shared PowerShell-semantics helpers every `src/core/runners/**`
// module builds on. `isPlainObject`/`asString`/`asNumber`/`isTruthy`/`hdoArrayCount`/
// `hdoArrayItems`/`addCaseInsensitive` are the same private helpers already covered
// indirectly by `src/core/config/validate.test.ts` (ported verbatim here, ADR-0001
// phase 5 plan §WP-0); the assertions below re-verify their PS-truthiness/array
// claims directly against pwsh 7.6.5 output rather than trusting the port by
// inspection. `equalsIgnoreCase`/`inIgnoreCase`/`removeKeyIgnoreCase` are new for
// phase 5.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  addCaseInsensitive,
  asNumber,
  asString,
  equalsIgnoreCase,
  hdoArrayCount,
  hdoArrayItems,
  inIgnoreCase,
  isPlainObject,
  isTruthy,
  removeKeyIgnoreCase,
} from "./psSemantics.ts";

test("isPlainObject accepts plain objects only, not arrays/null/scalars", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject("x"), false);
  assert.equal(isPlainObject(0), false);
});

test("asString stringifies present values and falls back for null/undefined", () => {
  assert.equal(asString("x"), "x");
  assert.equal(asString(0), "0");
  assert.equal(asString(false), "false");
  assert.equal(asString(null), "");
  assert.equal(asString(undefined), "");
  assert.equal(asString(null, "fallback"), "fallback");
  assert.equal(asString(undefined, "fallback"), "fallback");
});

test("asNumber coerces present values and falls back for null/undefined/NaN", () => {
  assert.equal(asNumber(5, 0), 5);
  assert.equal(asNumber("5", 0), 5);
  assert.equal(asNumber(null, 7), 7);
  assert.equal(asNumber(undefined, 7), 7);
  assert.equal(asNumber("not-a-number", 7), 7);
});

// Oracle: pwsh 7.6.5, "[bool]@{}" -> True: an empty hashtable is truthy.
test("isTruthy: an empty plain object is truthy (PS empty hashtable is truthy)", () => {
  assert.equal(isTruthy({}), true);
});

// Oracle: pwsh 7.6.5, "[bool]'0'" -> True: the string \"0\" is truthy.
test("isTruthy: the string '0' is truthy", () => {
  assert.equal(isTruthy("0"), true);
});

// Oracle: pwsh 7.6.5, "[bool]0" -> False: the integer 0 is falsy.
test("isTruthy: the number 0 is falsy", () => {
  assert.equal(isTruthy(0), false);
});

// Oracle: pwsh 7.6.5, "[bool][string]::Empty" -> False.
test("isTruthy: the empty string is falsy", () => {
  assert.equal(isTruthy(""), false);
});

// Oracle: pwsh 7.6.5, "[bool]@()" -> False: an empty array is falsy.
test("isTruthy: an empty array is falsy, a non-empty array is truthy", () => {
  assert.equal(isTruthy([]), false);
  assert.equal(isTruthy([1]), true);
});

test("isTruthy: null/undefined are falsy, false is falsy, true is truthy", () => {
  assert.equal(isTruthy(null), false);
  assert.equal(isTruthy(undefined), false);
  assert.equal(isTruthy(false), false);
  assert.equal(isTruthy(true), true);
});

// Oracle: pwsh 7.6.5, "@($null).Count" -> 1: a scalar (including null) wrapped in
// PowerShell's @() array cast counts as exactly one element.
test("hdoArrayCount: missing is 0, arrays count their own length, any scalar (incl. null) counts as 1", () => {
  assert.equal(hdoArrayCount(undefined), 0);
  assert.equal(hdoArrayCount([]), 0);
  assert.equal(hdoArrayCount([1, 2, 3]), 3);
  assert.equal(hdoArrayCount(null), 1);
  assert.equal(hdoArrayCount("x"), 1);
  assert.equal(hdoArrayCount(0), 1);
});

test("hdoArrayItems: missing is [], arrays pass through, any scalar (incl. null) is wrapped", () => {
  assert.deepEqual(hdoArrayItems(undefined), []);
  assert.deepEqual(hdoArrayItems([1, 2]), [1, 2]);
  assert.deepEqual(hdoArrayItems(null), [null]);
  assert.deepEqual(hdoArrayItems("x"), ["x"]);
});

test("addCaseInsensitive: first add of a case-variant is new, second is a duplicate", () => {
  const set = new Set<string>();
  assert.equal(addCaseInsensitive(set, "Foo"), true);
  assert.equal(addCaseInsensitive(set, "foo"), false);
  assert.equal(addCaseInsensitive(set, "FOO"), false);
  assert.equal(addCaseInsensitive(set, "bar"), true);
});

// Oracle: pwsh 7.6.5, "('DEF' -eq 'def')" -> True: -eq is case-insensitive for strings.
test("equalsIgnoreCase mirrors PS -eq case-insensitivity", () => {
  assert.equal(equalsIgnoreCase("DEF", "def"), true);
  assert.equal(equalsIgnoreCase("abc", "xyz"), false);
});

// Oracle: pwsh 7.6.5, "('DEF' -in @('abc','def'))" -> True and
// "(@('abc','def') -contains 'DEF')" -> True: -in/-contains are case-insensitive.
test("inIgnoreCase mirrors PS -in/-contains case-insensitivity", () => {
  assert.equal(inIgnoreCase("DEF", ["abc", "def"]), true);
  assert.equal(inIgnoreCase("zzz", ["abc", "def"]), false);
});

// Oracle: pwsh 7.6.5, "[ordered]@{ ABC = 1; def = 2 }.Remove('abc')" removes the
// entry keyed 'ABC' (case-insensitive removal), leaving only 'def'.
test("removeKeyIgnoreCase mirrors PS [ordered] dictionary case-insensitive Remove", () => {
  const record: Record<string, string | number> = { ABC: 1, def: 2 };
  removeKeyIgnoreCase(record, "abc");
  assert.deepEqual(record, { def: 2 });
});

test("removeKeyIgnoreCase is a no-op when no key matches", () => {
  const record: Record<string, string | number> = { def: 2 };
  removeKeyIgnoreCase(record, "zzz");
  assert.deepEqual(record, { def: 2 });
});
