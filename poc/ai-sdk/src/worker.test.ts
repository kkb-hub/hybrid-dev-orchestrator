// End-to-end deterministic tests for this PoC's worker (poc/ai-sdk/src/main.ts), run
// against a scripted `node:http` stub standing in for Ollama - see testHarness.ts for why
// the stub binds an ephemeral port and why the worker is launched with the ASYNC
// child_process API.
//
// These are deliberately modelled on (and in the compaction case, nearly line-for-line
// mirror) src/workers/leanWorker/toolLoop.test.ts and compaction.test.ts: the point of
// this PoC is a FAIR comparison against the zero-dependency baseline, so the strongest
// evidence that the AI SDK route is a genuine counterpart - not a toy - is that it can be
// driven through the identical scripted exchanges, in the identical request order, and
// produce the identical worker-visible behaviour (ADR-0001 Migration strategy phase 8
// step (b); ADR-0003 Decision D2 (b), D3).
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newAssistantResponse, newToolCall, parseRequest, runWorkerAgainstStub, STRUCTURED_RESULT, toolResultContents } from "./testHarness.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "hdo-ai-sdk-poc-worker-"));

/** Same junction-availability probe as toolLoop.test.ts, so the link-traversal case skips
 * cleanly on a host that refuses directory junctions without elevation. */
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

// --- tool loop, editing, structured output, and num_ctx -------------------------------------
// Counterpart of toolLoop.test.ts's "tool loop, editing, and structured output".
test("ai-sdk poc: tool loop, editing, structured output, and per-request num_ctx", { timeout: 30_000 }, async () => {
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

  assert.equal(run.exitCode, 0, `the worker exits zero after a successful tool loop (stderr: ${run.stderr})`);
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8").trim(), "replaced text", "edit_file applies a unique replacement");
  assert.equal(run.output.trim(), STRUCTURED_RESULT, "the structured result is written to the output file");

  // num_ctx travels through providerOptions.ollama.options.num_ctx on EVERY request, not
  // just the first - the tool-loop steps and the separate forced-schema final call alike.
  assert.equal(run.requests.length, 4, "one HTTP request per tool-loop step, plus one for the separate final call");
  for (const raw of run.requests) {
    assert.equal(parseRequest(raw).options?.num_ctx, 32768, "contextTokens reaches Ollama as options.num_ctx on every request");
  }

  const firstRequest = parseRequest(run.requests[0]);
  const toolNames = (firstRequest.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
  assert.ok(toolNames.includes("write_file") && toolNames.includes("edit_file"), "a writable runner exposes the file-editing tools");
  assert.ok(
    !toolNames.some((name) => /^(run_command|shell|git|bash|exec)$/i.test(name)),
    "no shell or command-execution tool is ever exposed",
  );

  const finalRequest = parseRequest(run.requests[run.requests.length - 1]);
  assert.ok(!("tools" in finalRequest), "the schema-forced final turn carries no tools");
  assert.ok("format" in finalRequest && finalRequest.think === false, "the final turn forces the schema and disables reasoning");
});

// --- workspace containment -------------------------------------------------------------------
// Counterpart of toolLoop.test.ts's "relative paths that climb out of the workspace are
// refused" - proves the reused workspaceGuard.ts guard, not a second implementation of it.
test("ai-sdk poc: workspace-escape and absolute-path rejections come from the reused guard verbatim", { timeout: 30_000 }, async () => {
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
  assert.equal(escape.exitCode, 0, `run completes despite the refusals (stderr: ${escape.stderr})`);
  const escapeToolResults = toolResultContents(parseRequest(escape.requests[escape.requests.length - 1]));
  assert.equal(
    escapeToolResults.filter((r) => /escapes the workspace/.test(r)).length,
    2,
    "relative paths that climb out of the workspace are refused with the guard's exact message",
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
    "absolute paths are refused outright with the guard's exact message",
  );
});

// --- git metadata ---------------------------------------------------------------------------
// Counterpart of toolLoop.test.ts's "git metadata is refused even though it sits inside
// the workspace".
test("ai-sdk poc: git metadata is refused with the reused guard's exact message", { timeout: 30_000 }, async () => {
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
  assert.ok(!existsSync(join(gitWorkspace, ".git", "hooks", "pre-commit")), "a worker cannot plant a git hook that HDO would later execute");
});

// --- link traversal ---------------------------------------------------------------------
// Counterpart of toolLoop.test.ts's "a link planted inside the workspace cannot be used to
// read outside it". Skipped when this host refuses directory junctions without elevation.
test(
  "ai-sdk poc: a link planted inside the workspace cannot be used to read outside it",
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
      "link traversal is refused with the guard's exact reason",
    );
  },
);

