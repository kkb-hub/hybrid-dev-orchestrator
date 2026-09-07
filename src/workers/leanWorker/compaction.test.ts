// Port of tests/test-lean-worker.ps1's token-aware compaction cases (PR #55, lines
// 430-703): context accounting, the working summary the model produces, the
// worker-verified state block, and the interaction between the in-loop threshold check
// and the pre-final-report reduction. See toolLoop.test.ts for the tool-loop/boundary
// half of the same PS file, and testHarness.ts for the stub-server/child-process
// mechanics both files share.
//
// Every scenario drives compaction by scripting `prompt_eval_count` in the stub's
// responses (the `promptTokens` option on `newAssistantResponse`) rather than by
// producing a genuinely huge conversation - exactly the technique the PS oracle uses,
// carried across unchanged.
//
// Request/message index references below are copied directly from the PS oracle's own
// `$run.requests[N]`/`.messages[N]` indices: both implementations run the identical
// scripted exchange in the identical order, so a given scenario produces the same
// number of requests, in the same order, in both languages - if it doesn't, that is
// itself a divergence worth failing loudly on.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STRUCTURED_RESULT, newAssistantResponse, newToolCall, parseRequest, runWorkerAgainstStub } from "./testHarness.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "hdo-lean-worker-compaction-"));
test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

const SUMMARY_JSON = JSON.stringify({
  goal: "replace the text in a.txt",
  constraints: ["touch no other file"],
  filesInspected: ["a.txt"],
  filesChanged: ["a.txt"],
  decisions: ["edited in place instead of rewriting"],
  failedAttempts: [],
  currentState: "the edit is applied",
  remainingWork: ["report the result"],
});

const READ_A = newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] });
const EDIT_A = newAssistantResponse({
  promptTokens: 25000,
  toolCalls: [newToolCall("edit_file", { path: "a.txt", old_text: "original", new_text: "replaced" })],
});
const SUMMARY_REPLY = newAssistantResponse({ content: SUMMARY_JSON });
const FINISHED_REPLY = newAssistantResponse({ content: "finished" });
const STRUCTURED_REPLY = newAssistantResponse({ content: STRUCTURED_RESULT });
const EMPTY_REPLY = newAssistantResponse({ content: "" });

function messagesOf(raw: string): Array<{ role: string; content: string }> {
  return parseRequest(raw).messages as Array<{ role: string; content: string }>;
}

// --- token-aware compaction ----------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:430-472. 32768 * 65% is 21299, so the second turn's
// scripted counter (25000) puts the next request over the threshold. KeepRecentMessages
// is 2 here purely to leave something droppable in a conversation this short.
test("lean worker: token-aware compaction rewrites the history and labels observed vs. model-summarized facts", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "compact", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  // Two summarization replies: one for the in-loop compaction, one for the reduction
  // before the final report, which re-summarizes the turns the first one did not cover.
  const compacted = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 2,
    prompt: "replace original with replaced in a.txt",
    responses: [READ_A, EDIT_A, SUMMARY_REPLY, FINISHED_REPLY, SUMMARY_REPLY, STRUCTURED_REPLY],
  });
  assert.equal(compacted.exitCode, 0, "a run that compacts its history still completes");
  assert.ok(/compaction: turn=2 reason=threshold/.test(compacted.stdout), "compaction is triggered by the reported prompt token count");
  assert.ok(
    /prompt_tokens_before~\d+ prompt_tokens_after~\d+ messages=\d+->\d+/.test(compacted.stdout),
    "the diagnostic reports the turn and the token count on both sides",
  );

  const summaryRequest = parseRequest(compacted.requests[2]);
  assert.ok(!("tools" in summaryRequest), "the summarization call carries no tools");
  assert.ok(
    summaryRequest.format?.required?.includes("currentState") && summaryRequest.format?.required?.includes("failedAttempts"),
    "the summarization call forces the structured working-summary schema",
  );
  assert.equal(summaryRequest.messages.length, 2, "the summarization call is its own conversation, not a replay of the session");

  const afterCompaction = messagesOf(compacted.requests[3]);
  assert.ok(afterCompaction.length < 6, "the rebuilt history is shorter than the conversation it replaced");
  assert.ok(/replace original with replaced in a\.txt/.test(afterCompaction[1].content), "the original task survives compaction verbatim");
  const block = afterCompaction[2].content;
  assert.ok(/HDO CONTEXT COMPACTION \(after turn 2\)/.test(block), "the dropped turns are replaced by a labelled compaction block");
  assert.ok(block.includes("Verified by the orchestrator") && block.includes("model-generated"), "observed facts and the model summary are labelled apart");
  assert.ok(/Files read: a\.txt/.test(block), "the compaction block keeps the worker-observed list of files read");
  assert.ok(/Files changed: a\.txt \(1 edit\(s\)\)/.test(block), "the compaction block keeps the worker-observed record of what changed");
  assert.ok(block.includes("Tool errors: (none)") && block.includes("Recent actions"), "the compaction block keeps tool errors and recent actions");
  assert.ok(
    block.includes("Goal: replace the text in a.txt") && block.includes("Current state: the edit is applied"),
    "the model working summary is folded into the block",
  );
  assert.ok(block.includes("Remaining work") && block.includes("Failed attempts"), "the working summary carries the remaining work and failed attempts");
  const retained = afterCompaction.filter((m) => m.role === "tool").map((m) => m.content);
  assert.ok(retained.includes("edited a.txt"), "the most recent tool interaction is retained after compaction");
  assert.equal(afterCompaction[3].role, "assistant", "the retained tail starts at the assistant turn that owns the tool result");
});

