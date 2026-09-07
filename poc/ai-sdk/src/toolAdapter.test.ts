// Unit-level counterpart to worker.test.ts's wire-level read-only assertion: checks the
// `ToolSet` object `buildToolSet` (toolAdapter.ts) actually returns, not merely the JSON
// that happened to reach the stub in one scenario. Fast and process-free by design, so it
// stays cheap to run on every change to toolAdapter.ts even though worker.test.ts already
// covers the same guarantee end to end.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSession } from "../../../src/workers/leanWorker/session.ts";
import { buildToolSet } from "./toolAdapter.ts";

function testSession(readOnly: boolean) {
  return createSession({
    workspace: "/workspace",
    readOnly,
    model: "stub-model",
    contextTokens: 32768,
    maxTurns: 40,
    maxToolResultChars: 20000,
    compactAtPercent: 65,
    keepRecentMessages: 6,
    requestTimeoutSeconds: 600,
    ollamaUri: "http://127.0.0.1:0/api/chat",
    tools: [],
  });
}

test("ai-sdk poc: a read-only tool set structurally omits write_file and edit_file", () => {
  const session = testSession(true);
  const toolSet = buildToolSet({ workspace: session.workspace, readOnly: true, maxToolResultChars: session.maxToolResultChars }, session, {
    current: 1,
  });
  assert.deepEqual(Object.keys(toolSet).sort(), ["list_files", "read_file", "search_files"]);
});

test("ai-sdk poc: a writable tool set includes exactly the five workspace tools", () => {
  const session = testSession(false);
  const toolSet = buildToolSet({ workspace: session.workspace, readOnly: false, maxToolResultChars: session.maxToolResultChars }, session, {
    current: 1,
  });
  assert.deepEqual(Object.keys(toolSet).sort(), ["edit_file", "list_files", "read_file", "search_files", "write_file"]);
});
