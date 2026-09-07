// Converts between the lean worker's own `ChatMessage` shape (Ollama-native: a flat
// {role, content, tool_calls?, tool_name?} record - see session.ts) and the AI SDK's
// `ModelMessage` shape (a discriminated union whose assistant/tool roles carry a
// `content` ARRAY of typed parts, addressed by `toolCallId` rather than by position).
//
// This module exists because ADR-0003's compaction plan ("compaction は SDK 内で実装で
// きる", point (a)) is only true if something bridges the two shapes: the reused
// `testCompactionThresholdCrossed`/`invokeContextCompaction`/`compressFinalContext`
// (compaction.ts) and the pure slicing/measurement helpers they call (historySlicing.ts)
// all operate on `WorkerSession.messages: ChatMessage[]`, exactly as the baseline worker
// built them, and `measureMessageTokens`'s `JSON.stringify(messages)` byte estimate is
// only parity-comparable to the PS oracle's `ConvertTo-Json -Compress` when it is run
// against that same flat shape (historySlicing.ts's own header comment). `prepareStep`,
// meanwhile, only ever hands back and forth `ModelMessage[]`. So every `prepareStep` call
// in main.ts round-trips through here: fold the just-completed step into `ChatMessage[]`,
// let the reused compaction functions rewrite that array in place exactly as they do for
// the zero-dependency baseline, then re-render it as the `messages` override the SDK
// carries forward (per `PrepareStepResult.messages`'s "carries forward to later steps").
import type { ModelMessage } from "ai";
import type { ChatMessage } from "../../../src/workers/leanWorker/session.ts";

/** The subset of AI SDK `StepResult` this module actually reads - narrower than the real
 * type so this file does not need to import the whole `ai` step-result generic just to
 * name three fields. */
export interface FoldableStep {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; output: unknown }>;
}

function toolOutputText(output: unknown): string {
  // Every tool this PoC defines (toolAdapter.ts) resolves with a plain string, so this is
  // reached in the ordinary case; the JSON.stringify fallback only matters if the AI SDK
  // itself ever synthesizes a non-string output (e.g. for a call the model made to a name
  // that was never in the tool set).
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * Folds one completed step into the flat `ChatMessage[]` shape - the assistant turn,
 * then one tool-result message per call, in the SAME ORDER as `step.toolCalls` (not
 * `step.toolResults`: nothing guarantees results resolve in call order once the AI SDK is
 * free to run `execute` callbacks concurrently, so this pairs by `toolCallId` through a
 * lookup instead of trusting result order). That is exactly the order main.ts's own
 * baseline turn loop pushes them in (`session.messages.push(assistant)` then one push per
 * tool call), which is what keeps `newRebuiltHistory`/`getExchangeStarts`
 * (historySlicing.ts) - written against that ordering - meaningful here too.
 */
export function stepToChatMessages(step: FoldableStep): ChatMessage[] {
  const out: ChatMessage[] = [];
  const assistant: ChatMessage = { role: "assistant", content: step.text ?? "" };
  if (step.toolCalls.length > 0) {
    assistant.tool_calls = step.toolCalls.map((call) => ({ function: { name: call.toolName, arguments: call.input } }));
  }
  out.push(assistant);

  const resultsByCallId = new Map(step.toolResults.map((result) => [result.toolCallId, result]));
  for (const call of step.toolCalls) {
    const result = resultsByCallId.get(call.toolCallId);
    out.push({ role: "tool", tool_name: call.toolName, content: result ? toolOutputText(result.output) : "" });
  }
  return out;
}

/**
 * Renders the flat `ChatMessage[]` history back as `ModelMessage[]` for the next
 * `prepareStep` override.
 *
 * `toolCallId`s are synthesized fresh on every call (`a<n>_t<i>`) rather than carried over
 * from whatever the provider originally assigned: they only need to be internally
 * consistent within THIS render (an assistant's tool-call part and the tool-result
 * part(s) that follow it), never matched against an earlier render, because this function
 * is always called with the complete history and produces a complete, self-contained
 * `ModelMessage[]` every time - nothing downstream keeps a previous render's IDs around to
 * compare against.
 */
export function chatMessagesToModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let pendingToolCallIds: string[] = [];
  let assistantSeq = 0;

  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      assistantSeq += 1;
      pendingToolCallIds = [];
      if (message.tool_calls && message.tool_calls.length > 0) {
        const parts: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
        if (message.content) parts.push({ type: "text", text: message.content });
        message.tool_calls.forEach((call, index) => {
          const toolCallId = `a${assistantSeq}_t${index}`;
          pendingToolCallIds.push(toolCallId);
          parts.push({ type: "tool-call", toolCallId, toolName: call.function.name, input: call.function.arguments });
        });
        out.push({ role: "assistant", content: parts });
      } else {
        out.push({ role: "assistant", content: message.content });
      }
      continue;
    }
    // role === "tool": pairs with the next unclaimed id from the assistant message that
    // immediately precedes this run of tool-result messages, in arrival order - see
    // stepToChatMessages's header comment for why that order is trustworthy here.
    const toolCallId = pendingToolCallIds.shift();
    if (toolCallId === undefined) {
      throw new Error("tool message has no matching preceding tool call - message history is malformed");
    }
    out.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId, toolName: message.tool_name ?? "", output: { type: "text", value: message.content } }],
    });
  }
  return out;
}
