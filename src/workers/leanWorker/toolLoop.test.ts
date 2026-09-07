// Port of tests/test-lean-worker.ps1 (lines 152-428): the tool loop itself, structured
// output, workspace containment (relative escape, absolute path, git metadata, link
// traversal), the read-only boundary, tool-result bounding, retry/fail-closed behaviour
// for an empty structured result, omitted response counters, CRLF-tolerant editing, the
// upstream-error detail path, the turn limit, the system prompt's context-discipline
// text, and bounded reads/searches. The token-aware compaction cases (PR #55, PS lines
// 430-703) are ported separately in compaction.test.ts - this file is long enough on its
// own, and the two halves test genuinely different concerns (does the loop and its tools
// behave correctly vs. does the loop stay inside its context budget).
//
// See testHarness.ts for why the stub server binds an ephemeral port (port 0) and why the
// worker is launched with the ASYNC child_process API.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  STRUCTURED_RESULT,
  newAssistantResponse,
  newToolCall,
  parseRequest,
  runWorkerAgainstStub,
  runWorkerProcess,
  toolResultContents,
} from "./testHarness.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "hdo-lean-worker-toolloop-"));

/** Whether this host allows creating a directory junction without elevation - probed
 * once at module load, mirroring the PS test's own try/catch around `New-Item -ItemType
 * Junction` (which the PS test performs inline, per-run; probing once here just avoids
 * paying the cost of creating and tearing down a junction for every test file run). */
function canCreateJunction(): boolean {
  const probeDir = join(TEST_ROOT, "junction-probe");
  const target = join(TEST_ROOT, "junction-probe-target");
  try {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, probeDir, "junction");
    rmSync(probeDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
const JUNCTION_AVAILABLE = canCreateJunction();

test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// --- tool loop, editing, and structured output ---------------------------------------------
// Oracle: tests/test-lean-worker.ps1:153-173.
test("lean worker: tool loop, editing, and structured output", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "edit", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const run = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("edit_file", { path: "a.txt", old_text: "original", new_text: "replaced" })] }),
      newAssistantResponse({ content: "finished" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });

  assert.equal(run.exitCode, 0, "the worker exits zero after a successful tool loop");
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8").trim(), "replaced text", "edit_file applies a unique replacement");
  assert.equal(run.output.trim(), STRUCTURED_RESULT, "the structured result is written to the output file");

  const firstRequest = parseRequest(run.requests[0]);
  assert.equal(firstRequest.options?.num_ctx, 32768, "contextTokens is sent as options.num_ctx, needing no derived model");
  const toolNames = (firstRequest.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
  assert.ok(toolNames.includes("write_file") && toolNames.includes("edit_file"), "a writable runner exposes the file-editing tools");
  assert.ok(!toolNames.includes("run_command"), "no shell or command-execution tool is ever exposed");

  const finalRequest = parseRequest(run.requests[run.requests.length - 1]);
  assert.ok(!("tools" in finalRequest), "the schema-forced final turn carries no tools");
  assert.ok("format" in finalRequest && finalRequest.think === false, "the final turn forces the schema and disables reasoning");
});

