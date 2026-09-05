import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { checkProjectContract } from "./projectContract.ts";

function baseGate(overrides: Partial<JsonObject> = {}): JsonObject {
  return {
    id: "lint",
    command: "npm",
    args: ["run", "lint"],
    required: true,
    timeoutSeconds: 300,
    exitCodes: { passed: [0], failed: [1], indeterminate: [2] },
    continueAfterFailure: false,
    ...overrides,
  };
}

function baseContract(gates: JsonObject[] = [baseGate()]): JsonObject {
  return { schemaVersion: 1, validationGates: gates };
}

test("checkProjectContract accepts a minimal valid contract", () => {
  assert.doesNotThrow(() => checkProjectContract(baseContract(), "/repo/.hdo/project.json"));
});

test("checkProjectContract rejects a schemaVersion other than 1", () => {
  assert.throws(
    () => checkProjectContract({ schemaVersion: 2, validationGates: [] }, "/repo/.hdo/project.json"),
    /Project contract schemaVersion must be 1: \/repo\/\.hdo\/project\.json/,
  );
});

test("checkProjectContract rejects a gate with no id", () => {
  assert.throws(
    () => checkProjectContract(baseContract([baseGate({ id: "" })]), "/repo/.hdo/project.json"),
    /A validation gate in '\/repo\/\.hdo\/project\.json' has no id\./,
  );
});

test("checkProjectContract rejects duplicate gate ids (case-insensitive)", () => {
  assert.throws(
    () => checkProjectContract(baseContract([baseGate({ id: "Lint" }), baseGate({ id: "lint" })]), "/repo/.hdo/project.json"),
    /Duplicate validation gate id 'lint' in '\/repo\/\.hdo\/project\.json'\./,
  );
});

test("checkProjectContract rejects a gate with no command", () => {
  assert.throws(
    () => checkProjectContract(baseContract([baseGate({ command: "" })]), "/repo/.hdo/project.json"),
    /Validation gate 'lint' has no command\./,
  );
});

test("checkProjectContract rejects an exit code reused across classes", () => {
  const gate = baseGate({ exitCodes: { passed: [0], failed: [0], indeterminate: [] } });
  assert.throws(
    () => checkProjectContract(baseContract([gate]), "/repo/.hdo/project.json"),
    /Validation gate 'lint' has exit code '0' in more than one class\./,
  );
});

test("checkProjectContract allows disjoint exit code classes across multiple gates", () => {
  const gates = [
    baseGate({ id: "a", exitCodes: { passed: [0], failed: [1], indeterminate: [2] } }),
    baseGate({ id: "b", exitCodes: { passed: [0], failed: [1], indeterminate: [2] } }),
  ];
  assert.doesNotThrow(() => checkProjectContract(baseContract(gates), "/repo/.hdo/project.json"));
});
