// NodeProcessRunner: the Node.js equivalent of Invoke-HdoProcess / BoundedProcessCapture
// in Common.ps1. Spawns with an argv array (never `shell: true`), bounds stdout/stderr
// to `maximumOutputBytes` each while retaining only a diagnostic tail once a stream is
// truncated, enforces a wall-clock timeout, bounds the post-exit output drain, and
// always redacts secrets out of the captured text before returning it.
//
// Environment: when `options.env` is omitted, the child inherits `process.env`
// (matching HDO's default `Invoke-Process` behaviour of not clearing the environment).
// When `options.env` IS provided, the child gets exactly those variables as far as
// this runner is concerned - but on Windows, libuv itself (not this code) always
// injects a fixed list of variables into a child spawned with an explicit `env`:
// HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN,
// USERNAME, USERPROFILE, WINDIR. There is no way to suppress this from Node; callers
// on Windows should treat an explicit `env` as "my variables plus that fixed libuv
// list", not as a hard allow-list. `cli/probe.ts`'s `explicitEnvExtraKeys` field
// measures exactly which extra keys show up. POSIX has no such injection: an explicit
// env is exactly what the child sees.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BoundedProcessResult,
  ProcessRunner,
  ProcessRunOptions,
  TerminationReason,
} from "../core/process/types.ts";
import { redactSecrets } from "../core/process/redact.ts";
import type { PlatformAdapter } from "../platform/types.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_OUTPUT_DRAIN_SECONDS = 2;

class BoundedCapture {
  private readonly maximumBytes: number;
  private readonly tail: Buffer;
  private tailStart = 0;
  private tailCount = 0;
  totalBytes = 0;
  limitExceeded = false;

  constructor(maximumBytes: number, tailBytes: number) {
    this.maximumBytes = maximumBytes;
    this.tail = Buffer.alloc(Math.max(1, tailBytes));
  }

  /** Returns the prefix of `chunk` that was within the remaining budget (for bounding file writes). */
  append(chunk: Buffer): Buffer {
    const remaining = this.maximumBytes - this.totalBytes;
    const accepted = remaining <= 0 ? 0 : Math.min(chunk.length, remaining);
    const acceptedChunk = chunk.subarray(0, accepted);
    if (accepted > 0) {
      for (const byte of acceptedChunk) {
        if (this.tailCount < this.tail.length) {
          this.tail[(this.tailStart + this.tailCount) % this.tail.length] = byte;
          this.tailCount++;
        } else {
          this.tail[this.tailStart] = byte;
          this.tailStart = (this.tailStart + 1) % this.tail.length;
        }
      }
    }
    this.totalBytes += chunk.length;
    if (chunk.length > accepted) this.limitExceeded = true;
    return acceptedChunk;
  }

  text(): string {
    const out = Buffer.alloc(this.tailCount);
    for (let i = 0; i < this.tailCount; i++) {
      out[i] = this.tail[(this.tailStart + i) % this.tail.length];
    }
    return out.toString("utf8");
  }
}

function buildEnvironment(options: ProcessRunOptions): NodeJS.ProcessEnv | undefined {
  if (!options.env) return undefined;
  return { ...options.env };
}

// H-05: Node's own `err.message` for an errno error (e.g. "EEXIST: file already
// exists, mkdir 'x'") already starts with the error code, so naively prepending
// `${code}: ` again produced "EEXIST: EEXIST: file already exists...". Strip that
// leading `${code}: ` from the raw message (if present) before re-adding it exactly
// once, so every caller's `Failed to capture process output: <code>: <message>` names
// the code a single time regardless of whether the underlying message already did.
function errnoMessage(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  const rawMessage = err.message ?? String(error);
  const code = err.code;
  if (!code) return rawMessage;
  const duplicatedPrefix = `${code}: `;
  const message = rawMessage.startsWith(duplicatedPrefix) ? rawMessage.slice(duplicatedPrefix.length) : rawMessage;
  return `${code}: ${message}`;
}

export interface NodeProcessRunnerOptions {
  platform: PlatformAdapter;
}

/** Fields that are constant regardless of which path through `run()` produced the result. */
interface FinalizeInput {
  command: string;
  args: string[];
  startedAt: Date;
  maximumOutputBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutText: string;
  stderrText: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  outputLimitStream: "" | "stdout" | "stderr";
  outputDrainTimedOut: boolean;
  terminationReason: TerminationReason;
  inputError: string;
  captureError: string;
  realExitCode: number | null;
}

