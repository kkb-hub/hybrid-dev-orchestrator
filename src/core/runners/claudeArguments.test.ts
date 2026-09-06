import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getClaudeArguments, getClaudeInputText } from "./claudeArguments.ts";

// Oracle: tests/run-tests.ps1:515-526, workspace-write cloud runner with allowedTools.
test("getClaudeArguments: workspace-write cloud runner sets acceptEdits, lower-cases --effort, forwards --allowedTools, and never sends --tools", () => {
  const runner: JsonObject = {
    sandbox: "workspace-write",
    model: "opus",
    reasoningEffort: "HIGH",
    allowedTools: ["Read", "Bash"],
    extraArgs: [],
  };
  const args = getClaudeArguments(runner, "{}");
  const effortIndex = args.indexOf("--effort");
  assert.ok(effortIndex >= 0 && args[effortIndex + 1] === "high", "reasoningEffort is lower-cased for --effort");
  assert.ok(args.includes("--safe-mode"));
  const permissionModeIndex = args.indexOf("--permission-mode");
  assert.equal(args[permissionModeIndex + 1], "acceptEdits");
  const allowedToolsIndex = args.indexOf("--allowedTools");
  assert.equal(args[allowedToolsIndex + 1], "Read,Bash");
  assert.ok(!args.includes("--tools"));
});

// Oracle: tests/run-tests.ps1:527-533, workspace-write Claude/Ollama runner.
test("getClaudeArguments: Claude/Ollama route omits --json-schema/--effort and exposes the full local tool set", () => {
  const runner: JsonObject = {
    sandbox: "workspace-write",
    type: "claude",
    provider: "ollama",
    model: "qwen3.8:27b-q4_K_M",
    reasoningEffort: "medium",
    extraArgs: [],
  };
  const args = getClaudeArguments(runner, '{"type":"object"}');
  assert.ok(!args.includes("--json-schema"));
  assert.ok(!args.includes("--effort"));
  const toolsIndex = args.indexOf("--tools");
  assert.equal(args[toolsIndex + 1], "Read,Write,Edit,Glob,Grep");
});

// Oracle: tests/run-tests.ps1:534-539, read-only Claude/Ollama runner.
test("getClaudeArguments: read-only Claude/Ollama runner exposes only bounded read tools", () => {
  const runner: JsonObject = {
    sandbox: "read-only",
    type: "claude",
    provider: "ollama",
    model: "qwen3.8:27b-q4_K_M",
    extraArgs: [],
  };
  const args = getClaudeArguments(runner, '{"type":"object"}');
  const toolsIndex = args.indexOf("--tools");
  assert.equal(args[toolsIndex + 1], "Read,Glob,Grep");
});

// Oracle: tests/run-tests.ps1:558-563, a modelOverride wins over the configured model.
test("getClaudeArguments: modelOverride is passed to --model instead of the configured model", () => {
  const runner: JsonObject = {
    sandbox: "workspace-write",
    type: "claude",
    provider: "ollama",
    model: "qwen3.8:27b-q4_K_M",
    extraArgs: [],
  };
  const contextModelName = "hdo-ctx-qwen3.8-27b-q4_K_M-deadbeef-65536";
  const args = getClaudeArguments(runner, '{"type":"object"}', contextModelName);
  const modelIndex = args.indexOf("--model");
  assert.ok(modelIndex >= 0 && args[modelIndex + 1] === contextModelName);
});

// Oracle: tests/run-tests.ps1:715-721, read-only runner; extraArgs is never forwarded.
test("getClaudeArguments: read-only maps to --permission-mode plan and extraArgs is never forwarded", () => {
  const runner: JsonObject = { sandbox: "read-only", extraArgs: ["--injected-extra-argument"] };
  const args = getClaudeArguments(runner, "{}");
  const permissionModeIndex = args.indexOf("--permission-mode");
  assert.equal(args[permissionModeIndex + 1], "plan");
  assert.ok(!args.includes("--injected-extra-argument"));
});

test("getClaudeArguments: allowedTools is omitted entirely when empty", () => {
  const runner: JsonObject = { sandbox: "workspace-write" };
  const args = getClaudeArguments(runner, "{}");
  assert.ok(!args.includes("--allowedTools"));
});

// Oracle: tests/run-tests.ps1:656-661, ollama input text embeds the schema and local
// worker constraints; cloud returns the prompt unchanged.
test("getClaudeInputText: Claude/Ollama route embeds the transport schema and local-worker constraints", () => {
  const text = getClaudeInputText({ provider: "ollama" }, "work", '{"type":"object"}');
  assert.match(text, /work/);
  assert.match(text, /Return only one JSON object/);
  assert.match(text, /"type":"object"/);
  assert.match(text, /Do not use a shell/);
  assert.match(text, /HDO runs trusted validation gates/);
});

test("getClaudeInputText: cloud provider returns the prompt unchanged", () => {
  assert.equal(getClaudeInputText({ provider: "cloud" }, "work", '{"type":"object"}'), "work");
});

test("getClaudeInputText: a missing provider defaults to cloud and returns the prompt unchanged", () => {
  assert.equal(getClaudeInputText({}, "work", "{}"), "work");
});
