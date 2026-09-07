// Small text-truncation helpers shared across the worker. Split out of compaction.ts
// because `limitText` (character-bounded) is used well outside compaction proper - tool
// result bounding, tool-outcome recording, request error details - while
// `limitTextToTokens` (byte-budget-bounded) is compaction-specific. Kept together in one
// tiny module rather than duplicated per PS's `Limit-Text` (Runner script lines 102-108).
import { psInt } from "./psInt.ts";

/** Character-bounded truncation - port of `Limit-Text`. Used wherever the PS source
 * bounds a string by length rather than by an estimated token budget. */
export function limitText(text: string | null | undefined, max: number): string {
  if (text === null || text === undefined || text === "") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated]`;
}

/**
 * Trims text until its estimated token count fits a budget - port of `Limit-TextToTokens`
 * (Runner script lines 628-661).
 *
 * Trims the front by default (keeping the tail), which is what a transcript digest wants:
 * the newest turns are the ones still being reasoned about. `fromStart` keeps the
 * beginning instead, for text whose opening lines are the point of it (the verified-state
 * block and the model's own summary, both ordered most-important-first so a budget cut
 * removes the least essential material from the end).
 *
 * Every `[int](...)` in the oracle below is round-half-to-even, not truncation - see
 * psInt.ts - so `keepChars` and the two shave steps all go through `psInt` rather than
 * `Math.trunc`.
 */
export function limitTextToTokens(text: string, budgetTokens: number, fromStart: boolean): string {
  const budgetBytes = budgetTokens * 3;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= budgetBytes) return text;

  // Cut proportionally first, then shave until it actually fits: the ratio of bytes to
  // characters is not uniform across text that mixes source code and prose.
  const keepChars = Math.max(1, psInt((text.length * budgetBytes) / bytes));
  if (fromStart) {
    let trimmed = text.slice(0, keepChars);
    while (trimmed.length > 200 && Buffer.byteLength(trimmed, "utf8") > budgetBytes) {
      trimmed = trimmed.slice(0, trimmed.length - Math.max(1, psInt(trimmed.length * 0.1)));
    }
    return `${trimmed}\n...[truncated to fit the context budget]`;
  }
  let trimmed = text.slice(text.length - keepChars);
  while (trimmed.length > 200 && Buffer.byteLength(trimmed, "utf8") > budgetBytes) {
    trimmed = trimmed.slice(Math.max(1, psInt(trimmed.length * 0.1)));
  }
  return `...[older detail omitted from this digest]\n${trimmed}`;
}
