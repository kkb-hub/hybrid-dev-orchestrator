// Test harness for this PoC's own deterministic suite - modelled on
// src/workers/leanWorker/testHarness.ts (see that file's header for the two load-bearing
// design decisions this one inherits verbatim rather than re-deriving: a `node:http`
// server bound with `listen(0)` so the OS assigns and binds an ephemeral port in one
// atomic step, and launching the worker with the ASYNC `execFile` (promisified), never
// `execFileSync`/`spawnSync` - a sync spawn would block this process's event loop, and the
// stub server run IN THIS SAME PROCESS could then never get to answer the child's
// request, deadlocking both sides).
//
// The stub-server half (`startStubServer`, `newToolCall`, `parseRequest`,
// `toolResultContents`, `STRUCTURED_RESULT`, `SCHEMA_PATH`) is generic Ollama-protocol
// scaffolding with no opinion on which worker binary is under test, so it is imported
// from the baseline's harness unchanged rather than duplicated. Only the process-launching
// half is PoC-local, because the baseline's own equivalent (`runWorkerProcess`) hardcodes
// ITS `main.ts` as the child script.
//
// `newAssistantResponse` is the one exception: it is wrapped, not re-exported unchanged
// (see below) - `ollama-ai-provider-v2` validates the response body against a zod schema
// (dist/index.mjs's `baseOllamaResponseSchema2`) requiring `model`/`created_at`/`done`
// fields the PS oracle's own `/api/chat` contract never made mandatory and the baseline's
// stub (and its `Invoke-OllamaChat`/`invokeOllamaChat`) never needed. Without them every
// scripted reply here fails that provider-side validation with a generic "Invalid JSON
// response", which is itself a fact worth recording (README): the AI SDK route is stricter
// about the wire format than either worker implementation's own client code is.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  newAssistantResponse as newBaselineAssistantResponse,
  newToolCall,
  parseRequest,
  REPO_ROOT,
  SCHEMA_PATH,
  startStubServer,
  STRUCTURED_RESULT,
  toolResultContents,
  type NewAssistantResponseOptions,
  type StubServerHandle,
} from "../../../src/workers/leanWorker/testHarness.ts";

export { newToolCall, parseRequest, REPO_ROOT, SCHEMA_PATH, startStubServer, STRUCTURED_RESULT, toolResultContents };
export type { StubServerHandle };

/** Wraps the baseline's `newAssistantResponse` with the three fields
 * `ollama-ai-provider-v2` requires but the baseline's own worker and tests never needed -
 * see the header comment above. */
export function newAssistantResponse(options: NewAssistantResponseOptions = {}): Record<string, unknown> {
  return { model: "stub-model", created_at: new Date(0).toISOString(), done: true, ...newBaselineAssistantResponse(options) };
}

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
export const WORKER_MAIN = resolve(HERE, "main.ts");

export interface RunWorkerProcessArgs {
  ollamaUri: string;
  workspace: string;
  prompt?: string;
  readOnly?: boolean;
  maxToolResultChars?: number;
  maxTurns?: number;
  contextTokens?: number;
  compactAtPercent?: number;
  keepRecentMessages?: number;
  timeoutMs?: number;
}

export interface WorkerProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** Runs THIS PoC's worker (`poc/ai-sdk/src/main.ts`) as a child process against
 * `args.ollamaUri` - the CLI-argument-building half of the baseline's `runWorkerProcess`,
 * repointed at this PoC's own entry point (same flag names, per the CLI-contract
 * requirement in main.ts's own header comment). */
export async function runWorkerProcess(args: RunWorkerProcessArgs): Promise<WorkerProcessResult> {
  const scratch = mkdtempSync(join(tmpdir(), "hdo-ai-sdk-poc-run-"));
  try {
    const promptFile = join(scratch, "prompt.md");
    const outputFile = join(scratch, "final.json");
    writeFileSync(promptFile, args.prompt ?? "do the thing", "utf8");

    const argv = [
      WORKER_MAIN,
      "-PromptFile",
      promptFile,
      "-OutputFile",
      outputFile,
      "-SchemaFile",
      SCHEMA_PATH,
      "-WorkingDirectory",
      args.workspace,
      "-Model",
      "stub-model",
      "-ContextTokens",
      String(args.contextTokens ?? 32768),
      "-MaxToolResultChars",
      String(args.maxToolResultChars ?? 20000),
      "-MaxTurns",
      String(args.maxTurns ?? 40),
      "-CompactAtPercent",
      String(args.compactAtPercent ?? 65),
      "-KeepRecentMessages",
      String(args.keepRecentMessages ?? 6),
      "-OllamaUri",
      args.ollamaUri,
    ];
    if (args.readOnly) argv.push("-ReadOnly");

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(process.execPath, argv, {
        encoding: "utf8",
        timeout: args.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const execError = error as { code?: number; stdout?: string; stderr?: string };
      exitCode = typeof execError.code === "number" ? execError.code : 1;
      stdout = execError.stdout ?? "";
      stderr = execError.stderr ?? "";
    }

    return {
      exitCode,
      stdout,
      stderr,
      output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface RunWorkerAgainstStubArgs {
  responses: unknown[];
  workspace: string;
  prompt?: string;
  readOnly?: boolean;
  maxToolResultChars?: number;
  maxTurns?: number;
  contextTokens?: number;
  compactAtPercent?: number;
  keepRecentMessages?: number;
}

export interface WorkerRunResult extends WorkerProcessResult {
  requests: string[];
}

/** Starts a scripted stub server, runs this PoC's worker against it, and returns both the
 * process result and the recorded requests - repoints the baseline's
 * `runWorkerAgainstStub` at this module's own `runWorkerProcess`. */
export async function runWorkerAgainstStub(args: RunWorkerAgainstStubArgs): Promise<WorkerRunResult> {
  const stub = await startStubServer(args.responses);
  try {
    const processResult = await runWorkerProcess({
      ollamaUri: `http://127.0.0.1:${stub.port}/api/chat`,
      workspace: args.workspace,
      prompt: args.prompt,
      readOnly: args.readOnly,
      maxToolResultChars: args.maxToolResultChars,
      maxTurns: args.maxTurns,
      contextTokens: args.contextTokens,
      compactAtPercent: args.compactAtPercent,
      keepRecentMessages: args.keepRecentMessages,
    });
    return { ...processResult, requests: stub.requests };
  } finally {
    await stub.close();
  }
}
