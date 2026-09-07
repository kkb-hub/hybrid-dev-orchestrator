// Shared test harness for the lean worker's deterministic parity suite (port of
// tests/test-lean-worker.ps1's $stubScript + Invoke-WorkerAgainstStub + New-AssistantResponse
// + New-ToolCall + Get-FreePort, workers/hdo-ollama-worker.ps1's oracle test). Not itself a
// `*.test.ts` file, so `npm test`'s `node --test "src/**/*.test.ts"` glob never tries to run
// it directly - it is imported by toolLoop.test.ts, compaction.test.ts, and smoke.test.ts.
//
// --- why node:http on port 0, not a TcpListener-style probe-then-bind ----------------------
//
// The PS oracle's Get-FreePort binds a TcpListener, reads its assigned port, stops the
// listener, and hands that now-free port number to a SEPARATE background job that binds a
// new TcpListener a moment later. Between those two binds, any other process on the machine
// (including a concurrently-running instance of this same suite) can grab that port, which is
// exactly the TOCTOU race behind repo Issue #44 ("tests/test-lean-worker.ps1 flakes in CI
// with 'Index was outside the bounds of the array'" - the stub never sees the connection it
// was waiting for because something else is now listening on that port).
//
// This harness never separates "ask for a free port" from "bind to it": `server.listen(0, ...)`
// asks the OS to pick an ephemeral port AND binds to it in the same call, so the port this
// function hands back to the worker is already owned by the stub server before any caller can
// observe the port number at all. There is no window for another process to steal it.
//
// --- why the worker is launched with the ASYNC child_process API, not spawnSync/execFileSync ---
//
// The stub HTTP server above runs IN THIS SAME Node process/event loop. `execFileSync`/
// `spawnSync` block that event loop until the child exits - so if the child (the worker) is
// waiting on an HTTP response from a server that can only ever respond once this process's
// event loop is free to run its I/O callbacks, the two sides deadlock: the parent is blocked
// waiting for the child to exit, and the child is blocked waiting for a server that can never
// run because the parent's event loop is frozen. This is not a sandbox artifact; it is a
// structural consequence of Node's single-threaded event loop and has nothing to do with
// permissions. `execFile` (promisified) + `await` keeps the event loop free while the child
// runs, so the stub server's request handler actually gets to execute.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const WORKER_MAIN = resolve(HERE, "main.ts");
export const SCHEMA_PATH = resolve(REPO_ROOT, "schemas", "worker-result.schema.json");

/** Port of the PS test's `$structuredResult`. */
export const STRUCTURED_RESULT =
  '{"schemaVersion":1,"summary":"done","changedFiles":["a.txt"],"tests":[],"notes":[],"blockers":[]}';

export interface StubToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/** Port of `New-ToolCall`. */
export function newToolCall(name: string, args: Record<string, unknown>): StubToolCall {
  return { function: { name, arguments: args } };
}

export interface NewAssistantResponseOptions {
  content?: string;
  toolCalls?: StubToolCall[];
  /** Ollama marks the response counters `omitempty`, so a fully cached prompt really
   * does come back without `prompt_eval_count`. */
  omitTokenCounts?: boolean;
  /** `prompt_eval_count` is what the worker's compaction threshold reads, so a test
   * drives compaction by scripting this counter rather than by producing a genuinely
   * huge conversation. */
  promptTokens?: number;
}

/** Port of `New-AssistantResponse`. */
export function newAssistantResponse(options: NewAssistantResponseOptions = {}): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: options.content ?? "" };
  if (options.toolCalls) message.tool_calls = options.toolCalls;
  const response: Record<string, unknown> = { message, done_reason: "stop" };
  if (!options.omitTokenCounts) response.prompt_eval_count = options.promptTokens ?? 100;
  return response;
}

export interface StubServerHandle {
  port: number;
  /** Raw JSON text of every request body received so far, in arrival order - mutated
   * in place, so callers can read it any time after starting the server (including
   * mid-run, though every use in this suite reads it only after the worker exits). */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Starts the scripted-response stub server - port of the PS `$stubScript` background
 * job. Replays `responses` in order (one per accepted request) and records every raw
 * request body. A request past the end of `responses` gets a 500 with a diagnostic
 * body, so a test bug (too few scripted turns) fails fast with a clear cause instead of
 * the worker hanging on `AbortSignal.timeout`.
 */
export function startStubServer(responses: unknown[]): Promise<StubServerHandle> {
  const requests: string[] = [];
  let index = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      if (index >= responses.length) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "stub server received more requests than scripted responses" }));
        return;
      }
      const payload = JSON.stringify(responses[index]);
      index += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    // Port 0: the OS assigns and binds an ephemeral port atomically - see the header
    // comment above for why this closes Issue #44's race instead of merely narrowing it.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub server did not bind to a TCP port"));
        return;
      }
      resolvePromise({
        port: address.port,
        requests,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

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
  /** Child process timeout in milliseconds; defaults generously since every call here
   * is against a stub replying instantly, never a real model. */
  timeoutMs?: number;
}

export interface WorkerProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw content of the output file, or "" if the worker never wrote one (mirrors the
   * PS harness's `if (Test-Path $outputFile) {...} else {''}`). */
  output: string;
}

/** Runs the worker (`src/workers/leanWorker/main.ts`) as a child process against
 * `args.ollamaUri` and returns its exit code, both output streams, and whatever it
 * wrote to `-OutputFile` - port of the process-launching half of
 * `Invoke-WorkerAgainstStub` (the request-log/stub-server half lives in
 * `startStubServer` above; this function only knows about spawning the worker). */
export async function runWorkerProcess(args: RunWorkerProcessArgs): Promise<WorkerProcessResult> {
  const scratch = mkdtempSync(join(tmpdir(), "hdo-lean-worker-run-"));
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
      // execFile rejects on a non-zero exit code; the PS harness instead captures
      // $LASTEXITCODE after a normal (non-throwing) invocation, so this branch
      // reproduces that same "non-zero exit is an ordinary, expected outcome" shape.
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
  /** Raw JSON text of every request the worker sent, in order - parse with
   * `JSON.parse` to inspect `.messages`/`.tools`/`.format`/etc. */
  requests: string[];
}

/** Port of `Invoke-WorkerAgainstStub`: starts a scripted stub server, runs the worker
 * against it, and returns both the process result and the recorded requests. */
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

/** Parses one recorded request body into the shape the assertions need. */
export function parseRequest(raw: string): {
  messages: Array<{ role: string; content: string; tool_name?: string; tool_calls?: unknown[] }>;
  tools?: unknown[];
  format?: { required?: string[] };
  think?: boolean;
  options?: { num_ctx?: number };
} {
  return JSON.parse(raw);
}

/** Every tool-role message's `content`, in order, from a parsed request. */
export function toolResultContents(request: ReturnType<typeof parseRequest>): string[] {
  return request.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}