// --- read-only boundary ------------------------------------------------------------------
// Counterpart of toolLoop.test.ts's "a read-only runner cannot be talked into writing" -
// the wire-level proof of ADR-0003 D3's "structurally absent, not merely disabled": the
// request the AI SDK actually sent to Ollama never lists write_file/edit_file as callable
// tools at all, not just that a call to them is rejected afterwards.
test("ai-sdk poc: a read-only runner never advertises write_file/edit_file as tools", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "readonly", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "keep me", "utf8");

  const readOnly = await runWorkerAgainstStub({
    workspace,
    readOnly: true,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: "stopped" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(readOnly.exitCode, 0, `run completes (stderr: ${readOnly.stderr})`);
  const readOnlyToolNames = (parseRequest(readOnly.requests[0]).tools as Array<{ function: { name: string } }>).map(
    (t) => t.function.name,
  );
  assert.ok(
    !readOnlyToolNames.includes("write_file") && !readOnlyToolNames.includes("edit_file"),
    "a read-only runner's tool set structurally omits the file-editing tools - not disabled, absent",
  );
  assert.equal(readFileSync(join(workspace, "a.txt"), "utf8").trim(), "keep me", "nothing was written");
});

// --- empty structured result retries, then fails closed -----------------------------------
// Counterpart of toolLoop.test.ts's "an empty structured result is retried, then fails
// closed if it never recovers" - proves the two-stage shape (tool loop, then a SEPARATE
// forced-schema call with up to 3 retries) survives the AI SDK's `Output.object` throwing
// `NoObjectGeneratedError` on an unparseable/empty response rather than the baseline's
// plain "content came back empty" check.
test("ai-sdk poc: an empty structured result is retried, then fails closed if it never recovers", { timeout: 30_000 }, async () => {
  const retryWorkspace = join(TEST_ROOT, "retry", "ws");
  mkdirSync(retryWorkspace, { recursive: true });
  const retry = await runWorkerAgainstStub({
    workspace: retryWorkspace,
    responses: [newAssistantResponse({ content: "nothing to do" }), newAssistantResponse({ content: "" }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  assert.ok(
    retry.exitCode === 0 && retry.output.trim() === STRUCTURED_RESULT,
    `an empty structured result is retried rather than failing a completed step (stderr: ${retry.stderr})`,
  );
  assert.ok(/Structured result attempt 1 of 3 came back empty; retrying\./.test(retry.stderr), "the retry is reported on stderr");

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

// --- token-aware compaction ----------------------------------------------------------------
// Line-for-line counterpart of compaction.test.ts's "token-aware compaction rewrites the
// history and labels observed vs. model-summarized facts" - same scripted exchange, same
// request count and order, run against this worker instead. If the AI SDK route needed a
// DIFFERENT number or order of requests to reach the same outcome, that divergence would be
// exactly the kind of fact ADR-0003's Decision D2 (c) needs to see.
test("ai-sdk poc: token-aware compaction rewrites the history the same way the baseline's does", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "compact", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const summaryJson = JSON.stringify({
    goal: "replace the text in a.txt",
    constraints: ["touch no other file"],
    filesInspected: ["a.txt"],
    filesChanged: ["a.txt"],
    decisions: ["edited in place instead of rewriting"],
    failedAttempts: [],
    currentState: "the edit is applied",
    remainingWork: ["report the result"],
  });
  const readA = newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] });
  const editA = newAssistantResponse({
    promptTokens: 25000,
    toolCalls: [newToolCall("edit_file", { path: "a.txt", old_text: "original", new_text: "replaced" })],
  });
  const summaryReply = newAssistantResponse({ content: summaryJson });
  const finishedReply = newAssistantResponse({ content: "finished" });
  const structuredReply = newAssistantResponse({ content: STRUCTURED_RESULT });

  const compacted = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 2,
    prompt: "replace original with replaced in a.txt",
    responses: [readA, editA, summaryReply, finishedReply, summaryReply, structuredReply],
  });
  assert.equal(compacted.exitCode, 0, `a run that compacts its history still completes (stderr: ${compacted.stderr})`);
  assert.ok(/compaction: turn=2 reason=threshold/.test(compacted.stdout), "compaction is triggered by the reported prompt token count");
  assert.equal(compacted.requests.length, 6, "the same 6-request sequence as the zero-dependency baseline for this scenario");

  const summaryRequest = parseRequest(compacted.requests[2]);
  assert.ok(!("tools" in summaryRequest), "the summarization call carries no tools");
  assert.ok(
    summaryRequest.format?.required?.includes("currentState") && summaryRequest.format?.required?.includes("failedAttempts"),
    "the summarization call forces the structured working-summary schema",
  );
});
