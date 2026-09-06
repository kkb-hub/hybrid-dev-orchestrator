import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getCodexArguments } from "./codexArguments.ts";

// Oracle: tests/run-tests.ps1:810-823, "Codex runner excludes personal configuration and
// execpolicy rules from unattended runs" / "Codex runner preserves explicit local
// provider and model routing" - full argv vector, byte for byte.
test("getCodexArguments: full argv vector for an ollama runner with reasoningEffort and contextTokens", () => {
  const runner: JsonObject = {
    sandbox: "workspace-write",
    provider: "ollama",
    model: "local-model",
    reasoningEffort: "medium",
    contextTokens: 32768,
    extraArgs: [],
  };
  const args = getCodexArguments(runner, "C:\\worktree", "C:\\artifacts\\schema.json", "C:\\artifacts\\final.json");
  assert.deepEqual(args, [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--cd",
    "C:\\worktree",
    "--oss",
    "--local-provider",
    "ollama",
    "--model",
    "local-model",
    "--config",
    'model_reasoning_effort="medium"',
    "--config",
    "model_context_window=32768",
    "--output-schema",
    "C:\\artifacts\\schema.json",
    "--output-last-message",
    "C:\\artifacts\\final.json",
    "-",
  ]);
});

test("getCodexArguments: a cloud runner without model/reasoningEffort/contextTokens omits those flags", () => {
  const runner: JsonObject = { sandbox: "read-only", extraArgs: [] };
  const args = getCodexArguments(runner, "C:\\worktree", "C:\\schema.json", "C:\\final.json");
  assert.deepEqual(args, [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--cd",
    "C:\\worktree",
    "--output-schema",
    "C:\\schema.json",
    "--output-last-message",
    "C:\\final.json",
    "-",
  ]);
});

// Oracle: Runner.ps1:216, extraArgs are inserted before the trailing `-`.
test("getCodexArguments: extraArgs are inserted immediately before the trailing '-'", () => {
  const runner: JsonObject = { sandbox: "read-only", extraArgs: ["--x"] };
  const args = getCodexArguments(runner, "C:\\worktree", "C:\\schema.json", "C:\\final.json");
  assert.deepEqual(args.slice(-2), ["--x", "-"]);
});

// Oracle: Runner.ps1:207, provider membership check is case-insensitive (§7 risk 1).
test("getCodexArguments: 'lmstudio' provider also gets --oss --local-provider", () => {
  const args = getCodexArguments({ sandbox: "read-only", provider: "lmstudio", extraArgs: [] }, "C:\\w", "C:\\s", "C:\\f");
  assert.ok(args.includes("--oss"));
  const providerIndex = args.indexOf("--local-provider");
  assert.equal(args[providerIndex + 1], "lmstudio");
});

test("getCodexArguments: a cloud provider does not get --oss/--local-provider", () => {
  const args = getCodexArguments({ sandbox: "read-only", provider: "cloud", extraArgs: [] }, "C:\\w", "C:\\s", "C:\\f");
  assert.ok(!args.includes("--oss"));
});

test("getCodexArguments: contextTokens of 0 omits the model_context_window --config entry", () => {
  const args = getCodexArguments({ sandbox: "read-only", contextTokens: 0, extraArgs: [] }, "C:\\w", "C:\\s", "C:\\f");
  assert.ok(!args.join(" ").includes("model_context_window"));
});