// --- one oversized exchange is still compactable --------------------------------------------
// Oracle: tests/test-lean-worker.ps1:474-493. A single assistant turn answering with eight
// parallel tool calls puts the retained window inside the first exchange, so walking the
// boundary back reaches the protected prefix. The whole exchange has to be dropped instead:
// declining would leave the over-window request to go out unchanged.
test("lean worker: a single oversized exchange is compacted rather than declined", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "parallel", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const parallelToolCalls = Array.from({ length: 8 }, () => newToolCall("read_file", { path: "a.txt" }));
  const parallel = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ promptTokens: 25000, toolCalls: parallelToolCalls }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: "finished" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(parallel.exitCode, 0, "an exchange too large for the window on its own still completes");
  assert.ok(/compaction: turn=1 reason=threshold/.test(parallel.stdout), "a single oversized exchange is compacted rather than declined");
  assert.ok(!/skipped/.test(parallel.stdout), "compaction is not abandoned when the retained window falls inside one exchange");
  const parallelAfter = messagesOf(parallel.requests[2]);
  assert.equal(parallelAfter.length, 3, "the oversized exchange is replaced by the compaction block");
  assert.ok(/Files read: a\.txt/.test(parallelAfter[2].content), "what the oversized exchange established is kept as verified state");
});

// --- the provider's counter wins over the local estimate ------------------------------------
// Oracle: tests/test-lean-worker.ps1:495-513. One small exchange, a window that easily
// holds it by the local estimate, and a provider that says the prompt is already at 76%
// of it. The counter is the authority: declining to compact here would send the
// over-window request unchanged.
test("lean worker: the reported prompt token count compacts even when the local estimate disagrees", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "trust", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const trust = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ promptTokens: 25000, toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: "finished" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(trust.exitCode, 0, "a compaction driven by the provider counter alone still completes");
  assert.ok(/compaction: turn=1 reason=threshold/.test(trust.stdout), "the reported token count compacts even when the local estimate disagrees");
  assert.ok(!/skipped/.test(trust.stdout), "a triggered compaction always reclaims at least the oldest exchange");
  const trustAfter = messagesOf(trust.requests[2]);
  assert.ok(trustAfter.length === 3 && /HDO CONTEXT COMPACTION/.test(trustAfter[2].content), "the oldest exchange is what gets reclaimed");
});

