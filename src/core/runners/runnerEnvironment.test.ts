import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../contracts/types.ts";
import { getRunnerEnvironment } from "./runnerEnvironment.ts";

// Oracle: tests/run-tests.ps1:662-673, Claude/Ollama environment without contextTokens.
test("getRunnerEnvironment: Claude/Ollama route pins the loopback endpoint and non-secret auth, no context window declared", () => {
  const runner: JsonObject = { type: "claude", provider: "ollama", passEnvironment: [] };
  const env = getRunnerEnvironment(runner, {});
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ollama");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.ok(!("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in env));
});

// Oracle: tests/run-tests.ps1:674-686, contextTokens:65536 -> '65536'.
test("getRunnerEnvironment: Claude/Ollama route declares CLAUDE_CODE_MAX_CONTEXT_TOKENS from a positive contextTokens", () => {
  const runner: JsonObject = { type: "claude", provider: "ollama", contextTokens: 65536, passEnvironment: [] };
  const env = getRunnerEnvironment(runner, {});
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
});

// Oracle: tests/run-tests.ps1:691-698, an inherited context window is stripped when the
// runner declares no contextTokens.
test("getRunnerEnvironment: an ambient CLAUDE_CODE_MAX_CONTEXT_TOKENS is stripped for an Ollama runner with no contextTokens", () => {
  const runner: JsonObject = { type: "claude", provider: "ollama", passEnvironment: [] };
  const env = getRunnerEnvironment(runner, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "4096" });
  assert.ok(!("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in env));
});

// Oracle: tests/run-tests.ps1:699-703, the runner's contextTokens wins over an inherited
// context window.
test("getRunnerEnvironment: the runner's contextTokens overrides an ambient CLAUDE_CODE_MAX_CONTEXT_TOKENS", () => {
  const runner: JsonObject = { type: "claude", provider: "ollama", contextTokens: 65536, passEnvironment: [] };
  const env = getRunnerEnvironment(runner, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "4096" });
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
});

// Oracle: tests/run-tests.ps1:708-712, a cloud Claude runner keeps an operator-declared
// context window untouched (only the Ollama route is HDO's to pin).
test("getRunnerEnvironment: a cloud Claude runner keeps an inherited CLAUDE_CODE_MAX_CONTEXT_TOKENS", () => {
  const runner: JsonObject = { type: "claude", provider: "cloud", passEnvironment: [] };
  const env = getRunnerEnvironment(runner, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "4096" });
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "4096");
});

// Oracle: tests/run-tests.ps1:662-714 (implicit), an ambient GITHUB_TOKEN is dropped
// unless listed in passEnvironment (getSafeEnvironment's deny-list, delegated to).
test("getRunnerEnvironment: an ambient GITHUB_TOKEN is dropped unless listed in passEnvironment", () => {
  const runner: JsonObject = { type: "claude", provider: "cloud", passEnvironment: [] };
  const env = getRunnerEnvironment(runner, { GITHUB_TOKEN: "secret" });
  assert.ok(!("GITHUB_TOKEN" in env));

  const runnerAllowed: JsonObject = { type: "claude", provider: "cloud", passEnvironment: ["GITHUB_TOKEN"] };
  const envAllowed = getRunnerEnvironment(runnerAllowed, { GITHUB_TOKEN: "secret" });
  assert.equal(envAllowed.GITHUB_TOKEN, "secret");
});

// Oracle: Runner.ps1:340, only the (type=claude, provider=ollama) combination injects
// the loopback environment - a codex/ollama runner does not.
test("getRunnerEnvironment: a non-Claude runner is unaffected even on the ollama provider", () => {
  const runner: JsonObject = { type: "codex", provider: "ollama", passEnvironment: [] };
  const env = getRunnerEnvironment(runner, {});
  assert.ok(!("ANTHROPIC_BASE_URL" in env));
});
