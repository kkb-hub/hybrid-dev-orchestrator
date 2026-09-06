// Ports the Codex/Claude failure-detail fixtures and their named assertions from
// `tests/run-tests.ps1:825-888` line for line. JSON fixtures are built with
// `JSON.stringify`/plain objects rather than hand-transcribed escaped text, so a
// once-nested JSON-encoded string (Codex's `message` field, itself JSON text) cannot
// silently drift from what the PowerShell here-string byte-for-byte contains.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  OLLAMA_CONTEXT_OVERFLOW_HINT,
  OLLAMA_CONTEXT_OVERFLOW_PATTERN,
  getClaudeFailureDetail,
  getCodexFailureDetail,
} from "./failureDetail.ts";

// Oracle: Runner.ps1:227-230, the pattern and the exact three-piece hint string.
test("OLLAMA_CONTEXT_OVERFLOW_PATTERN matches case-insensitively; the hint starts with a space", () => {
  assert.ok(OLLAMA_CONTEXT_OVERFLOW_PATTERN.test("no user query found in messages"));
  assert.ok(OLLAMA_CONTEXT_OVERFLOW_PATTERN.test("NO USER QUERY FOUND IN MESSAGES"));
  assert.ok(!OLLAMA_CONTEXT_OVERFLOW_PATTERN.test("unrelated"));
  assert.ok(OLLAMA_CONTEXT_OVERFLOW_HINT.startsWith(" | HDO diagnosis:"));
});

const nestedCodexError = JSON.stringify({
  error: {
    code: "invalid_json_schema",
    message: "Invalid schema for response_format: schema must have a type key.",
  },
  status: 400,
});

// Oracle: tests/run-tests.ps1:825-834, "Codex failures surface the de-duplicated
// JSONL error instead of unrelated stderr warnings"
test("getCodexFailureDetail surfaces the de-duplicated JSONL error instead of unrelated stderr warnings", () => {
  const codexFailureJsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "test" }),
    JSON.stringify({ type: "error", message: nestedCodexError }),
    JSON.stringify({ type: "turn.failed", error: { message: nestedCodexError } }),
  ].join("\n");
  const detail = getCodexFailureDetail(codexFailureJsonl, "unrelated warning on stderr");
  assert.equal(detail, "Invalid schema for response_format: schema must have a type key.");
});

// Oracle: tests/run-tests.ps1:835-839, "Codex failures preserve the tool-router root
// cause before downstream stream errors"
test("getCodexFailureDetail preserves the tool-router root cause before downstream stream errors", () => {
  const stdout = JSON.stringify({
    type: "turn.failed",
    error: { message: "stream disconnected before completion: no user query found in messages" },
  });
  const stderr = "2026-09-03 ERROR codex_core::tools::router: error=unsupported call: bash";
  const detail = getCodexFailureDetail(stdout, stderr);
  assert.ok(detail.startsWith("Codex tool router rejected an unsupported call: bash"));
});

// Oracle: tests/run-tests.ps1:840-841, "Codex failure reporting falls back to stderr
// when no JSONL error event exists"
test("getCodexFailureDetail falls back to stderr when no JSONL error event exists", () => {
  assert.equal(getCodexFailureDetail("", "plain stderr failure"), "plain stderr failure");
});

const claudeFailureEnvelope = JSON.stringify({
  is_error: true,
  terminal_reason: "api_error",
  result: "API Error: response exceeded the output token maximum.",
  permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }],
});
const claudeFailureDetail = getClaudeFailureDetail(
  claudeFailureEnvelope,
  "[claude-code:unrecognized_model] local-model",
);

// Oracle: tests/run-tests.ps1:852-859, "Claude failures prefer the result envelope
// root cause over a misleading stderr warning"
test("getClaudeFailureDetail prefers the result envelope root cause over a misleading stderr warning", () => {
  assert.ok(claudeFailureDetail.startsWith("API Error: response exceeded"));
});

// Oracle: tests/run-tests.ps1:860, "Claude failures retain terminal reason and
// permission-denial context"
test("getClaudeFailureDetail retains terminal reason and permission-denial context", () => {
  assert.ok(claudeFailureDetail.includes("terminal_reason: api_error"));
  assert.ok(claudeFailureDetail.includes("2 permission denial(s): Bash"));
});

// Oracle: tests/run-tests.ps1:861, "Claude failures retain stderr as secondary
// diagnostic context"
test("getClaudeFailureDetail retains stderr as secondary diagnostic context", () => {
  assert.ok(claudeFailureDetail.includes("stderr: [claude-code:unrecognized_model]"));
});

// Oracle: tests/run-tests.ps1:862-863, "Claude failure reporting falls back to
// stderr when no envelope is available"
test("getClaudeFailureDetail falls back to stderr when no envelope is available", () => {
  assert.equal(getClaudeFailureDetail("", "plain stderr failure"), "stderr: plain stderr failure");
});

const claudeContextOverflowEnvelope = JSON.stringify({
  is_error: true,
  terminal_reason: "api_error",
  result: `${"x".repeat(5000)} API Error: 500 no user query found in messages.`,
});
const claudeContextOverflowDetail = getClaudeFailureDetail(claudeContextOverflowEnvelope, "");

// Oracle: tests/run-tests.ps1:877, "test fixture sanity check: the failure detail
// below is long enough to be truncated"
test("getClaudeFailureDetail: the context-overflow fixture is long enough to be truncated", () => {
  assert.ok(claudeContextOverflowDetail.includes("...[truncated]"));
});

// Oracle: tests/run-tests.ps1:878, "Ollama context-window exhaustion is reported as
// such instead of as its misleading upstream message"
test("getClaudeFailureDetail reports Ollama context-window exhaustion instead of the misleading upstream message", () => {
  assert.ok(claudeContextOverflowDetail.includes("HDO diagnosis: the conversation outgrew the local model context window"));
});

// Oracle: tests/run-tests.ps1:879, "the context-window diagnosis names the setting
// that fixes it"
test("getClaudeFailureDetail's context-window diagnosis names the setting that fixes it", () => {
  assert.ok(claudeContextOverflowDetail.includes("contextTokens"));
});

// Oracle: tests/run-tests.ps1:880, "unrelated Claude failures are not annotated with
// the context-window diagnosis"
test("getClaudeFailureDetail does not annotate unrelated failures with the context-window diagnosis", () => {
  assert.ok(!claudeFailureDetail.includes("HDO diagnosis"));
});

// Oracle: tests/run-tests.ps1:883-887, "the Codex/Ollama route explains the same
// Ollama context-window exhaustion"
test("getCodexFailureDetail explains the same Ollama context-window exhaustion", () => {
  const stdout = JSON.stringify({ type: "turn.failed", error: { message: "no user query found in messages" } });
  const detail = getCodexFailureDetail(stdout, "");
  assert.ok(detail.includes("HDO diagnosis: the conversation outgrew the local model context window"));
});

// Oracle: tests/run-tests.ps1:888, "unrelated Codex failures are not annotated with
// the context-window diagnosis"
test("getCodexFailureDetail does not annotate unrelated failures with the context-window diagnosis", () => {
  const codexFailureFallback = getCodexFailureDetail("", "plain stderr failure");
  assert.ok(!codexFailureFallback.includes("HDO diagnosis"));
});
