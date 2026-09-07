#!/usr/bin/env node
// Entry point for the lean Ollama worker - TypeScript port of
// workers/hdo-ollama-worker.ps1 (ADR-0001 Migration strategy phase 8, "workers" step a).
//
// workers/hdo-ollama-worker.ps1 itself is NOT modified by this port: it remains the
// PowerShell oracle the parity test suite checks this file against, and goes to
// maintenance mode once this port lands. Every stdout diagnostic line, tool-result
// string, error message, and system-prompt fragment below is reproduced from that source
// verbatim (see the per-module headers in this directory for exactly which PS
// function each piece ports).
//
// Zero runtime dependencies: file I/O via `node:fs`, HTTP via native `fetch` (Node 24),
// no framework. Run directly by Node's TypeScript type-stripping (ADR-0001) - there is no
// build step, so `node src/workers/leanWorker/main.ts ...` IS the deployed artifact.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parse, resolve, sep } from "node:path";
import { parseWorkerArgs } from "./args.ts";
import { compressFinalContext, testCompactionThresholdCrossed } from "./compaction.ts";
import { warn } from "./log.ts";
import { convertToRequestToolCall, invokeOllamaChat, type OllamaToolCall } from "./ollamaClient.ts";
import { createSession, type ChatMessage } from "./session.ts";
import { dispatchTool } from "./tools.ts";
import { getTools } from "./toolDefinitions.ts";
import { registerToolOutcome } from "./verifiedState.ts";

/** Port of `(Resolve-Path -LiteralPath $WorkingDirectory).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)`.
 * Guards against reducing a bare drive/filesystem root (`C:\`) to a drive-relative form
 * (`C:`) the way an unconditional trim would - mirrors the same guard in
 * src/platform/paths.ts's `normalizeNoTrailingSep` (G-04). */
function normalizeWorkspace(workingDirectory: string): string {
  const full = resolve(workingDirectory);
  if (parse(full).root === full) return full;
  return full.endsWith(sep) ? full.slice(0, -sep.length) : full;
}

/** Reads the schema file and strips the JSON Schema meta-keywords Ollama rejects - port
 * of the `$schema` handling right before the PS worker builds its initial messages
 * (Runner script lines 1114-1119). "The same way the Claude and Codex adapters normalize
 * a schema before handing it to their CLI." */
function loadResponseSchema(schemaFile: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(schemaFile, "utf8")) as Record<string, unknown>;
  for (const metaKeyword of ["$schema", "$id", "title"]) {
    delete parsed[metaKeyword];
  }
  return parsed;
}