function exitCodeFor(reason: TerminationReason, realExitCode: number | null): number {
  switch (reason) {
    case "timeout":
      return 124;
    case "outputLimit":
      return 125;
    case "inputError":
      return 126;
    case "captureError":
      return 127;
    default:
      return realExitCode ?? 1;
  }
}

function finalize(input: FinalizeInput): BoundedProcessResult {
  const endedAt = new Date();
  return {
    command: input.command,
    args: input.args,
    exitCode: exitCodeFor(input.terminationReason, input.realExitCode),
    timedOut: input.timedOut,
    outputLimitExceeded: input.outputLimitExceeded,
    outputLimitStream: input.outputLimitStream,
    outputDrainTimedOut: input.outputDrainTimedOut,
    terminationReason: input.terminationReason,
    inputError: input.inputError,
    captureError: input.captureError,
    maximumOutputBytes: input.maximumOutputBytes,
    stdoutBytes: input.stdoutBytes,
    stderrBytes: input.stderrBytes,
    stdout: redactSecrets(input.stdoutText),
    stderr: redactSecrets(input.stderrText),
    startedAt: input.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - input.startedAt.getTime(),
  };
}

export class NodeProcessRunner implements ProcessRunner {
  private readonly platform: PlatformAdapter;

  constructor(options: NodeProcessRunnerOptions) {
    this.platform = options.platform;
  }

