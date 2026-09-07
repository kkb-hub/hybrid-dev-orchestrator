// Compaction's summarization half - port of workers/hdo-ollama-worker.ps1's
// `Get-TranscriptDigest`, `Format-SummaryField`, `Get-ModelWorkingSummary`,
// `New-HistoryBlock`, and `Update-WorkingSummary` (Runner script lines 718-922). Split
// out of compaction.ts so the "turn dropped messages into text, and text into a
// model-written summary" half lives apart from the "decide when to compact" triggers in
// compaction.ts itself.
import { limitText, limitTextToTokens } from "./text.ts";
import { warn } from "./log.ts";
import { invokeOllamaChat } from "./ollamaClient.ts";
import { getVerifiedStateBlock } from "./verifiedState.ts";
import type { ChatMessage, WorkerSession } from "./session.ts";

const SUMMARY_SYSTEM_PROMPT =
  "You compress a coding session into a structured working summary that the same worker will\n" +
  "continue from. Report only what the transcript supports. Never invent a file, a decision,\n" +
  "or a result. Be specific: name files, functions, and exact error text.";

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    filesInspected: { type: "array", items: { type: "string" } },
    filesChanged: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    failedAttempts: { type: "array", items: { type: "string" } },
    currentState: { type: "string" },
    remainingWork: { type: "array", items: { type: "string" } },
  },
  required: [
    "goal",
    "constraints",
    "filesInspected",
    "filesChanged",
    "decisions",
    "failedAttempts",
    "currentState",
    "remainingWork",
  ],
};

/** Flattens the messages a compaction is about to drop into bounded plain text - port of
 * `Get-TranscriptDigest`. Keeps the tail: the newest turns are the ones the model still
 * has to reason about, and anything older has already been folded into the summary
 * carried over from the previous compaction. */
export function getTranscriptDigest(messages: ChatMessage[], budgetTokens: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = message.content ?? "";
    if (message.role === "assistant") {
      if (content.trim() !== "") lines.push(`assistant: ${limitText(content, 1200)}`);
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          const argumentsJson = limitText(JSON.stringify(call.function.arguments), 300);
          lines.push(`assistant called ${call.function.name} with ${argumentsJson}`);
        }
      }
    } else if (message.role === "tool") {
      lines.push(`result of ${message.tool_name ?? ""}: ${limitText(content, 600)}`);
    } else {
      lines.push(`${message.role}: ${limitText(content, 1500)}`);
    }
  }
  return limitTextToTokens(lines.join("\n"), budgetTokens, false);
}

/** Port of `Format-SummaryField`. */
export function formatSummaryField(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (value === undefined || value === null) return `${label}: (not reported)`;
  if (Array.isArray(value)) {
    const items = value.map((entry) => limitText(String(entry), 300)).filter((entry) => entry !== "");
    if (items.length === 0) return `${label}: (none)`;
    // Bounded like every other recorded collection: nothing stops a model from returning
    // a hundred "decisions", and this text is carried into the next compaction's input as
    // well as into the rebuilt history.
    const shown = items.slice(0, 10);
    let rendered = `${label}:\n${shown.map((entry) => `  - ${entry}`).join("\n")}`;
    if (items.length > shown.length) rendered += `\n  - ...and ${items.length - shown.length} more`;
    return rendered;
  }
  const text = limitText(String(value), 800);
  if (!text) return `${label}: (none)`;
  return `${label}: ${text}`;
}

/**
 * Asks the model to compress the dropped turns into a structured working summary - port
 * of `Get-ModelWorkingSummary`.
 *
 * Sent as its own two-message conversation rather than as a continuation of the session,
 * so it cannot be the request that finally overruns the window it exists to protect. Any
 * failure here is reported (via `warn`) and tolerated: the verified-state block alone is
 * still a usable, if thinner, handover, and losing a summary is not a reason to fail a
 * step whose work is already on disk.
 */
