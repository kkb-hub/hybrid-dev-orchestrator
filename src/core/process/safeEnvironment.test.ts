import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getSafeEnvironment } from "./safeEnvironment.ts";

test("removes an exact blocked name", () => {
  const result = getSafeEnvironment({ GH_TOKEN: "x", PATH: "/usr/bin" });
  assert.deepEqual(result, { PATH: "/usr/bin" });
});

test("blocked-name comparison is case-insensitive", () => {
  const result = getSafeEnvironment({ gh_token: "x", Gh_Token: "y", PATH: "/usr/bin" });
  assert.deepEqual(result, { PATH: "/usr/bin" });
});

test("removes any name ending in TOKEN/SECRET/PASSWORD/API_KEY (case-insensitive suffix)", () => {
  const result = getSafeEnvironment({
    MY_CUSTOM_TOKEN: "x",
    my_secret: "y",
    SOME_PASSWORD: "z",
    service_api_key: "w",
    NOT_A_MATCH: "keep",
  });
  assert.deepEqual(result, { NOT_A_MATCH: "keep" });
});

test("passEnvironment allow-lists a blocked name back in, case-insensitively", () => {
  const result = getSafeEnvironment({ GH_TOKEN: "x", PATH: "/usr/bin" }, ["gh_token"]);
  assert.deepEqual(result, { GH_TOKEN: "x", PATH: "/usr/bin" });
});

test("undefined values are dropped", () => {
  const result = getSafeEnvironment({ PATH: "/usr/bin", MAYBE: undefined });
  assert.deepEqual(result, { PATH: "/usr/bin" });
});

test("enumeration order is preserved", () => {
  const result = getSafeEnvironment({ B: "2", A: "1", GH_TOKEN: "x", C: "3" });
  assert.deepEqual(Object.keys(result), ["B", "A", "C"]);
});

test("empty input and empty passEnvironment default produce an empty object", () => {
  assert.deepEqual(getSafeEnvironment({}), {});
});