  async run(options: ProcessRunOptions): Promise<BoundedProcessResult> {
    const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const tailBytes = options.outputTailBytes ?? DEFAULT_TAIL_BYTES;
    const outputDrainSeconds = options.outputDrainSeconds ?? DEFAULT_OUTPUT_DRAIN_SECONDS;
    const startedAt = new Date();

    const stdoutCapture = new BoundedCapture(maximumOutputBytes, tailBytes);
    const stderrCapture = new BoundedCapture(maximumOutputBytes, tailBytes);

    // F-06: validate cwd up front so a missing working directory is reported the same
    // way as any other "could not carry out the request" case (127, non-empty stderr)
    // instead of Node's spawn ENOENT surfacing indirectly.
    let cwdOk = false;
    try {
      cwdOk = statSync(options.cwd).isDirectory();
    } catch {
      cwdOk = false;
    }
    if (!cwdOk) {
      const message = `ENOENT: working directory does not exist or is not a directory: ${options.cwd}`;
      return finalize({
        command: options.command,
        args: options.args,
        startedAt,
        maximumOutputBytes,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutText: "",
        stderrText: `Failed to capture process output: ${message}`,
        timedOut: false,
        outputLimitExceeded: false,
        outputLimitStream: "",
        outputDrainTimedOut: false,
        terminationReason: "captureError",
        inputError: "",
        captureError: message,
        realExitCode: null,
      });
    }

    // G-03: `openWriteStream` (specifically its `mkdir(..., { recursive: true })`) can
    // throw (EEXIST/ENOTDIR when an ancestor path segment is itself a file, etc.).
    // That must be reported the same way as any other capture failure - a result, never
    // a rejected promise - mirroring PowerShell's `PumpAsync`, which keeps
    // `Directory.CreateDirectory` inside its own try/catch. Nothing has been spawned
    // yet at this point, so there is no process tree to kill.
    let stdoutFile: ReturnType<typeof createWriteStream> | undefined;
    let stderrFile: ReturnType<typeof createWriteStream> | undefined;
    try {
      if (options.stdoutPath) stdoutFile = await this.openWriteStream(options.stdoutPath);
      if (options.stderrPath) stderrFile = await this.openWriteStream(options.stderrPath);
    } catch (error) {
      await Promise.all([this.closeWriteStream(stdoutFile), this.closeWriteStream(stderrFile)]);
      const message = errnoMessage(error);
      return finalize({
        command: options.command,
        args: options.args,
        startedAt,
        maximumOutputBytes,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutText: "",
        stderrText: `Failed to capture process output: ${message}`,
        timedOut: false,
        outputLimitExceeded: false,
        outputLimitStream: "",
        outputDrainTimedOut: false,
        terminationReason: "captureError",
        inputError: "",
        captureError: message,
        realExitCode: null,
      });
    }

    let child: ChildProcess;
    try {
      // F-04: a `.cmd`/`.bat` path slipping through (e.g. a caller-supplied absolute
      // path) makes `spawn` throw *synchronously* on Windows (EINVAL, CVE-2024-27980)
      // rather than emitting an async `error` event. Converting that into a normal
      // result (rather than letting `run()` reject) keeps this function's contract
      // uniform: every failure to execute is a result, never a thrown exception.
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: buildEnvironment(options),
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform.spawnDetached,
        windowsHide: true,
      });
    } catch (error) {
      await Promise.all([this.closeWriteStream(stdoutFile), this.closeWriteStream(stderrFile)]);
      const message = errnoMessage(error);
      return finalize({
        command: options.command,
        args: options.args,
        startedAt,
        maximumOutputBytes,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutText: "",
        stderrText: `Failed to capture process output: ${message}`,
        timedOut: false,
        outputLimitExceeded: false,
        outputLimitStream: "",
        outputDrainTimedOut: false,
        terminationReason: "captureError",
        inputError: "",
        captureError: message,
        realExitCode: null,
      });
    }

    // F-02 step 1: attach `close` synchronously, right after spawn, with no `await` in
    // between - Node can emit `close` synchronously right after `exit` when the pipes
    // have already ended (e.g. a child that produced no output and exited instantly),
    // and a listener attached later would miss it.
    let closeSeen = false;
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolvePromise) => {
      closeResolve = resolvePromise;
    });
    child.on("close", () => {
      closeSeen = true;
      closeResolve?.();
    });

    let settled = false;
    let terminationReason: TerminationReason = "";
    let terminationMessage = "";
    let timedOut = false;
    let limitExceeded = false;
    let limitStream: "" | "stdout" | "stderr" = "";
    let inputErrorMessage = "";
    let captureErrorMessage = "";
    let outputDrainTimedOut = false;

    const setTermination = (reason: TerminationReason, message: string): void => {
      if (terminationReason !== "") return; // first cause wins
      terminationReason = reason;
      terminationMessage = message;
      if (reason === "timeout") timedOut = true;
      if (reason === "inputError") inputErrorMessage = message;
      if (reason === "captureError") captureErrorMessage = message;
    };

    const killTree = async (): Promise<void> => {
      if (typeof child.pid === "number") {
        await this.platform.killProcessTree(child.pid);
      }
    };

    // F-06 (async half): the process could not be spawned at all (ENOENT et al). This
    // resolves the primary wait below via the `error` promise race.
    child.on("error", (error) => {
      if (!settled) setTermination("captureError", `Failed to capture process output: ${errnoMessage(error)}`);
    });

    // F-07: an output capture file failing (e.g. `stdoutPath` pointing at a directory,
    // EISDIR) must not crash the host; record it, kill the tree, and let the normal
    // finalize path map it to 127 like any other capture error.
    stdoutFile?.on("error", (error) => {
      if (!settled) {
        setTermination("captureError", `Failed to capture process output: ${errnoMessage(error)}`);
        void killTree();
      }
    });
    stderrFile?.on("error", (error) => {
      if (!settled) {
        setTermination("captureError", `Failed to capture process output: ${errnoMessage(error)}`);
        void killTree();
      }
    });

    // G-05: once the limit fires, stop reading from the OFFENDING stream only (mirrors
    // PowerShell's `PumpAsync`, which breaks out of its read loop on the first
    // overflowing chunk). Destroying just that Readable closes this end of the pipe
    // (H-04: not merely "stops draining it"), so the child's next write to that fd
    // fails instead of the host continuing to read-and-discard megabytes per second
    // until `killTree()` (async, taskkill-based on Windows) actually lands. Observed
    // effect on the child: POSIX delivers EPIPE to the writing syscall (and, if the
    // child does not handle/ignore SIGPIPE, the default disposition kills it with that
    // signal); Windows has no SIGPIPE, but a Node child's next write to the now-closed
    // pipe throws inside its own process, and if that write was unguarded this surfaces
    // as an unhandled-error/uncaught-exception trace from the child - which, if the
    // closed stream is stderr, is itself still being captured until the fd fully closes
    // and so can end up as the last bytes in the stderr capture file (see README
    // "既知の制約"). The other stream keeps draining to EOF as usual, exactly like PS
    // does.
    const maybeEnforceLimit = (capture: BoundedCapture, streamName: "stdout" | "stderr"): void => {
      if (!settled && capture.limitExceeded && !limitExceeded) {
        limitExceeded = true;
        limitStream = streamName;
        setTermination("outputLimit", `Process ${streamName} exceeded the HDO output limit of ${maximumOutputBytes} bytes.`);
        if (streamName === "stdout") child.stdout?.destroy();
        else child.stderr?.destroy();
        void killTree();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const accepted = stdoutCapture.append(chunk);
      if (stdoutFile && accepted.length > 0) stdoutFile.write(accepted);
      maybeEnforceLimit(stdoutCapture, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const accepted = stderrCapture.append(chunk);
      if (stderrFile && accepted.length > 0) stderrFile.write(accepted);
      maybeEnforceLimit(stderrCapture, "stderr");
    });

    // F-01: writing to stdin can fail (EPIPE/EOF) whenever the child exits before
    // consuming all of `inputText`. Both the stream's own `error` event and the
    // `write()` callback can report this; either path records the same cause.
    child.stdin?.on("error", (error) => {
      if (!settled) {
        setTermination("inputError", `Failed to write process input: ${errnoMessage(error)}`);
        void killTree();
      }
    });
    if (options.inputText !== undefined) {
      child.stdin?.write(options.inputText, "utf8", (error) => {
        if (error && !settled) {
          setTermination("inputError", `Failed to write process input: ${errnoMessage(error)}`);
          void killTree();
        }
      });
    }
    child.stdin?.end();

    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    if (options.onHeartbeat && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        const now = new Date();
        options.onHeartbeat?.({ at: now.toISOString(), elapsedSeconds: Math.floor((now.getTime() - startedAt.getTime()) / 1000) });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    const timeoutMs = options.timeoutSeconds * 1000;
    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        setTermination("timeout", `Process exceeded the timeout of ${options.timeoutSeconds}s.`);
        void killTree();
      }
    }, timeoutMs);

    // F-02 step 2: the primary wait is `exit`/`error`, never `close` - `close` needs
    // every stdio pipe to reach EOF, which can hang long after the direct child (and
    // the whole logical operation) is actually done if a grandchild inherited a pipe.
    const primary = await new Promise<{ code: number | null } | { error: true }>((resolvePromise) => {
      child.once("error", () => resolvePromise({ error: true }));
      child.once("exit", (code) => resolvePromise({ code }));
    });
    settled = true;
    clearTimeout(timeoutTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const realExitCode = "code" in primary ? primary.code : null;

    // F-02 steps 3-4: bounded drain. Only meaningful if the process actually spawned
    // (has a pid) - a spawn-time `error` never opens real OS pipes to drain.
    if (typeof child.pid === "number" && !closeSeen) {
      // G-01: keep the timer handle so it can be cleared as soon as the race settles.
      // Previously, when `closePromise` won the race, the `setTimeout` callback stayed
      // armed (and ref'd) for the remainder of `outputDrainSeconds`, keeping the host
      // process alive for up to that long after `run()` had already returned.
      let drainTimer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        closePromise.then(() => true),
        new Promise<boolean>((resolvePromise) => {
          drainTimer = setTimeout(() => resolvePromise(false), outputDrainSeconds * 1000);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      if (!drained && !closeSeen) {
        await killTree();
        child.stdout?.destroy();
        child.stderr?.destroy();
        outputDrainTimedOut = true;
        setTermination(
          "captureError",
          "Failed to capture process output: stdout/stderr remained open after the process exited; output capture was cancelled after the drain timeout.",
        );
      }
    }

    await Promise.all([this.closeWriteStream(stdoutFile), this.closeWriteStream(stderrFile)]);

    const stderrText = redactableStderr(terminationReason, terminationMessage, stderrCapture.text());

    return finalize({
      command: options.command,
      args: options.args,
      startedAt,
      maximumOutputBytes,
      stdoutBytes: stdoutCapture.totalBytes,
      stderrBytes: stderrCapture.totalBytes,
      stdoutText: stdoutCapture.text(),
      stderrText,
      timedOut,
      outputLimitExceeded: limitExceeded,
      outputLimitStream: limitStream,
      outputDrainTimedOut,
      terminationReason,
      inputError: inputErrorMessage,
      captureError: captureErrorMessage,
      realExitCode,
    });
  }

  private async openWriteStream(path: string) {
    await mkdir(dirname(path), { recursive: true });
    return createWriteStream(path);
  }

  private async closeWriteStream(stream?: ReturnType<typeof createWriteStream>): Promise<void> {
    if (!stream) return;
    if (stream.destroyed) return;
    await new Promise<void>((resolvePromise) => stream.end(() => resolvePromise()));
  }
}

/**
 * When a termination cause fired, its message replaces stderr (mirroring
 * `Invoke-HdoProcess`, which overwrites `$result.stderr` with a synthesized message
 * for the input-error/capture-error/output-limit cases). The real captured stderr
 * text is preserved as-is otherwise.
 */
function redactableStderr(reason: TerminationReason, message: string, capturedStderr: string): string {
  if (reason === "inputError" || reason === "captureError" || reason === "outputLimit") return message;
  return capturedStderr;
}
