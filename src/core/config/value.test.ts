import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getValue, setKeyIgnoreCase } from "./value.ts";

test("getValue reads a top-level key", () => {
  assert.equal(getValue({ a: 1 }, "a"), 1);
});

test("getValue walks a dotted path through nested objects", () => {
  const object: JsonObject = { a: { b: { c: 42 } } };
  assert.equal(getValue(object, "a.b.c"), 42);
});

test("getValue returns the default when a segment is missing", () => {
  assert.equal(getValue({ a: {} }, "a.b.c", "fallback"), "fallback");
  assert.equal(getValue({}, "missing", "fallback"), "fallback");
});

test("getValue returns the default when the current node is not a plain object", () => {
  assert.equal(getValue({ a: "scalar" }, "a.b", "fallback"), "fallback");
  assert.equal(getValue({ a: [1, 2, 3] }, "a.b", "fallback"), "fallback");
  assert.equal(getValue({ a: null }, "a.b", "fallback"), "fallback");
});

test("getValue returns undefined by default when nothing is found", () => {
  assert.equal(getValue({}, "missing"), undefined);
});

test("getValue returns an explicit null value (not the default) when the key is present", () => {
  assert.equal(getValue({ a: null }, "a", "fallback"), null);
});

test("setKeyIgnoreCase appends a brand-new key at the end", () => {
  const object: JsonObject = { a: 1, b: 2 };
  setKeyIgnoreCase(object, "c", 3);
  assert.deepEqual(Object.keys(object), ["a", "b", "c"]);
  assert.equal(object.c, 3);
});

test("setKeyIgnoreCase replaces an exact-case match in place without changing key order", () => {
  const object: JsonObject = { a: 1, b: 2, c: 3 };
  setKeyIgnoreCase(object, "b", 20);
  assert.deepEqual(Object.keys(object), ["a", "b", "c"]);
  assert.equal(object.b, 20);
});

test("setKeyIgnoreCase matching a differently-cased key rewrites the key text at the same position", () => {
  const object: JsonObject = { a: 1, ABC: 2, z: 3 };
  setKeyIgnoreCase(object, "abc", 20);
  assert.deepEqual(Object.keys(object), ["a", "abc", "z"]);
  assert.equal(object.abc, 20);
  assert.equal((object as JsonObject).ABC, undefined);
});

test("setKeyIgnoreCase preserves the position and order of every other key when renaming", () => {
  const object: JsonObject = { first: 1, Target: 2, third: 3, fourth: 4 };
  setKeyIgnoreCase(object, "target", 99);
  assert.deepEqual(Object.keys(object), ["first", "target", "third", "fourth"]);
  assert.equal(object.first, 1);
  assert.equal(object.target, 99);
  assert.equal(object.third, 3);
  assert.equal(object.fourth, 4);
});