// --- the final reduction covers the turns since the last compaction -------------------------
// Oracle: tests/test-lean-worker.ps1:514-539.
test("lean worker: the final reduction summarizes the turns taken after the last compaction, carrying the earlier summary forward", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "stale", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");
  writeFileSync(join(workspace, "b.txt"), "beta marker content", "utf8");
  writeFileSync(join(workspace, "c.txt"), "gamma marker content", "utf8");

  const stale = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 4,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ promptTokens: 25000, toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "b.txt" })] }),
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "c.txt" })] }),
      newAssistantResponse({ content: "done" }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(stale.exitCode, 0, "a run that compacts and then reduces for the final report still completes");
  assert.ok(/reason=threshold/.test(stale.stdout) && /reason=final/.test(stale.stdout), "both the in-loop compaction and the final reduction run");

  const lastSummaryRequest = parseRequest(stale.requests[6]);
  assert.ok(lastSummaryRequest.format?.required?.includes("currentState"), "the final reduction summarizes rather than reusing the earlier summary");
  const lastDigest = String((lastSummaryRequest.messages as Array<{ content: string }>)[1].content);
  assert.ok(lastDigest.includes("beta marker content"), "the turns taken after the last compaction are the ones summarized");
  assert.ok(lastDigest.includes("carried over from the previous compaction"), "the earlier summary is carried into the new one rather than replaced");

  const staleFinal = messagesOf(stale.requests[stale.requests.length - 1]);
  assert.equal(staleFinal.filter((m) => m.content.includes("gamma marker content")).length, 1, "the newest turn stays in the retained tail rather than being summarized away");
  assert.ok(/HDO WORKING STATE/.test(staleFinal[2].content), "the final report is given the working state that covers the summarized turns");
});

// --- an oversized closing turn is still reduced before the final report ---------------------
// Oracle: tests/test-lean-worker.ps1:541-566. The model calls no tools on its very first
// turn, so the loop breaks immediately after appending that assistant message, before the
// in-loop compaction check further down the loop body ever runs. The message content
// itself (not just the scripted counter) is genuinely large: nothing bounds a closing
// turn's content the way maxToolResultChars bounds a tool result, so a verbose local model
// can reach this for real.
//
// The in-loop attempt this test also exercises still declines ("skipped"): with only this
// one turn beyond the protected prefix, there is nothing else to drop alongside it, and
// invokeContextCompaction requires dropping at least two messages before it is willing to
// spend a summarization call. That is correct given the loop might still continue.
// compressFinalContext runs unconditionally once the loop ends, though, and is where a
// lone oversized message actually gets caught.
test("lean worker: an oversized closing turn is caught by the final reduction, not the in-loop check", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "closing", "ws");
  mkdirSync(workspace, { recursive: true });
  const closingContent = "x".repeat(100_000);

  const closingTurn = await runWorkerAgainstStub({
    workspace,
    responses: [newAssistantResponse({ content: closingContent }), newAssistantResponse({ content: SUMMARY_JSON }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  assert.equal(closingTurn.exitCode, 0, "a run that closes on an oversized final turn still completes");
  assert.ok(/compaction: turn=1 skipped/.test(closingTurn.stdout), "the loop-break compaction check runs and correctly declines a single-message drop");
  assert.ok(/compaction: turn=1 reason=final/.test(closingTurn.stdout), "the oversized closing turn is still caught by the final reduction");
  const closingFinal = messagesOf(closingTurn.requests[closingTurn.requests.length - 1]);
  assert.ok(!closingFinal.map((m) => m.content).join("").includes(closingContent), "the oversized closing content does not reach the final schema-forced request unreduced");
});

// --- a compaction on the closing turn is not immediately repeated ---------------------------
// Oracle: tests/test-lean-worker.ps1:568-586. An ordinary tool call on turn 1, then a turn
// 2 that calls no tools and is itself huge enough to force the break-path compaction to
// actually drop something (dropping just the closing message alone would not clear
// requireDrop's two-message minimum, but dropping it together with turn 1's exchange
// does). That compaction runs on turn 2, the same turn number compressFinalContext then
// receives as `turnsUsed`, which is exactly the case the `lastCompactionTurn` guard exists
// for.
test("lean worker: a reduction is not repeated immediately after a compaction that ran on the same closing turn", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "nodouble", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");
  const closingContent = "x".repeat(100_000);

  const noDouble = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: closingContent }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(noDouble.exitCode, 0, "a session that compacts on its closing turn still completes");
  assert.ok(/compaction: turn=2 reason=threshold/.test(noDouble.stdout), "the closing turn itself is what triggers the compaction");
  assert.ok(!/reason=final/.test(noDouble.stdout), "a reduction is not repeated immediately after a compaction that just ran on the same turn");
});

