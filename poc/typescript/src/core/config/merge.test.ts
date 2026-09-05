import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { buildEffectiveConfig, deepMergeConfig } from "./merge.ts";

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

test("buildEffectiveConfig applies overlays left to right, later wins", () => {
  const defaultConfig: JsonObject = { profile: "default", steps: { plan: "a", fix: "a" } };
  const overlayA: JsonObject = { steps: { plan: "b" } };
  const overlayB: JsonObject = { steps: { fix: "c" } };
  assert.deepEqual(buildEffectiveConfig(defaultConfig, [overlayA, overlayB]), {
    profile: "default",
    steps: { plan: "b", fix: "c" },
  });
});

test("buildEffectiveConfig with no overlays returns the default config", () => {
  const defaultConfig: JsonObject = { a: 1 };
  assert.deepEqual(buildEffectiveConfig(defaultConfig, []), { a: 1 });
});
