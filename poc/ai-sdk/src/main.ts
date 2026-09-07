#!/usr/bin/env node
// Entry point for the AI SDK comparison PoC worker (ADR-0001 Migration strategy phase 8,
// step (b); ADR-0003 Decision D2 (b)). NOT a supported worker - see README.md. Built to
// the exact same CLI contract as the zero-dependency baseline
// (src/workers/leanWorker/main.ts, step (a)): the same flag names, so the same
// `config/examples/ollama-lean-worker.json` `extraArgs` could point at this file instead
// with only the script path changed.
//
// What is reused, unchanged, from the baseline rather than reimplemented (ADR-0003 D3 -
// the security boundary and the context/compaction policy stay HDO-owned regardless of
// which harness runs the tool loop): `parseWorkerArgs` (args.ts), `resolveWorkerPath`/
// `isPathInsideWorkspace` via `dispatchTool` (tools.ts, workspaceGuard.ts), `getTools`
// (toolDefinitions.ts), `createSession`/`WorkerSession`/`ChatMessage` (session.ts),
// `testCompactionThresholdCrossed`/`invokeContextCompaction`/`compressFinalContext`
// (compaction.ts) and the pure slicing/measurement helpers they call (historySlicing.ts),
// `registerToolOutcome` (verifiedState.ts, via toolAdapter.ts), and `warn` (log.ts). Only
// three small PURE helpers are duplicated rather than imported - `normalizeWorkspace`,
// `loadResponseSchema`, `buildInitialMessages` - because the baseline's main.ts runs its
// own `run(process.argv.slice(2))` as a top-level side effect on import (by design: it is
// meant to be launched as a subprocess, exactly as the parity test harness does), so
// importing anything from it here would re-run the baseline worker's own CLI against this
// process's argv. The three copies below are kept byte-identical to the baseline's so the
// two workers see the same system prompt and the same schema preprocessing.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parse, resolve, sep } from "node:path";
import { generateText, isStepCount, jsonSchema, NoObjectGeneratedError, Output } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

import { parseWorkerArgs } from "../../../src/workers/leanWorker/args.ts";
import { compressFinalContext, testCompactionThresholdCrossed } from "../../../src/workers/leanWorker/compaction.ts";
import { warn } from "../../../src/workers/leanWorker/log.ts";
import { createSession, type ChatMessage } from "../../../src/workers/leanWorker/session.ts";
import type { FoldableStep } from "./messageBridge.ts";
import { chatMessagesToModelMessages, stepToChatMessages } from "./messageBridge.ts";
import { buildToolSet, type TurnRef } from "./toolAdapter.ts";

/** Byte-identical copy of leanWorker/main.ts's `normalizeWorkspace` - see this file's
 * header comment for why it is copied rather than imported. */
function normalizeWorkspace(workingDirectory: string): string {
  const full = resolve(workingDirectory);
  if (parse(full).root === full) return full;
  return full.endsWith(sep) ? full.slice(0, -sep.length) : full;
}

/** Byte-identical copy of leanWorker/main.ts's `loadResponseSchema`. */
function loadResponseSchema(schemaFile: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(schemaFile, "utf8")) as Record<string, unknown>;
  for (const metaKeyword of ["$schema", "$id", "title"]) {
    delete parsed[metaKeyword];
  }
  return parsed;
}

/** Byte-identical copy of leanWorker/main.ts's `buildInitialMessages`: same system prompt
 * text, so a difference in tool-use behaviour between the two workers cannot be blamed on
 * a paraphrase here. */
function buildInitialMessages(readOnly: boolean, promptText: string): ChatMessage[] {
  const capabilities = readOnly
    ? "You can read files, list them, and search their contents. You cannot modify anything."
    : "You can read, list, search, create, and edit files.";

  const contextRules: string[] = [];
  if (!readOnly) {
    contextRules.push("- To change a file that already exists, use edit_file. Do not send a whole file through");
    contextRules.push("  write_file: that content stays in the conversation for the rest of the session. Use");
    contextRules.push("  write_file only to create a file that does not exist yet.");
  }
  contextRules.push("- Use search_files to find the relevant lines, then read_file with start_line and");
  contextRules.push("  max_lines for just that region, instead of reading a whole large file.");
  contextRules.push("- Do not re-read a file you have already read in full unless you changed it since.");
  contextRules.push('  A file listed as "(partial)" in a compaction block was only read in part.');
  const contextDiscipline = contextRules.join("\n");

  const systemContent = `You are a local coding worker operating inside a repository workspace.
${capabilities}
Never guess a file's contents: read it first.
Do not attempt to run shell commands, git, builds, or tests. The orchestrator runs
trusted validation gates after you finish.
Make only the change the task asks for, then stop calling tools.

Your context window is small and every tool result stays in it. Work narrowly:
${contextDiscipline}
If a message headed HDO CONTEXT COMPACTION appears, earlier turns were removed to stay
inside the window. Continue from it: the facts it lists were recorded by the orchestrator.`;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: promptText },
  ];
}

