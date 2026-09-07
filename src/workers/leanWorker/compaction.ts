// Compaction triggers - port of `Test-CompactionThresholdCrossed`,
// `Invoke-ContextCompaction`, and `Compress-FinalContext` (workers/hdo-ollama-worker.ps1
// lines 985-1112). These are the only three functions in the compaction pipeline that
// decide WHEN to rewrite the session's history and that mutate `WorkerSession` (via
// `historySlicing.ts`'s pure slicing functions and `summarizer.ts`'s Ollama-calling
// summarizer) to do it; everything else the PS `$script:` globals lumped in with
// compaction is split into those two sibling modules.
import { getCompactionThreshold, getMessageRange, measureMessageTokens, newRebuiltHistory, resolveRetentionBoundary } from "./historySlicing.ts";
import { newHistoryBlock, updateWorkingSummary } from "./summarizer.ts";
import { PROTECTED_MESSAGE_COUNT, type WorkerSession } from "./session.ts";

/**
 * Runs the in-loop threshold check and compacts if crossed - port of
 * `Test-CompactionThresholdCrossed`. Shared by both places a turn can end (with tool
 * calls still to process, or without) so a future change to how `promptTokens` and
 * `measureMessageTokens` combine cannot be made in one call site without the other.
 */
export async function testCompactionThresholdCrossed(
  session: WorkerSession,
  turn: number,
  sentCount: number,
  promptTokens: number,
): Promise<void> {
  if (session.compactAtPercent <= 0) return;
  // prompt_eval_count describes the request that was just sent, not the one about to be:
  // this turn's assistant message, and any tool results, were appended after it.
  // Projecting them keeps the decision ahead of the window rather than one turn behind it.
  const appended = getMessageRange(session.messages, sentCount, session.messages.length - 1);
  const projected =
    promptTokens > 0 ? promptTokens + measureMessageTokens(appended) : measureMessageTokens(session.messages);
  if (projected >= getCompactionThreshold(session)) {
    await invokeContextCompaction(session, turn, projected);
  }
}

/** Rewrites the history in place once the next request would approach the window - port
 * of `Invoke-ContextCompaction`. */
export async function invokeContextCompaction(session: WorkerSession, turn: number, beforeTokens: number): Promise<void> {
  const floor = PROTECTED_MESSAGE_COUNT;
  const start = resolveRetentionBoundary(session, session.messages, session.keepRecentMessages, true);
  const droppable = start - floor;
  if (droppable < 2) {
    // A single message cannot be summarized into less than itself, and re-running the
    // summarizer every turn would spend more context than it reclaims.
    process.stdout.write(`compaction: turn=${turn} skipped droppable_messages=${droppable} prompt_tokens_before~${beforeTokens}\n`);
    return;
  }

  const dropped = getMessageRange(session.messages, floor, start - 1);
  const summary = await updateWorkingSummary(session, dropped);
  session.compactionCount += 1;
  // Read by compressFinalContext: a compaction that just rebuilt the history this same
  // turn has already reserved headroom under the threshold (resolveRetentionBoundary's
  // budget subtracts the block's own cap), so a second reduction immediately afterward
  // would almost always find nothing left worth doing and pay a summarization call for it.
  session.lastCompactionTurn = turn;
  const block = newHistoryBlock(
    session,
    `HDO CONTEXT COMPACTION (after turn ${turn})`,
    "Earlier turns of this session were removed to stay inside the context window.",
    turn,
    summary,
  );

  const before = session.messages.length;
  session.messages = newRebuiltHistory(session.messages, { role: "user", content: block }, start);
  process.stdout.write(
    `compaction: turn=${turn} reason=threshold prompt_tokens_before~${beforeTokens} ` +
      `prompt_tokens_after~${measureMessageTokens(session.messages)} messages=${before}->${session.messages.length} ` +
      `kept_recent=${session.messages.length - floor - 1}\n`,
  );
}

/**
 * Reduces the history once more before the schema-forced final turn - port of
 * `Compress-FinalContext`.
 *
 * The final turn only reformats work that is already done, so re-sending every tool
 * result to produce it is the single largest avoidable request in a long run.
 *
 * Applied only when the history is genuinely expensive or has already been compacted
 * once. Discarding a transcript that fits comfortably would trade a real cost for an
 * imaginary one: a short run would then report from the terse verified facts while its
 * own transcript was still affordable.
 *
 * Costs one summarization call whenever it actually drops anything, because what it
 * drops is by definition not covered by the last summary: every turn since the previous
 * compaction, or the entire transcript when no compaction ever ran. Reusing the stale
 * summary would be free and wrong - the final report would describe the session up to
 * some earlier turn and say nothing about the work done after it.
 */
export async function compressFinalContext(session: WorkerSession, turn: number): Promise<void> {
  if (session.compactAtPercent <= 0) return;
  if (session.lastCompactionTurn === turn) {
    // A compaction already rewrote the history this exact turn, on the loop-break path.
    // resolveRetentionBoundary reserved the block's own cap as headroom when it chose
    // what to keep, so the result is already under threshold in every ordinary case;
    // running the summarizer again here would almost always find nothing left to trim.
    return;
  }
  const floor = PROTECTED_MESSAGE_COUNT;
  const original = [...session.messages];
  const overThreshold = measureMessageTokens(original) >= getCompactionThreshold(session);
  // A short session skips the reduction, unless its few messages are themselves already
  // over the threshold: nothing bounds a closing assistant turn's content the way tool
  // results are bounded by maxToolResultChars, so message count alone is not proof that
  // the history is cheap.
  if (original.length <= floor + session.keepRecentMessages + 1 && !overThreshold) return;
  if (session.compactionCount === 0 && !overThreshold) return;

  const start = resolveRetentionBoundary(session, original, session.keepRecentMessages, false);
  const droppable = start - floor;
  if (droppable < 1) return;
  const dropped = getMessageRange(original, floor, start - 1);
  if (droppable === 1 && measureMessageTokens(dropped) <= session.maxBlockTokens) {
    // Dropping one ordinary message and replacing it with a block of comparable size
    // would not meaningfully shrink the history, only spend a summarization call. An
    // oversized single message is different: the block is capped well below it, so this
    // is where the check above exists to let that case through.
    return;
  }

  const summary = await updateWorkingSummary(session, dropped);
  const block = newHistoryBlock(
    session,
    "HDO WORKING STATE (compacted for the final report)",
    "The tool loop is finished. The full transcript was replaced by this record.",
    turn,
    summary,
  );
  session.messages = newRebuiltHistory(original, { role: "user", content: block }, start);
  process.stdout.write(
    `compaction: turn=${turn} reason=final prompt_tokens_after~${measureMessageTokens(session.messages)} ` +
      `messages=${original.length}->${session.messages.length} kept_recent=${session.messages.length - floor - 1}\n`,
  );
}