// --- a file read once windowed and once whole is recorded once, correctly -------------------
// Oracle: tests/test-lean-worker.ps1:588-604.
test("lean worker: a file read once windowed and once whole is recorded once, as whole", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "reread", "ws");
  mkdirSync(workspace, { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
  writeFileSync(join(workspace, "a.txt"), lines.join("\n") + "\n", "utf8");

  const reread = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "a.txt", start_line: 1, max_lines: 5 })] }),
      newAssistantResponse({ promptTokens: 25000, toolCalls: [newToolCall("read_file", { path: "a.txt" })] }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: "done" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(reread.exitCode, 0, "reading a file both windowed and in full still completes");
  // requests[0]=turn1, [1]=turn2 (triggers compaction), [2]=the summarization call
  // itself, [3]=turn3's request, which carries the rebuilt history the compaction
  // produced.
  const rereadBlock = messagesOf(reread.requests[3])[2].content;
  assert.ok(/Files read: a\.txt(\r?\n|$)/.test(rereadBlock), "a file read once partially and later in full is recorded once, as whole");
  assert.ok(!/a\.txt \(partial\)/.test(rereadBlock), "the earlier partial record does not survive alongside the later whole one");
});

// --- a whole read of a file containing the truncation marker text is not misread ------------
// Oracle: tests/test-lean-worker.ps1:606-627. workers/hdo-ollama-worker.ps1 (and this TS
// port's own tool-result strings) contain the literal marker substrings this test checks
// for, which is exactly the self-referential case the structural `readWasWhole` flag
// exists to get right instead of by matching the returned text.
test("lean worker: a whole read is recorded as whole even when its content contains truncation marker text", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "marker", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "quote.txt"),
    [
      "this file quotes error text that looks like a truncation marker:",
      "...[truncated after 20000 characters; call read_file again with start_line=1 to continue]",
      "...[stopped at max_lines; call read_file with start_line=2 to continue]",
    ].join("\n") + "\n",
    "utf8",
  );

  const marker = await runWorkerAgainstStub({
    workspace,
    responses: [
      newAssistantResponse({ promptTokens: 25000, toolCalls: [newToolCall("read_file", { path: "quote.txt" })] }),
      newAssistantResponse({ content: SUMMARY_JSON }),
      newAssistantResponse({ content: "done" }),
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(marker.exitCode, 0, "reading a file that itself contains truncation marker text still completes");
  // requests[0]=turn1 (triggers compaction), [1]=the summarization call, [2]=turn2's
  // request, which carries the rebuilt history.
  const markerBlock = messagesOf(marker.requests[2])[2].content;
  assert.ok(/Files read: quote\.txt(\r?\n|$)/.test(markerBlock), "a whole read is recorded as whole even when its content contains truncation marker text");
});

// --- compaction survives a summarizer that returns nothing usable ---------------------------
// Oracle: tests/test-lean-worker.ps1:629-639.
test("lean worker: an unusable summary does not fail a step whose work is already on disk", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "degraded", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const degraded = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 2,
    responses: [READ_A, EDIT_A, EMPTY_REPLY, FINISHED_REPLY, EMPTY_REPLY, STRUCTURED_REPLY],
  });
  assert.equal(degraded.exitCode, 0, "an unusable summary does not fail a step whose work is already on disk");
  const degradedBlock = messagesOf(degraded.requests[3])[2].content;
  assert.ok(/Files changed: a\.txt/.test(degradedBlock), "the worker-observed state survives even when the summarizer returns nothing");
  assert.ok(degradedBlock.includes("unavailable"), "a missing summary is stated rather than silently left blank");
});

// --- compaction can be turned off ------------------------------------------------------------
// Oracle: tests/test-lean-worker.ps1:641-651.
test("lean worker: disabling compaction (CompactAtPercent=0) replays the full history unconditionally", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "disabled", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const disabled = await runWorkerAgainstStub({
    workspace,
    compactAtPercent: 0,
    keepRecentMessages: 2,
    responses: [READ_A, EDIT_A, FINISHED_REPLY, STRUCTURED_REPLY],
  });
  assert.equal(disabled.exitCode, 0, "disabling compaction keeps the worker working");
  assert.ok(!/compaction:/.test(disabled.stdout), "no compaction happens when it is disabled, however large the prompt gets");
  const disabledFinal = messagesOf(disabled.requests[disabled.requests.length - 1]);
  assert.equal(disabledFinal.length, 8, "the full history is still replayed when compaction is disabled");
  assert.equal(disabledFinal.filter((m) => m.role === "tool").length, 2, "every tool result is still present when compaction is disabled");
});

