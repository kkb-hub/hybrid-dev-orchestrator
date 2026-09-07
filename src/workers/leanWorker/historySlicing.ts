// Token accounting and pure history slicing - port of workers/hdo-ollama-worker.ps1's
// `Measure-MessageTokens`, `Get-CompactionThreshold`, `Get-ExchangeStarts`,
// `Get-MessageRange`, `New-RebuiltHistory`, and `Resolve-RetentionBoundary` (Runner
// script lines 602-973). Split out of compaction.ts (which now holds only the three
// functions that actually decide WHEN to compact and call Ollama) so the pure
// slicing/measurement half - which never mutates its `WorkerSession` argument and never
// makes a network call - stays easy to unit-test in isolation.
import { psInt } from "./psInt.ts";
import { PROTECTED_MESSAGE_COUNT, type ChatMessage, type WorkerSession } from "./session.ts";

/**
 * Estimates the prompt size of a message list - port of `Measure-MessageTokens`.
 *
 * An estimate, and deliberately so: it covers messages that have not been sent yet (so no
 * counter exists for them) and turns where Ollama omits `prompt_eval_count`.
 *
 * Measured as UTF-8 bytes over three, not characters over four. The familiar
 * four-characters-per-token only holds for ASCII: this project's own prompts and issue
 * text are Japanese, which `JSON.stringify` (like PS's `ConvertTo-Json`) leaves
 * unescaped and which tokenizes at roughly one token per character, so counting
 * characters understates such a prompt about fourfold. Three bytes per token is one
 * token per Japanese character and one token per three ASCII characters, which overstates
 * ASCII by a third. Overstating is the harmless direction: it compacts slightly early,
 * whereas understating is the failure this number exists to prevent.
 *
 * Parity note (phase 8 task, item 5), verified by direct comparison (`ConvertTo-Json
 * -Compress` vs. `JSON.stringify` on identical input, byte-for-byte): both leave ordinary
 * non-ASCII text - Japanese included - unescaped, and agree on every standard JSON escape
 * (quote, backslash, tab, newline, `<`/`>`/`&` are NOT escaped by either). The one
 * residual difference found: PowerShell's `ConvertTo-Json` escapes U+2028/U+2029 (LINE
 * SEPARATOR / PARAGRAPH SEPARATOR) each as a six-byte ASCII escape sequence, while
 * `JSON.stringify` leaves them as their raw 3-byte UTF-8 encoding. Both remain valid JSON
 * either way, so this only nudges the byte count - and thus the token estimate - down
 * very slightly on the rare input containing one of those two characters, negligible next
 * to the estimate's built-in one-third overstatement margin above.
 */
export function measureMessageTokens(messages: ChatMessage[]): number {
  if (!messages || messages.length === 0) return 0;
  const json = JSON.stringify(messages);
  return Math.ceil(Buffer.byteLength(json, "utf8") / 3);
}

/** Port of `Get-CompactionThreshold`. `[int](...)` in the oracle is round-half-to-even,
 * not truncation - see psInt.ts. */
export function getCompactionThreshold(session: WorkerSession): number {
  return psInt((session.contextTokens * session.compactAtPercent) / 100);
}

/**
 * The indexes at which a rebuilt history may resume, in ascending order - port of
 * `Get-ExchangeStarts`.
 *
 * A tool result only means anything next to the assistant turn that requested it, so the
 * only valid resume points are the non-tool messages: cutting anywhere else orphans a
 * result from its call. The message count itself is included as the last option, which
 * retains nothing - the only choice left when a single exchange is larger than the
 * window, as one assistant turn answering with ten parallel tool calls can be.
 */
export function getExchangeStarts(messages: ChatMessage[], floor: number): number[] {
  const starts: number[] = [];
  for (let index = floor; index < messages.length; index++) {
    if (messages[index].role !== "tool") starts.push(index);
  }
  starts.push(messages.length);
  return starts;
}

/** Port of `Get-MessageRange`. `start > end` yields `[]` (PowerShell ranges would
 * otherwise count downward and silently reverse the conversation instead). */
export function getMessageRange(messages: ChatMessage[], start: number, end: number): ChatMessage[] {
  if (start > end) return [];
  return messages.slice(start, end + 1);
}

/** Port of `New-RebuiltHistory`. Protected prefix by count, not by literal index, so this
 * stays correct if `PROTECTED_MESSAGE_COUNT` is ever changed. */
export function newRebuiltHistory(original: ChatMessage[], blockMessage: ChatMessage, start: number): ChatMessage[] {
  const prefix = getMessageRange(original, 0, PROTECTED_MESSAGE_COUNT - 1);
  const tail = getMessageRange(original, start, original.length - 1);
  return [...prefix, blockMessage, ...tail];
}

/**
 * Decides how much of the tail a rebuilt history can afford to keep - port of
 * `Resolve-RetentionBoundary`.
 *
 * Walks the valid resume points from earliest to latest and takes the first that both
 * honours the retention policy and leaves the surviving history under the threshold with
 * room reserved for the replacement block. Earliest-first means the most context that can
 * be afforded is the context that is kept.
 *
 * The retained tail can be the expensive part on its own: five full-size tool results, or
 * one `write_file` argument holding a whole file, can exceed the threshold with the rest
 * of the history already gone. Keeping fewer of them is then the only lever left, and if
 * no resume point fits, the last one (the message count) retains nothing at all.
 *
 * `requireDrop` refuses the "keep everything" boundary. The in-loop caller
 * (`invokeContextCompaction`) passes it because that compaction is a response to the
 * provider's own `prompt_eval_count`, and that counter, not this estimate, is the
 * authority on whether the window is filling up: if the two disagree, dropping the oldest
 * exchange is always a better answer than declining and sending the request anyway.
 *
 * Runs BEFORE the replacement block is built, not after, so the summarization digest can
 * be taken over exactly the messages that are about to be dropped. Choosing the boundary
 * afterwards would silently discard the messages between the two boundaries: summarized
 * out of one and truncated out of the other.
 */
export function resolveRetentionBoundary(
  session: WorkerSession,
  original: ChatMessage[],
  keep: number,
  requireDrop: boolean,
): number {
  const floor = PROTECTED_MESSAGE_COUNT;
  // The block does not exist yet, but it is capped, so its cap can be reserved instead.
  const budget = Math.max(1, getCompactionThreshold(session) - session.maxBlockTokens);
  for (const start of getExchangeStarts(original, floor)) {
    // Two, not one: after a previous compaction the first candidate drops only the old
    // block, which is replaced by a new one of the same capped size. That reclaims
    // nothing, so the next exchange has to go with it.
    if (requireDrop && start - floor < 2) continue;
    if (original.length - start > keep) continue;
    const kept = getMessageRange(original, 0, floor - 1).concat(getMessageRange(original, start, original.length - 1));
    if (measureMessageTokens(kept) < budget) return start;
  }
  return original.length;
}
