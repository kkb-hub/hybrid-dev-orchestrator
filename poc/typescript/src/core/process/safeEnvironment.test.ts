import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getSafeEnvironment } from "./safeEnvironment.ts";

test("blocks the exact deny-listed names (case-insensitively)", () => {
  const result = getSafeEnvironment({
    GH_TOKEN: "a",
    gh_token: "b",
    ANTHROPIC_API_KEY: "c",
    PATH: "/usr/bin",
    HOME: "/root",
  });
  assert.deepEqual(result, { PATH: "/usr/bin", HOME: "/root" });
});

test("blocks any name matching the (?i)(TOKEN|SECRET|PASSWORD|API_KEY)$ suffix pattern", () => {
  const result = getSafeEnvironment({
    MY_CUSTOM_TOKEN: "x",
    DB_PASSWORD: "y",
    SOME_SECRET: "z",
    STRIPE_API_KEY: "w",
    NOT_BLOCKED: "kept",
    TOKENIZED: "kept-too", // does not END with TOKEN, must not be blocked
  });
  assert.deepEqual(result, { NOT_BLOCKED: "kept", TOKENIZED: "kept-too" });
});

test("passEnvironment allow-lists an otherwise-blocked name", () => {
  const result = getSafeEnvironment({ GH_TOKEN: "a", OTHER: "b" }, ["GH_TOKEN"]);
  assert.deepEqual(result, { GH_TOKEN: "a", OTHER: "b" });
});

test("allow-list match is case-insensitive", () => {
  const result = getSafeEnvironment({ GH_TOKEN: "a" }, ["gh_token"]);
  assert.deepEqual(result, { GH_TOKEN: "a" });
});

test("drops undefined-valued entries and leaves an otherwise-empty environment empty", () => {
  assert.deepEqual(getSafeEnvironment({ FOO: undefined }), {});
  assert.deepEqual(getSafeEnvironment({}), {});
});