/** Builds the two protected messages (system prompt, operator's task) - port of the
 * `$capabilities`/`$contextRules`/`$script:Messages` assembly (Runner script lines
 * 1121-1157). */
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
  const tools = getTools(args.readOnly);

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
    tools,
  });

  const promptText = readFileSync(args.promptFile, "utf8");
  session.messages = buildInitialMessages(args.readOnly, promptText);

  let turnsUsed = 0;
  let exhausted = true;

  for (let turn = 1; turn <= session.maxTurns; turn++) {
    turnsUsed = turn;
    const sentCount = session.messages.length;
    const response = await invokeOllamaChat({
      uri: session.ollamaUri,
      model: session.model,
      messages: session.messages,
      tools: session.tools,
      contextTokens: session.contextTokens,
      requestTimeoutSeconds: session.requestTimeoutSeconds,
    });
    const promptTokens = response.prompt_eval_count ?? 0;

    const assistant: ChatMessage = { role: "assistant", content: response.message?.content ?? "" };
    let toolCalls: OllamaToolCall[] = [];
    if (response.message?.tool_calls && response.message.tool_calls.length > 0) {
      toolCalls = response.message.tool_calls;
      assistant.tool_calls = toolCalls.map(convertToRequestToolCall);
    }
    session.messages.push(assistant);
    process.stdout.write(`turn ${turn}: prompt_tokens=${promptTokens} tool_calls=${toolCalls.length}\n`);

    if (toolCalls.length === 0) {
      exhausted = false;
      // The loop is about to end here, before the compaction check below this block ever
      // runs. Nothing bounds the size of response.message.content the way tool results
      // are bounded by maxToolResultChars, so a verbose closing turn can be the single
      // largest message of the whole session; skipping this check would let it reach
      // compressFinalContext, and then the final Ollama call, unreduced.
      await testCompactionThresholdCrossed(session, turn, sentCount, promptTokens);
      break;
    }

    for (const call of toolCalls) {
      const toolName = String(call.function.name);
      const toolArguments =
        call.function.arguments && typeof call.function.arguments === "object"
          ? (call.function.arguments as Record<string, unknown>)
          : {};
      let failed = false;
      let readWasWhole = false;
      let result: string;
      try {
        const dispatched = dispatchTool(
          { workspace: session.workspace, readOnly: session.readOnly, maxToolResultChars: session.maxToolResultChars },
          toolName,
          toolArguments,
        );
        result = dispatched.text;
        readWasWhole = dispatched.readWasWhole;
      } catch (error) {
        // Returned to the model rather than thrown: a wrong path or a non-unique edit is
        // something it can correct on the next turn. maxTurns bounds the retries.
        // Mirrored to stderr so HDO's artifacts record the attempt.
        const message = (error as Error).message;
        result = `ERROR: ${message}`;
        failed = true;
        warn(`tool '${toolName}' failed: ${message}`);
      }
      registerToolOutcome(session, turn, toolName, toolArguments, result, failed, readWasWhole);
      session.messages.push({ role: "tool", tool_name: toolName, content: result });
    }

    await testCompactionThresholdCrossed(session, turn, sentCount, promptTokens);
  }

  if (exhausted) {
    warn(`Worker stopped after the ${session.maxTurns}-turn limit without finishing; reporting the incomplete state as a blocker.`);
    session.messages.push({
      role: "user",
      content: `You reached the ${session.maxTurns}-turn limit before finishing. Report what you completed, and record the unfinished work in 'blockers'.`,
    });
  }

  await compressFinalContext(session, turnsUsed);

  // Final turn carries no tools and forces the orchestrator's schema, so the structured
  // result cannot be confused with another tool call. Reasoning is disabled here because
  // this turn only reformats work already done: on a thinking model it otherwise spends
  // most of its budget on hidden tokens and can return an empty content field.
  session.messages.push({ role: "user", content: "Now report what you did as a JSON object matching the required schema." });
  let finalContent = "";
  let finalPromptTokens = 0;
  const finalAttempts = 3;
  for (let attempt = 1; attempt <= finalAttempts; attempt++) {
    const final = await invokeOllamaChat({
      uri: session.ollamaUri,
      model: session.model,
      messages: session.messages,
      format: schema,
      think: false,
      contextTokens: session.contextTokens,
      requestTimeoutSeconds: session.requestTimeoutSeconds,
    });
    finalContent = final.message?.content ?? "";
    finalPromptTokens = final.prompt_eval_count ?? 0;
    if (finalContent.trim() !== "") break;
    // Observed on qwen3.8: an occasional empty content field after a tool loop. The work
    // is already on disk at this point, so retrying the report is far better than failing
    // a completed step; a persistent empty result still fails closed below.
    warn(`Structured result attempt ${attempt} of ${finalAttempts} came back empty; retrying.`);
  }
  if (finalContent.trim() === "") {
    throw new Error(`Worker produced an empty structured result after ${finalAttempts} attempts.`);
  }

  // No BOM: Node's utf8 file writes never emit one, matching PowerShell's explicit
  // [Text.UTF8Encoding]::new($false).
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
    // Mirrors the PS oracle's top-level $ErrorActionPreference = 'Stop' behaviour: write
    // the message to stderr and exit non-zero, without dumping a stack trace.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });

// Exported for tests: `run` is the whole orchestration entry point (a fresh
// stub-HTTP-backed invocation is the natural way to test it end to end);
// `buildInitialMessages`/`loadResponseSchema`/`normalizeWorkspace` are small pure
// functions worth asserting on directly without spinning up a server.
export { run, buildInitialMessages, loadResponseSchema, normalizeWorkspace };