async function run(argv: string[]): Promise<void> {
  const args = parseWorkerArgs(argv);

  if (!existsSync(args.workingDirectory) || !statSync(args.workingDirectory).isDirectory()) {
    throw new Error(`WorkingDirectory '${args.workingDirectory}' does not exist.`);
  }
  const workspace = normalizeWorkspace(args.workingDirectory);
  const schema = loadResponseSchema(args.schemaFile);

  const session = createSession({
    workspace,
    readOnly: args.readOnly,
    model: args.model,
    contextTokens: args.contextTokens,
    maxTurns: args.maxTurns,
    maxToolResultChars: args.maxToolResultChars,
    compactAtPercent: args.compactAtPercent,
    keepRecentMessages: args.keepRecentMessages,
    requestTimeoutSeconds: args.requestTimeoutSeconds,
    ollamaUri: args.ollamaUri,
    // WorkerSession's own `tools` field is the Ollama-native JSON schema list the
    // baseline sends by hand (ollamaClient.ts); this port sends tools through the AI
    // SDK's `ToolSet` instead (toolAdapter.ts's `buildToolSet`, below), but the field is
    // still populated so `session` stays a genuine `WorkerSession` for the reused
    // compaction functions, none of which read this field themselves.
    tools: [],
  });

  const promptText = readFileSync(args.promptFile, "utf8");
  session.messages = buildInitialMessages(args.readOnly, promptText);

  // ollama-ai-provider-v2's chat model appends "/chat" to whatever `baseURL` it is given
  // (dist/index.mjs: `path: "/chat"`), and its own default baseURL is
  // "http://127.0.0.1:11434/api" - i.e. this worker's own default `-OllamaUri`
  // ("http://127.0.0.1:11434/api/chat") with "/chat" removed. Stripping that suffix here
  // keeps `-OllamaUri` itself identical between the two workers (same flag, same default,
  // same stub server URL in tests) while feeding the provider the base it actually wants.
  const baseURL = args.ollamaUri.replace(/\/chat$/, "");
  const model = createOllama({ baseURL }).chat(args.model);

  const dispatchCtx = { workspace: session.workspace, readOnly: session.readOnly, maxToolResultChars: session.maxToolResultChars };
  const turnRef: TurnRef = { current: 0 };
  const tools = buildToolSet(dispatchCtx, session, turnRef);

  let turnsUsed = 0;

  // ai@7.0.93 rejects a `{role: "system"}` entry inside `messages`/`prompt` outright
  // ("System messages are not allowed in the prompt or messages fields. Use the
  // instructions option instead.") - one of the v7 renames ADR-0003 flagged
  // (`system` -> `instructions`, F-table "AI SDK の事実"), but this particular one is a
  // hard validation error, not just a deprecated alias. `session.messages[0]` is always
  // that protected system prompt (`buildInitialMessages`, `PROTECTED_MESSAGE_COUNT`), so
  // every render of `session.messages` for the AI SDK has to carry it separately via
  // `instructions` and convert only the rest.
  const instructions = session.messages[0]!.content;
  const renderMessages = () => chatMessagesToModelMessages(session.messages.slice(1));

  /** Folds one completed step into `session.messages` and runs the same in-loop
   * compaction check the baseline's turn loop runs after every turn
   * (`testCompactionThresholdCrossed`, reused unchanged) - shared between `prepareStep`
   * (every step but the last) and the post-loop handling below (the last step, which
   * never gets a following `prepareStep` call). */
  async function foldStep(step: FoldableStep, turn: number, promptTokens: number): Promise<void> {
    turnsUsed = turn;
    const sentCount = session.messages.length;
    for (const message of stepToChatMessages(step)) session.messages.push(message);
    process.stdout.write(`turn ${turn}: prompt_tokens=${promptTokens} tool_calls=${step.toolCalls.length}\n`);
    await testCompactionThresholdCrossed(session, turn, sentCount, promptTokens);
  }

  const result = await generateText({
    model,
    tools,
    instructions,
    messages: renderMessages(),
    stopWhen: isStepCount(session.maxTurns),
    providerOptions: { ollama: { options: { num_ctx: session.contextTokens } } },
    // The compaction policy itself is untouched HDO code (compaction.ts); everything in
    // this callback beyond the one call to it is the ModelMessage<->ChatMessage bridge
    // (messageBridge.ts) that reused policy needs to see the shape it was written
    // against - see this PoC's README for whether that bridge stayed as small as
    // ADR-0003 hoped. `instructions` is not re-sent here: it never changes (the protected
    // system message is never touched by compaction, which only ever rewrites index 1
    // onward - session.ts's `PROTECTED_MESSAGE_COUNT`), and an omitted `instructions` in a
    // `PrepareStepResult` falls back to the outer call's value.
    prepareStep: async ({ steps, stepNumber }) => {
      // `stepNumber` is 0-based and equals `steps.length` (ai@7.0.93 dist/index.js:
      // `stepNumber: steps.length`), so on every call after the first it is already the
      // 1-based number of the turn that JUST finished - the same `turn` the baseline's
      // `for (let turn = 1; ...)` loop would be reporting right now. The turn ABOUT to run
      // is one more than that; toolAdapter.ts's `execute` callbacks read it back off
      // `turnRef` while this step's tool calls are dispatched, after this function returns
      // and before the next `prepareStep` call.
      turnRef.current = stepNumber + 1;
      if (stepNumber > 0) {
        const last = steps[steps.length - 1]!;
        await foldStep(last, stepNumber, last.usage.inputTokens ?? 0);
      }
      return { messages: renderMessages() };
    },
  });

  // The step that ends the loop - whether the model simply stopped calling tools, or
  // `stopWhen` cut it off at the turn limit - never gets a following `prepareStep` call,
  // so it is folded in here instead. This is the one piece of the baseline's turn loop
  // `prepareStep` structurally cannot reach (ADR-0003 "compaction は SDK 内で実装できる",
  // point (c): "無 tool の終了 turn での閾値判定は... loop 終了後に HDO が行う").
  const lastStep = result.steps.at(-1);
  if (lastStep) {
    await foldStep(lastStep, result.steps.length, lastStep.usage.inputTokens ?? 0);
  }

  // Exhaustion, precisely: the loop stopped WHILE the model still wanted to call tools
  // (only `stopWhen`'s turn limit can do that - the model's own choice to stop always
  // means zero tool calls in the last step), matching the baseline's `exhausted` flag,
  // which is `false` exactly when a turn's `toolCalls.length === 0` breaks its `for` loop.
  const exhausted = (lastStep?.toolCalls.length ?? 0) > 0;
  if (exhausted) {
    warn(`Worker stopped after the ${session.maxTurns}-turn limit without finishing; reporting the incomplete state as a blocker.`);
    session.messages.push({
      role: "user",
      content: `You reached the ${session.maxTurns}-turn limit before finishing. Report what you completed, and record the unfinished work in 'blockers'.`,
    });
  }

  await compressFinalContext(session, turnsUsed);

  // Final turn: a SEPARATE call with no tools, forcing the orchestrator's schema via
  // `Output.object` + `jsonSchema()` over HDO's own `schemas/worker-result.schema.json`
  // (no zod schema authored here - see README for whether zod ends up installed anyway).
  // Kept as its own `generateText` call, not folded into the tool loop above, because
  // `output.responseFormat` is sent on EVERY step alongside `tools` (ai@7.0.93
  // dist/index.js:5938); Ollama native's `format` field constrains the entire turn to
  // JSON, which would fight the tool-calling turns above it exactly the way it does in
  // the baseline (ADR-0003, "structured final output"). `think: false` for the same
  // reason as the baseline: this turn only reformats work already done, and a thinking
  // model spends most of its budget on hidden tokens it does not need here.
  session.messages.push({ role: "user", content: "Now report what you did as a JSON object matching the required schema." });
  let finalContent = "";
  let finalPromptTokens = 0;
  const finalAttempts = 3;
  for (let attempt = 1; attempt <= finalAttempts; attempt++) {
    try {
      const final = await generateText({
        model,
        instructions,
        messages: renderMessages(),
        output: Output.object({ schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) }),
        providerOptions: { ollama: { think: false, options: { num_ctx: session.contextTokens } } },
      });
      finalContent = final.text ?? "";
      finalPromptTokens = final.steps.at(-1)?.usage.inputTokens ?? 0;
    } catch (error) {
      // `Output.object`'s parse can fail (empty content, malformed JSON) the same way an
      // empty `message.content` can on the baseline's native `/api/chat` call - both are
      // "the model produced nothing usable this attempt", not a reason to abort the whole
      // run before the retry loop gets a chance. `NoObjectGeneratedError` still carries
      // the raw text and usage the same as a successful call would, so a parse failure
      // does not lose the diagnostic the retry-count warning below reports.
      if (NoObjectGeneratedError.isInstance(error)) {
        finalContent = error.text ?? "";
        finalPromptTokens = error.usage?.inputTokens ?? 0;
      } else {
        throw error;
      }
    }
    if (finalContent.trim() !== "") break;
    warn(`Structured result attempt ${attempt} of ${finalAttempts} came back empty; retrying.`);
  }
  if (finalContent.trim() === "") {
    throw new Error(`Worker produced an empty structured result after ${finalAttempts} attempts.`);
  }

  writeFileSync(args.outputFile, finalContent, "utf8");
  process.stdout.write(
    `final: prompt_tokens=${finalPromptTokens} turns=${turnsUsed} num_ctx=${session.contextTokens} compactions=${session.compactionCount}\n`,
  );
}

run(process.argv.slice(2))
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });

export { run, buildInitialMessages, loadResponseSchema, normalizeWorkspace };
