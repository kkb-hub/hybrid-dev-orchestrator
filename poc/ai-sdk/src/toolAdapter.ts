// Builds the AI SDK `ToolSet` handed to `generateText` - the concrete shape of ADR-0003
// D3's security boundary for this PoC. Every tool wraps `dispatchTool` (tools.ts) exactly
// the way the zero-dependency baseline's turn loop does (main.ts, leanWorker):
//
//   - the AI SDK, and the model behind it, never see a workspace path, an fs handle, or
//     `ctx.workspace` itself - only this module's `execute` closures, which are the only
//     code that ever calls `dispatchTool`;
//   - `getTools(ctx.readOnly)` (toolDefinitions.ts) already returns just the three read
//     tools when `ctx.readOnly` is true, so the object this function returns never has a
//     `write_file`/`edit_file` KEY at all in that mode - not disabled, structurally
//     absent, matching the requirement that a read-only step cannot be talked into
//     writing by prompt content (`dispatchTool`'s own read-only guard is still reached
//     for defense in depth, but the model has no name to call it under to begin with);
//   - no shell/git/build/test tool is defined here or anywhere else in this PoC.
import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolSet } from "ai";
import { warn } from "../../../src/workers/leanWorker/log.ts";
import { getTools } from "../../../src/workers/leanWorker/toolDefinitions.ts";
import { dispatchTool, type DispatchToolContext } from "../../../src/workers/leanWorker/tools.ts";
import { registerToolOutcome } from "../../../src/workers/leanWorker/verifiedState.ts";
import type { WorkerSession } from "../../../src/workers/leanWorker/session.ts";

/**
 * "Which turn is this" for `registerToolOutcome`'s bounded log lines. A tool's own
 * `execute` callback gets no step/turn number from the AI SDK (`ToolExecutionOptions`
 * carries `toolCallId`/`messages`/`abortSignal`/`context`, nothing about which step is
 * running - see the type in `@ai-sdk/provider-utils`), so main.ts's `prepareStep` writes
 * the current turn number into this shared box before each step runs, and every tool
 * built here reads it back at call time. `registerToolOutcome` only folds the number into
 * a human-readable string, so a call that happens to run one step "late" relative to this
 * box is cosmetic, never a correctness issue.
 */
export interface TurnRef {
  current: number;
}

/** Builds the tool set - port of `$script:Tools = if ($ReadOnly) { $script:ReadTools }
 * else { $script:ReadTools + $script:WriteTools }` (toolDefinitions.ts's `getTools`, which
 * this reuses unchanged) into the AI SDK's own `Tool` records. */
export function buildToolSet(ctx: DispatchToolContext, session: WorkerSession, turn: TurnRef): ToolSet {
  const toolSet: Record<string, Tool> = {};
  for (const definition of getTools(ctx.readOnly)) {
    const name = definition.function.name;
    toolSet[name] = tool({
      description: definition.function.description,
      inputSchema: jsonSchema(definition.function.parameters as unknown as JSONSchema7),
      execute: async (input) => {
        const toolArguments = (input ?? {}) as Record<string, unknown>;
        let result: string;
        let failed = false;
        let readWasWhole = false;
        try {
          const dispatched = dispatchTool(ctx, name, toolArguments);
          result = dispatched.text;
          readWasWhole = dispatched.readWasWhole;
        } catch (error) {
          // Returned to the model as the tool's own result, not thrown into the AI SDK's
          // `tool-error` content-part path - see the header comment in messageBridge.ts:
          // keeping every tool call resolved as a plain string is what lets
          // `stepToChatMessages` fold a step back into `ChatMessage[]` without a second,
          // divergent representation for a failed call. Mirrors the baseline's own
          // `ERROR: ...` convention (main.ts) so the two workers' transcripts read the
          // same way for a wrong path or a non-unique edit.
          const message = (error as Error).message;
          result = `ERROR: ${message}`;
          failed = true;
          warn(`tool '${name}' failed: ${message}`);
        }
        registerToolOutcome(session, turn.current, name, toolArguments, result, failed, readWasWhole);
        return result;
      },
    });
  }
  return toolSet;
}