export async function getModelWorkingSummary(
  session: WorkerSession,
  transcript: string,
  task: string,
  carryOver: string,
): Promise<string> {
  const previous = carryOver ? `Summary carried over from the previous compaction:\n${carryOver}\n` : "";
  const userContent =
    `The task being worked on:\n${limitText(task, 4000)}\n\n${previous}\n` +
    `Transcript of the turns being removed from the conversation:\n${transcript}\n\n` +
    "Produce the structured working summary as JSON matching the required schema.";
  const request: ChatMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  let response;
  try {
    response = await invokeOllamaChat({
      uri: session.ollamaUri,
      model: session.model,
      messages: request,
      format: SUMMARY_SCHEMA,
      think: false,
      contextTokens: session.contextTokens,
      requestTimeoutSeconds: session.requestTimeoutSeconds,
    });
  } catch (error) {
    warn(`Context compaction summary request failed: ${(error as Error).message}`);
    return "";
  }

  const content = response.message?.content ?? "";
  if (content.trim() === "") {
    warn("Context compaction summary came back empty; keeping the verified state only.");
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    warn("Context compaction summary was not valid JSON; keeping the verified state only.");
    return "";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
  const dict = parsed as Record<string, unknown>;

  // Ordered most operationally important first, not in schema order: this text is capped
  // from the end when the budget is tight (see the `limitTextToTokens` call below), so
  // whatever is listed last is what gets cut first. Current state and remaining work are
  // what a continuing worker needs and cannot get anywhere else; goal and constraints are
  // useful but already covered by the protected task message, so they can afford to go last.
  const fields = [
    formatSummaryField(dict, "currentState", "Current state"),
    formatSummaryField(dict, "remainingWork", "Remaining work"),
    formatSummaryField(dict, "failedAttempts", "Failed attempts"),
    formatSummaryField(dict, "decisions", "Decisions"),
    formatSummaryField(dict, "filesChanged", "Files changed"),
    formatSummaryField(dict, "filesInspected", "Files inspected"),
    formatSummaryField(dict, "constraints", "Constraints"),
    formatSummaryField(dict, "goal", "Goal"),
  ];
  // Capped here rather than only where it is rendered, because this text is also carried
  // into the next compaction as prior context; an uncapped summary would compound.
  return limitTextToTokens(fields.join("\n"), session.maxBlockHalfTokens, true);
}

/** Builds the single message that stands in for the turns that were dropped - port of
 * `New-HistoryBlock`.
 *
 * The two halves are labelled apart on purpose. The first is what the worker observed
 * itself and is therefore true; the second is the model's own account and may not be. A
 * model that cannot tell those apart will trust a hallucinated "already fixed" as readily
 * as a recorded edit. */
export function newHistoryBlock(session: WorkerSession, heading: string, preamble: string, turn: number, summary: string): string {
  const verified = limitTextToTokens(getVerifiedStateBlock(session, turn), session.maxBlockHalfTokens, true);
  const modelPart = summary
    ? limitTextToTokens(summary, session.maxBlockHalfTokens, true)
    : "(unavailable: rely on the verified facts above and on the messages that follow)";
  return (
    `=== ${heading} ===\n` +
    `${preamble}\n` +
    "The task stated in the previous message is unchanged and remains the goal.\n" +
    "\n" +
    "-- Verified by the orchestrator (observed, not recalled) --\n" +
    `${verified}\n` +
    "\n" +
    "-- Your own summary of the removed turns (model-generated, may be incomplete) --\n" +
    `${modelPart}\n` +
    "=== END OF COMPACTED HISTORY ==="
  );
}

/** Folds the messages about to be dropped into the running working summary - port of
 * `Update-WorkingSummary`. Only replaces `session.lastSummaryBlock` on success: a failed
 * or unusable call must not erase what an earlier compaction already established. */
export async function updateWorkingSummary(session: WorkerSession, dropped: ChatMessage[]): Promise<string> {
  const digest = getTranscriptDigest(dropped, session.summaryInputTokens);
  const task = String(session.messages[1]?.content ?? "");
  const summary = await getModelWorkingSummary(session, digest, task, session.lastSummaryBlock);
  if (summary) session.lastSummaryBlock = summary;
  return session.lastSummaryBlock;
}
