import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { deepMergeConfig } from "./merge.ts";

test("deepMergeConfig merges nested objects and lets the override win on scalars", () => {
  const base: JsonObject = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] };
  const override: JsonObject = { a: 2, nested: { y: 20, z: 30 } };
  assert.deepEqual(deepMergeConfig(base, override), {
    a: 2,
    nested: { x: 1, y: 20, z: 30 },
    list: [1, 2, 3],
  });
});

test("deepMergeConfig replaces arrays wholesale instead of concatenating", () => {
  const base: JsonObject = { list: [1, 2, 3] };
  const override: JsonObject = { list: [9] };
  assert.deepEqual(deepMergeConfig(base, override), { list: [9] });
});

test("deepMergeConfig lets a scalar override replace an object, and vice versa", () => {
  assert.deepEqual(deepMergeConfig({ a: { x: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(deepMergeConfig({ a: 5 }, { a: { x: 1 } }), { a: { x: 1 } });
});

test("deepMergeConfig returns a deep copy that never aliases the inputs", () => {
  const base: JsonObject = { nested: { x: 1 }, list: [1, 2] };
  const override: JsonObject = { nested: { y: 2 } };
  const result = deepMergeConfig(base, override);
  (result.nested as JsonObject).x = 999;
  (result.list as unknown[]).push(3);
  assert.deepEqual(base, { nested: { x: 1 }, list: [1, 2] }, "base must be untouched");
  assert.deepEqual(override, { nested: { y: 2 } }, "override must be untouched");
});

test("deepMergeConfig with an empty override returns an equivalent (but distinct) copy of base", () => {
  const base: JsonObject = { a: 1, nested: { x: 1 } };
  const result = deepMergeConfig(base, {});
  assert.deepEqual(result, base);
  assert.notEqual(result, base);
  assert.notEqual(result.nested, base.nested);
});

// PowerShell's `Merge-HdoHashtable` operates on `OrderedDictionary`s, whose
// `Contains`/indexer are case-insensitive: an override key matching an existing
// (differently-cased) key merges/replaces in place, at the existing entry's
// position, using the override's casing - it never produces two case-variant keys.

test("deepMergeConfig folds a case-variant runner key into a single entry at the original position, recursing into it", () => {
  const base: JsonObject = {
    Planner: { type: "codex", command: "codex" },
    other: 1,
  };
  const override: JsonObject = { planner: { model: "x" } };
  const result = deepMergeConfig(base, override);
  assert.deepEqual(Object.keys(result), ["planner", "other"]);
  assert.deepEqual(result.planner, { type: "codex", command: "codex", model: "x" });
});

test("deepMergeConfig re-cases a top-level key to the override's casing without moving its position", () => {
  const base: JsonObject = { Alpha: 1, beta: 2 };
  const override: JsonObject = { alpha: 10 };
  const result = deepMergeConfig(base, override);
  assert.deepEqual(Object.keys(result), ["alpha", "beta"]);
  assert.equal(result.alpha, 10);
});

test("deepMergeConfig appends brand-new override keys after all base keys, in override order", () => {
  const base: JsonObject = { a: 1 };
  const override: JsonObject = { c: 3, b: 2 };
  const result = deepMergeConfig(base, override);
  assert.deepEqual(Object.keys(result), ["a", "c", "b"]);
});