// --- the final report does not replay an expensive tool loop --------------------------------
// Oracle: tests/test-lean-worker.ps1:653-687. The scripted prompt_eval_count stays at 100,
// so nothing compacts during the loop; the 4096-token window is what makes the
// accumulated transcript expensive enough for the final reduction to be worth doing.
test("lean worker: the final report reduces an expensive-but-uncompacted history before the schema-forced request", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "finalctx", "ws");
  mkdirSync(workspace, { recursive: true });
  const bigLines: string[] = [];
  for (let i = 1; i <= 100; i++) bigLines.push(`line ${i} of the file under inspection`);
  writeFileSync(join(workspace, "big.txt"), bigLines.join("\n") + "\n", "utf8");

  // Every read here is windowed (max_lines short of the file's length), so the file is
  // never read whole across the scenario and the partial marker stays meaningful.
  const expensiveReads = [1, 2, 3, 4].map((startLine) =>
    newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "big.txt", start_line: startLine, max_lines: 50 })] }),
  );
  // The model stops calling tools on the turn that crossed the threshold, so the loop
  // breaks before any compaction runs and the reduction has to produce the summary
  // itself: hence a summarization response before the structured one.
  const finalReduced = await runWorkerAgainstStub({
    workspace,
    contextTokens: 4096,
    keepRecentMessages: 2,
    prompt: "inspect big.txt four times",
    responses: [...expensiveReads, newAssistantResponse({ content: "done" }), newAssistantResponse({ content: SUMMARY_JSON }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  assert.equal(finalReduced.exitCode, 0, "reducing the history before the final report keeps the run successful");
  assert.ok(/compaction: turn=5 reason=final/.test(finalReduced.stdout), "the reduction before the final report is reported in the diagnostics");
  const finalMessages = messagesOf(finalReduced.requests[finalReduced.requests.length - 1]);
  assert.ok(finalMessages.length < 11, "the final structured turn does not replay the whole tool loop");
  assert.ok(/inspect big\.txt four times/.test(finalMessages[1].content), "the original task is still present for the final report");
  assert.ok(/HDO WORKING STATE/.test(finalMessages[2].content), "the final report is given the compacted working state");
  assert.ok(/Files read: big\.txt/.test(finalMessages[2].content), "the compacted working state carries what the worker observed");
  assert.ok(/big\.txt \(partial\)/.test(finalMessages[2].content), "a windowed read is recorded as partial, not as a file already read in full");
  assert.ok(
    finalMessages[2].content.includes("Current state: the edit is applied") && !finalMessages[2].content.includes("unavailable"),
    "a reduction with no earlier summary writes one instead of reporting from facts alone",
  );
  assert.ok(/matching the required schema/.test(finalMessages[finalMessages.length - 1].content), "the final instruction still closes the reduced conversation");
});

// --- a transcript the run can still afford is not thrown away -------------------------------
// Oracle: tests/test-lean-worker.ps1:689-703. Same shape, but a window wide enough that
// the accumulated history is cheap. Replacing it would cost the final report its actual
// transcript and hand it only the terse verified facts, because no compaction has run to
// write the model half of the block.
test("lean worker: a history the run can still afford is not thrown away before the final report", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "affordable", "ws");
  mkdirSync(workspace, { recursive: true });
  const bigLines: string[] = [];
  for (let i = 1; i <= 100; i++) bigLines.push(`line ${i} of the file under inspection`);
  writeFileSync(join(workspace, "big.txt"), bigLines.join("\n") + "\n", "utf8");

  const expensiveReads = [1, 2, 3, 4].map((startLine) =>
    newAssistantResponse({ toolCalls: [newToolCall("read_file", { path: "big.txt", start_line: startLine, max_lines: 50 })] }),
  );
  const affordable = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 2,
    prompt: "inspect big.txt four times",
    responses: [...expensiveReads, newAssistantResponse({ content: "done" }), newAssistantResponse({ content: STRUCTURED_RESULT })],
  });
  assert.equal(affordable.exitCode, 0, "a run whose history fits the window still completes");
  assert.ok(!/reason=final/.test(affordable.stdout), "a history that comfortably fits the window is not reduced");
  const affordableMessages = messagesOf(affordable.requests[affordable.requests.length - 1]);
  assert.equal(affordableMessages.length, 12, "the whole transcript still reaches the final report when it is affordable");
  assert.equal(affordableMessages.filter((m) => m.role === "tool").length, 4, "every tool result is still available to the final report");
});