// --- workspace containment -------------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:175-198.
test("lean worker: relative paths that climb out of the workspace are refused", { timeout: 30_000 }, async () => {
  const escapeRoot = join(TEST_ROOT, "escape");
  const escapeWorkspace = join(escapeRoot, "ws");
  mkdirSync(escapeWorkspace, { recursive: true });
  writeFileSync(join(escapeRoot, "secret.txt"), "SECRET", "utf8");

  const escape = await runWorkerAgainstStub({
    workspace: escapeWorkspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "../secret.txt" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("write_file", { path: "../escaped.txt", content: "x" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const escapeToolResults = toolResultContents(parseRequest(escape.requests[escape.requests.length - 1]));
  assert.equal(
    escapeToolResults.filter((r) => /escapes the workspace/.test(r)).length,
    2,
    "relative paths that climb out of the workspace are refused",
  );
  assert.ok(!escapeToolResults.includes("SECRET"), "a refused read returns no file content");
  assert.ok(!existsSync(join(escapeRoot, "escaped.txt")), "a refused write creates nothing outside the workspace");

  const absolute = await runWorkerAgainstStub({
    workspace: escapeWorkspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: join(escapeRoot, "secret.txt") })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const absoluteResults = toolResultContents(parseRequest(absolute.requests[absolute.requests.length - 1]));
  assert.equal(
    absoluteResults.filter((r) => /must be workspace-relative/.test(r)).length,
    1,
    "absolute paths are refused outright",
  );
});

// --- read-only boundary ------------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:200-214.
test("lean worker: a read-only runner cannot be talked into writing", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "readonly", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "keep me", "utf8");

  const readOnly = await runWorkerAgainstStub({
    workspace,
    readOnly: true,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("write_file", { path: "a.txt", content: "overwritten" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const readOnlyToolNames = (parseRequest(readOnly.requests[0]).tools as Array<{ function: { name: string } }>).map(
    (t) => t.function.name,
  );
  assert.ok(
    !readOnlyToolNames.includes("write_file") && !readOnlyToolNames.includes("edit_file"),
    "a read-only runner does not expose the file-editing tools at all",
  );
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8").trim(), "keep me", "a read-only runner cannot be talked into writing");
  const readOnlyToolResults = toolResultContents(parseRequest(readOnly.requests[readOnly.requests.length - 1]));
  assert.equal(
    readOnlyToolResults.filter((r) => /not available to a read-only runner/.test(r)).length,
    1,
    "calling an unadvertised editing tool is refused at dispatch, not merely unlisted",
  );
});

// --- tool result bounding ----------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:216-228.
test("lean worker: an oversized file read is truncated instead of flooding the context", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "bounded", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "big.txt"), "x".repeat(50_000), "utf8");

  const bounded = await runWorkerAgainstStub({
    workspace,
    maxToolResultChars: 1000,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "big.txt" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const boundedResult = toolResultContents(parseRequest(bounded.requests[bounded.requests.length - 1]))[0];
  assert.ok(boundedResult.length < 1200, "an oversized file read is truncated instead of flooding the context");
  assert.ok(/truncated after 1000 characters/.test(boundedResult), "the truncation is visible to the model rather than silent");
});

// --- empty structured result retries, then fails closed -----------------------------------
// Oracle: tests/test-lean-worker.ps1:230-248.
test("lean worker: an empty structured result is retried, then fails closed if it never recovers", { timeout: 30_000 }, async () => {
  const retryWorkspace = join(TEST_ROOT, "retry", "ws");
  mkdirSync(retryWorkspace, { recursive: true });
  const retry = await runWorkerAgainstStub({
    workspace: retryWorkspace,
    responses: [
      newAssistantResponse({ content: "nothing to do" }),
      newAssistantResponse({ content: "" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.ok(
    retry.exitCode === 0 && retry.output.trim() === STRUCTURED_RESULT,
    "an empty structured result is retried rather than failing a completed step",
  );

  const failWorkspace = join(TEST_ROOT, "fail", "ws");
  mkdirSync(failWorkspace, { recursive: true });
  const failed = await runWorkerAgainstStub({
    workspace: failWorkspace,
    responses: [
      newAssistantResponse({ content: "nothing to do" }),
      newAssistantResponse({ content: "" }),
      newAssistantResponse({ content: "" }),
      newAssistantResponse({ content: "" }),
    ],
  });
  assert.notEqual(failed.exitCode, 0, "a persistently empty structured result fails closed");
});

// --- omitted response counters ------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:250-258.
test("lean worker: a response without token counters does not abort a step whose work is already done", { timeout: 30_000 }, async () => {
  const omitWorkspace = join(TEST_ROOT, "omit", "ws");
  mkdirSync(omitWorkspace, { recursive: true });
  const omitted = await runWorkerAgainstStub({
    workspace: omitWorkspace,
    responses: [
      newAssistantResponse({ content: "nothing to do", omitTokenCounts: true }),
      newAssistantResponse({ content: STRUCTURED_RESULT, omitTokenCounts: true }),
    ],
  });
  assert.equal(omitted.exitCode, 0, "a response without token counters does not abort a step whose work is already done");
  assert.equal(omitted.output.trim(), STRUCTURED_RESULT, "the structured result still reaches the output file when counters are omitted");
});

// --- git metadata ---------------------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:260-273.
test("lean worker: git metadata is refused even though it sits inside the workspace", { timeout: 30_000 }, async () => {
  const gitWorkspace = join(TEST_ROOT, "gitmeta", "ws");
  mkdirSync(join(gitWorkspace, ".git"), { recursive: true });
  writeFileSync(join(gitWorkspace, ".git", "config"), "[core]", "utf8");

  const gitMeta = await runWorkerAgainstStub({
    workspace: gitWorkspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("write_file", { path: ".git/hooks/pre-commit", content: "evil" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: ".git/config" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const gitResults = toolResultContents(parseRequest(gitMeta.requests[gitMeta.requests.length - 1]));
  assert.equal(
    gitResults.filter((r) => /git metadata/.test(r)).length,
    2,
    "git metadata is refused even though it sits inside the workspace",
  );
  assert.ok(
    !existsSync(join(gitWorkspace, ".git", "hooks", "pre-commit")),
    "a worker cannot plant a git hook that HDO would later execute",
  );
});

// --- link traversal ---------------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:275-295. Skipped when this host refuses to create a
// directory junction without elevation, exactly like the PS oracle's own try/catch.
test(
  "lean worker: a link planted inside the workspace cannot be used to read outside it",
  { timeout: 30_000, skip: JUNCTION_AVAILABLE ? false : "junction creation unavailable on this host" },
  async () => {
    const linkWorkspace = join(TEST_ROOT, "link", "ws");
    mkdirSync(linkWorkspace, { recursive: true });
    const outsideDirectory = join(TEST_ROOT, "link", "outside");
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, "secret.txt"), "LINKED_SECRET", "utf8");
    symlinkSync(outsideDirectory, join(linkWorkspace, "escape"), "junction");

    const linked = await runWorkerAgainstStub({
      workspace: linkWorkspace,
      responses: [
        newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "escape/secret.txt" })] }),
        newAssistantResponse({ content: "stopped" }),
        newAssistantResponse({ content: STRUCTURED_RESULT }),
      ],
    });
    const linkedResults = toolResultContents(parseRequest(linked.requests[linked.requests.length - 1]));
    assert.ok(!linkedResults.includes("LINKED_SECRET"), "a link planted inside the workspace cannot be used to read outside it");
    assert.equal(
      linkedResults.filter((r) => /leaves the workspace/.test(r)).length,
      1,
      "link traversal is refused with a clear reason",
    );
  },
);

// --- long file remains reachable ---------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:297-310.
test("lean worker: a truncated read tells the model which line to resume from, and the tail stays reachable", { timeout: 30_000 }, async () => {
  const longWorkspace = join(TEST_ROOT, "long", "ws");
  mkdirSync(longWorkspace, { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 400; i++) lines.push(`line ${i} padding padding padding`);
  writeFileSync(join(longWorkspace, "long.txt"), lines.join("\n") + "\n", "utf8");

  const long = await runWorkerAgainstStub({
    workspace: longWorkspace,
    maxToolResultChars: 1000,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "long.txt" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "long.txt", start_line: 300 })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const longResults = toolResultContents(parseRequest(long.requests[long.requests.length - 1]));
  assert.ok(/start_line=\d+ to continue/.test(longResults[0]), "a truncated read tells the model which line to resume from");
  assert.ok(longResults[1].includes("line 300"), "the tail of a long file stays reachable through start_line");
});

// --- CRLF-tolerant editing ----------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:312-323.
test("lean worker: a multi-line edit expressed with LF still applies to a CRLF file, and keeps CRLF", { timeout: 30_000 }, async () => {
  const crlfWorkspace = join(TEST_ROOT, "crlf", "ws");
  mkdirSync(crlfWorkspace, { recursive: true });
  writeFileSync(join(crlfWorkspace, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");

  await runWorkerAgainstStub({
    workspace: crlfWorkspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("edit_file", { path: "crlf.txt", old_text: "alpha\nbeta", new_text: "alpha\ndelta" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const crlfContent = readFileSync(join(crlfWorkspace, "crlf.txt"), "utf8");
  assert.ok(crlfContent.includes("delta"), "a multi-line edit expressed with LF still applies to a CRLF file");
  assert.ok(crlfContent.includes("alpha\r\ndelta"), "the file keeps its original CRLF convention after the edit");
});

// --- upstream error detail ----------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:325-376. The PS oracle needs a raw TcpListener and a
// half-close (`Socket.Shutdown(Send)`) because Windows PowerShell's `Invoke-RestMethod`
// otherwise resets the connection before the client reads the body. Node's `fetch` has no
// such quirk: an ordinary `node:http` response with a non-2xx status and a JSON body is
// read correctly, so this reproduces the SCENARIO (a non-200 response whose body reaches
// stderr) without needing the PS oracle's transport-level workaround.
test("lean worker: an upstream error fails the worker and surfaces the response body, not just the HTTP status", { timeout: 30_000 }, async () => {
  const errorWorkspace = join(TEST_ROOT, "error", "ws");
  mkdirSync(errorWorkspace, { recursive: true });

  const errorBody = '{"error":"unloadable-stub-model"}';
  let requestCount = 0;
  // startStubServer always answers 200; this scenario needs a scripted non-2xx status,
  // so it stands up its own minimal server directly instead of reusing that helper.
  const errorServer = createServer((req, res) => {
    requestCount += 1;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(errorBody);
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    errorServer.once("error", reject);
    errorServer.listen(0, "127.0.0.1", () => {
      const address = errorServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("error stub server did not bind to a TCP port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
  try {
    const errorResult = await runWorkerProcess({
      ollamaUri: `http://127.0.0.1:${port}/api/chat`,
      workspace: errorWorkspace,
      prompt: "x",
    });
    assert.notEqual(errorResult.exitCode, 0, "an upstream error fails the worker");
    assert.ok(/unloadable-stub-model/.test(errorResult.stderr), "the upstream error body is surfaced, not just the HTTP status");
    assert.ok(requestCount >= 1, "the error server actually received the request");
  } finally {
    await new Promise<void>((res) => errorServer.close(() => res()));
  }
});

// --- turn limit --------------------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:378-389.
test("lean worker: hitting the turn limit still produces a reportable result", { timeout: 30_000 }, async () => {
  const turnWorkspace = join(TEST_ROOT, "turns", "ws");
  mkdirSync(turnWorkspace, { recursive: true });
  writeFileSync(join(turnWorkspace, "a.txt"), "text", "utf8");

  const turnLimited = await runWorkerAgainstStub({
    workspace: turnWorkspace,
    maxTurns: 2,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(turnLimited.exitCode, 0, "hitting the turn limit still produces a reportable result");
  const turnMessages = parseRequest(turnLimited.requests[turnLimited.requests.length - 1]).messages.map((m) => String(m.content));
  assert.ok(turnMessages.some((m) => /turn limit/.test(m)), "the turn limit is reported back for the blockers field");
});

// --- context discipline in the system prompt ----------------------------------------------
// Oracle: tests/test-lean-worker.ps1:391-406.
test("lean worker: the system prompt's context discipline matches the runner's capabilities", { timeout: 30_000 }, async () => {
  const promptWorkspace = join(TEST_ROOT, "prompt", "ws");
  mkdirSync(promptWorkspace, { recursive: true });

  const promptRun = await runWorkerAgainstStub({
    workspace: promptWorkspace,
    responses: [newAssistantResponse({ content: "nothing to do" }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  const writableSystemPrompt = String(parseRequest(promptRun.requests[0]).messages[0].content);
  assert.ok(writableSystemPrompt.includes("use edit_file"), "the system prompt tells a writable runner to prefer edit_file over resending a whole file");
  assert.ok(writableSystemPrompt.includes("max_lines"), "the system prompt points at the narrow-read arguments");

  const readOnlyPromptRun = await runWorkerAgainstStub({
    workspace: promptWorkspace,
    readOnly: true,
    responses: [newAssistantResponse({ content: "nothing to do" }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  const readOnlySystemPrompt = String(parseRequest(readOnlyPromptRun.requests[0]).messages[0].content);
  assert.ok(!readOnlySystemPrompt.includes("edit_file"), "a read-only runner is not told about editing tools it does not have");
});

// --- bounded reads and searches -------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:408-428.
test("lean worker: read_file honours max_lines and search_files honours max_results / its default cap", { timeout: 30_000 }, async () => {
  const windowWorkspace = join(TEST_ROOT, "window", "ws");
  mkdirSync(windowWorkspace, { recursive: true });
  const longLines: string[] = [];
  for (let i = 1; i <= 400; i++) longLines.push(`line ${i}`);
  writeFileSync(join(windowWorkspace, "long.txt"), longLines.join("\n") + "\n", "utf8");
  const manyLines: string[] = [];
  for (let i = 1; i <= 150; i++) manyLines.push(`needle ${i}`);
  writeFileSync(join(windowWorkspace, "many.txt"), manyLines.join("\n") + "\n", "utf8");

  const windowed = await runWorkerAgainstStub({
    workspace: windowWorkspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "long.txt", start_line: 10, max_lines: 5 })] }),
      newAssistantResponse({ toolCalls: [newToolCall("search_files", { pattern: "needle", include: "many.txt", max_results: 3 })] }),
      newAssistantResponse({ toolCalls: [newToolCall("search_files", { pattern: "needle", include: "many.txt" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  const windowResults = toolResultContents(parseRequest(windowed.requests[windowed.requests.length - 1]));
  assert.ok(/\[long\.txt lines 10-14 of 400\]/.test(windowResults[0]), "read_file honours max_lines and labels the window it returned");
  assert.ok(windowResults[0].includes("line 14") && !windowResults[0].includes("line 15"), "max_lines stops exactly where it was told to");
  assert.ok(/start_line=15 to continue/.test(windowResults[0]), "a windowed read says where to resume");
  assert.ok(/showing 3 of 150 matches/.test(windowResults[1]), "search_files honours max_results");
  assert.ok(/showing 100 of 150 matches/.test(windowResults[2]), "search_files caps an unbounded search by default");
});
