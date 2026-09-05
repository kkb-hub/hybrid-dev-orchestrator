// Pure types shared between the core-side callers and the platform/process-side
// implementation. The interface itself lives in core so that anything depending on
// "how do I run a process" can be written and tested against this contract without
// importing `node:child_process`. The implementation (NodeProcessRunner) lives in
// `../../process/runner.ts`, outside `core`.

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Text written to stdin and then closed. Omit to close stdin immediately. */
  inputText?: string;
  timeoutSeconds: number;
  /**
   * When provided, the child process receives ONLY these variables. Node/libuv itself
   * (not this PoC) additionally injects a fixed list of variables on Windows whenever
   * `env` is explicit - see `process/runner.ts` `buildEnvironment` for the exact list.
   * When `env` is omitted, the child inherits the current process environment.
   */
  env?: Record<string, string>;
  maximumOutputBytes?: number;
  outputTailBytes?: number;
  /**
   * Seconds to wait for stdout/stderr pipes to report `close` after the process has
   * exited (or been killed) before giving up on drain and destroying the streams.
   * Mirrors PowerShell's `Invoke-HdoProcess -OutputDrainSeconds` (default 2). This
   * bounds the case where a descendant (never a member of libuv's job) inherited the
   * pipe handle and is still holding it open long after the direct child exited.
   */
  outputDrainSeconds?: number;
  /** Optional: also persist the full (unbounded within the process's own limits) stream to a file. */
  stdoutPath?: string;
  stderrPath?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (event: { at: string; elapsedSeconds: number }) => void;
}

/**
 * Single terminating cause, recorded as whichever of these happens *first*
 * (chronologically) during a run - never a priority re-ranking after the fact. Once
 * one is recorded the process tree is killed and no other cause can subsequently
 * overwrite it. `exitCode` is derived directly from this field:
 *   ""           -> the child's real exit code (or 1 if unknown/killed by signal)
 *   "timeout"    -> 124 (wall-clock timeout elapsed, mirrors `Invoke-HdoProcess`)
 *   "outputLimit"-> 125 (stdout or stderr exceeded `maximumOutputBytes`)
 *   "inputError" -> 126 (writing `inputText` to stdin failed, e.g. EPIPE/EOF because
 *                   the child exited before consuming it)
 *   "captureError" -> 127 (catch-all: process failed to spawn at all - ENOENT/EINVAL
 *                   - a stdout/stderr capture file could not be written - e.g. EISDIR
 *                   - or the output pipes did not report `close` within
 *                   `outputDrainSeconds` of the process exiting, i.e. a descendant is
 *                   still holding the pipe open). 127 is the conventional "command not
 *                   found/could not be executed" shell exit code; PowerShell's
 *                   `Invoke-HdoProcess` instead throws for the "not found" case, but
 *                   this PoC represents every "we could not fully carry out the
 *                   request" case as a result value rather than a thrown exception.
 */
export type TerminationReason = "" | "timeout" | "outputLimit" | "inputError" | "captureError";

export interface BoundedProcessResult {
  command: string;
  args: string[];
  /** See `TerminationReason` above for the exact derivation. */
  exitCode: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  outputLimitStream: "" | "stdout" | "stderr";
  /**
   * True when the process's own exit was observed promptly but its stdout/stderr
   * pipes did not report `close` within `outputDrainSeconds` afterwards (a
   * grandchild inherited the handle and is still holding it open) and the runner
   * gave up on draining and destroyed the streams instead of hanging.
   */
  outputDrainTimedOut: boolean;
  /** The single first-observed terminating cause; see `TerminationReason`. */
  terminationReason: TerminationReason;
  /** Non-empty iff writing `inputText` to stdin failed (see `TerminationReason`). */
  inputError: string;
  /** Non-empty iff spawning the process or capturing its output failed outright. */
  captureError: string;
  maximumOutputBytes: number;
  /**
   * Bytes received on this stream before capture stopped. Equal to the full byte count
   * for a stream that never hit `maximumOutputBytes`. When the limit fires on this
   * stream, this is the total received up to and including the chunk that pushed it
   * over the limit (the runner stops reading further from that stream immediately
   * afterward - see G-05 in `process/runner.ts` `maybeEnforceLimit`) - i.e.
   * `stdoutBytes <= maximumOutputBytes + <one pipe chunk>`, bounded in practice by
   * Node's default pipe `highWaterMark` (64 KiB) on both Windows and POSIX.
   */
  stdoutBytes: number;
  /** Same semantics as `stdoutBytes`, for stderr. */
  stderrBytes: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<BoundedProcessResult>;
}