// --- strengthening tests beyond the oracle's own coverage ------------------------------------
//
// Mutation testing over src/workers/leanWorker/ found two load-bearing compaction guards
// that every test above - including the ones ported verbatim from the PS oracle's own
// suite - fails to discriminate: the whole suite stays green even with the guard broken.
// The two tests below exist solely to close that gap. Both are NEW tests with no PS
// oracle counterpart (unlike every test above, which is a direct port); they encode
// scenarios chosen specifically to make the known-survivable mutations observable, and
// each was proven to fail-with-mutation/pass-without-mutation before being added here.

// (1) compaction.ts's `invokeContextCompaction`: deleting `session.lastCompactionTurn = turn`
// (or neutering the `session.lastCompactionTurn === turn` guard in `compressFinalContext`)
// survives every test above because in every scenario that reaches this guard, the OTHER
// short-circuit just above it - `original.length <= floor + keepRecentMessages + 1 &&
// !overThreshold` - already returns early regardless of `lastCompactionTurn`, since the
// post-compaction history in those scenarios is short AND under threshold. This test
// forces `overThreshold` to be true instead, so that guard cannot save it, leaving
// `lastCompactionTurn` as the only thing standing between "already reduced this turn" and
// a second, wasted reduction.
//
// The lever: `-ContextTokens 1024` (the flag's documented minimum) with the default
// `-CompactAtPercent 65` makes the compaction threshold tiny (666 estimated tokens) -
// small enough that the worker's OWN fixed system prompt (428 tokens on its own) plus a
// single compaction block (capped at maxBlockTokens=400, but able to reach that cap when
// the verified-state record and the model's summary both have enough to say) together
// clear it. A rich model-generated summary (long strings in every schema field) is what
// pushes the post-compaction history over 666: measured directly against this suite's own
// code before writing the assertions below, the correct implementation lands at
// prompt_tokens_after~845 (comfortably over the 666 threshold), so `overThreshold` is
// true precisely when `compressFinalContext` re-examines the same turn's history.
//
// Mutation proof (see the finding for the exact edits): with `session.lastCompactionTurn
// = turn;` deleted from `invokeContextCompaction` - or with the `session.lastCompactionTurn
// === turn` check in `compressFinalContext` replaced by `false && ...` - this scenario's
// stub only had 4 scripted responses (matching the correct run) and the worker CRASHED
// (exit code 1, "stub server received more requests than scripted responses"): the mutant
// makes a fifth, wasted summarization call that the correct implementation never makes.
// Restoring either line makes the run pass again with exactly 4 requests. That crash (or,
// with a 5th response scripted, a second "reason=final" line and a 5th request) is exactly
// what the assertions below rule out.
test("lean worker: a same-turn compaction is not immediately repeated even when the result is still over threshold (strengthens the oracle's own coverage)", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "overthreshold-nodouble", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  // A verbose model summary, long enough in every field that once folded into the
  // compaction block (each half capped at maxBlockHalfTokens, but filled rather than left
  // mostly empty) the resulting block plus the fixed system prompt clears the tiny
  // 1024-context threshold on its own - see the header comment above for the measured
  // numbers this scenario depends on.
  const repeat = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} ${i} `.repeat(15).trim());
  const richSummary = JSON.stringify({
    goal: "a very long goal description ".repeat(20),
    constraints: repeat("constraint", 5),
    filesInspected: repeat("file-inspected", 5),
    filesChanged: repeat("file-changed", 5),
    decisions: repeat("decision", 5),
    failedAttempts: repeat("failed-attempt", 5),
    currentState: "a very long current state description ".repeat(20),
    remainingWork: repeat("remaining-work", 5),
  });

  const overThreshold = await runWorkerAgainstStub({
    workspace,
    contextTokens: 1024, // ValidateRange minimum - makes the threshold small enough to clear
    prompt: "replace original with replaced in a.txt",
    responses: [
      newAssistantResponse({ toolCalls: [newToolCall("write_file", { path: "f0.txt", content: "content 0" })] }),
      // A closing turn (no tool calls) with a scripted prompt_eval_count far over the tiny
      // 666-token threshold - the same "trust the provider's counter" technique every
      // other in-loop compaction test in this file uses - triggers the loop-break
      // compaction unconditionally, regardless of the tool result's actual size.
      newAssistantResponse({ promptTokens: 5000, content: "x".repeat(50) }),
      newAssistantResponse({ content: richSummary }), // the in-loop compaction's summarization call
      newAssistantResponse({ content: STRUCTURED_RESULT }),
    ],
  });
  assert.equal(overThreshold.exitCode, 0, "the compacted-but-still-over-threshold session still completes");
  assert.equal(overThreshold.requests.length, 4, "no wasted second summarization call is made for the same closing turn");
  assert.ok(/compaction: turn=2 reason=threshold/.test(overThreshold.stdout), "the loop-break compaction still runs");
  assert.ok(!/reason=final/.test(overThreshold.stdout), "the final reduction does not repeat a compaction that just ran on this same turn, even though the result remains over threshold");
  const finalMessages = messagesOf(overThreshold.requests[overThreshold.requests.length - 1]);
  assert.equal(finalMessages.length, 4, "the history handed to the final report is exactly what the single in-loop compaction produced");
});

// (2) historySlicing.ts's `resolveRetentionBoundary`: relaxing `requireDrop && start - floor
// < 2` to `< 1` survives every test above because none of them drives a SECOND
// threshold-triggered compaction whose earliest candidate is "drop only the previous
// compaction's block" - the exact case the PS oracle's own comment calls out ("Two, not
// one: ... That reclaims nothing, so the next exchange has to go with it"). This test
// builds exactly that: a first compaction that leaves a block plus a retained tail
// exchange, followed by enough new conversation to cross the threshold again.
//
// Mutation proof: with `< 2` relaxed to `< 1`, the second compaction's earliest candidate
// (drop the old block alone, 1 message) is no longer rejected by `requireDrop`, so
// `resolveRetentionBoundary` returns it immediately (earliest-first) instead of walking on
// to a candidate that also drops the next real exchange. `invokeContextCompaction`'s own
// `droppable < 2` check then throws that single-message answer away entirely, so the
// second compaction is SKIPPED rather than performed: stdout shows "compaction: turn=3
// skipped droppable_messages=1 ..." in place of a second "reason=threshold" line, only 1
// compaction is recorded instead of 2, and the uncompacted 7-message history (instead of a
// compacted 4-message one) reaches the final request - confirmed by running this exact
// scenario against the mutated source before writing the assertions below. Restoring `< 2`
// makes the second compaction actually run again.
test("lean worker: a second compaction still reclaims a real exchange, not just the previous compaction's own block (strengthens the oracle's own coverage)", { timeout: 30_000 }, async () => {
  const workspace = join(TEST_ROOT, "two-not-one", "ws");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "original text", "utf8");

  const twoCompactions = await runWorkerAgainstStub({
    workspace,
    keepRecentMessages: 4,
    prompt: "replace original with replaced in a.txt",
    responses: [
      READ_A, // turn 1: an ordinary tool call, cheap enough not to trigger anything
      EDIT_A, // turn 2: another tool call, but prompt_eval_count=25000 crosses the (default) threshold
      SUMMARY_REPLY, // the first compaction's summarization call
      // turn 3: a closing turn whose scripted prompt_eval_count again crosses the
      // threshold, against a history whose only pre-existing droppable messages are the
      // first compaction's own block plus the retained edit_file exchange.
      newAssistantResponse({ promptTokens: 25000, content: "finished" }),
      SUMMARY_REPLY, // the second compaction's summarization call (correct code only)
      STRUCTURED_REPLY,
    ],
  });
  assert.equal(twoCompactions.exitCode, 0, "a session with two successive threshold-triggered compactions still completes");
  assert.equal(twoCompactions.requests.length, 6, "the second compaction spends its own summarization call rather than being skipped");
  const compactionLines = twoCompactions.stdout.split("\n").filter((line) => line.startsWith("compaction:"));
  assert.equal(compactionLines.filter((line) => /reason=threshold/.test(line)).length, 2, "both the first and the second compaction actually run");
  assert.ok(!/skipped/.test(twoCompactions.stdout), "the second compaction is not declined just because its only free candidate is the previous block alone");
  assert.ok(/compactions=2/.test(twoCompactions.stdout), "two compactions are recorded, not one");
  // messages=6->4 per the compaction diagnostic above, plus the one "Now report..." final
  // instruction message main.ts appends after the loop ends: 5 in total.
  const finalMessages = messagesOf(twoCompactions.requests[twoCompactions.requests.length - 1]);
  assert.equal(finalMessages.length, 5, "the second compaction actually shrank the history instead of only swapping one block for another of the same size");
});
