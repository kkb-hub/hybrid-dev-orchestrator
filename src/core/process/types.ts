// Pure types for the process execution contract, ported from PowerShell's
// `Invoke-HdoProcess` / `BoundedProcessCapture` (Common.ps1). The interface lives in
// `core` so anything depending on "how do I run a process" can be written and tested
// against this contract without importing `node:child_process`. The implementation
// (`NodeProcessRunner`) lives in `src/process/runner.ts`, outside `core`.
//
// Field names and the exact key set/order of `ProcessResult` mirror the PowerShell
// `$result` ordered hashtable in `Invoke-HdoProcess` line for line (Common.ps1:818-846):
// command, arguments, exitCode, timedOut, outputLimitExceeded, outputLimitStream,
// outputDrainTimedOut, maximumOutputBytes, stdoutBytes, stderrBytes, stdoutPath,
// stderrPath, startedAt, endedAt, durationMs, stdout, stderr.

export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_MAXIMUM_OUTPUT_BYTES = 33554432;
export const DEFAULT_OUTPUT_TAIL_BYTES = 65536;
export const DEFAULT_OUTPUT_DRAIN_SECONDS = 2;
export const DEFAULT_PROGRESS_INTERVAL_SECONDS = 30;

export interface ProcessRunOptions {
  command: string;
  arguments?: string[];
  workingDirectory: string;
  /** Text written to stdin and then closed. Omit to close stdin immediately (mirrors an unbound `-InputText`). */
  inputText?: string;
  /** Seconds. Default `DEFAULT_TIMEOUT_SECONDS` (900), matching `-TimeoutSeconds` in `Invoke-HdoProcess`. */
  timeoutSeconds?: number;
  /**
   * When provided, the child receives EXACTLY these variables as far as this
   * contract is concerned. On Windows, libuv itself (not this code) additionally
   * injects a fixed list of variables into any child spawned with an explicit
   * `env`: HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP,
   * USERDOMAIN, USERNAME, USERPROFILE, WINDIR. There is no way to suppress this
   * from Node; callers on Windows should treat an explicit `environment` as "my
   * variables plus that fixed libuv list", not as a hard allow-list. POSIX has no
   * such injection: an explicit environment is exactly what the child sees. When
   * `environment` is omitted, the child inherits the current process environment
   * (matching PowerShell's default of not clearing `$env`).
   */
  environment?: Record<string, string>;
  standardOutputPath?: string;
  standardErrorPath?: string;
  /** Bytes. Default `DEFAULT_MAXIMUM_OUTPUT_BYTES` (32 MiB). */
  maximumOutputBytes?: number;
  /** Bytes. Default `DEFAULT_OUTPUT_TAIL_BYTES` (64 KiB). */
  outputTailBytes?: number;
  /** Seconds. Default `DEFAULT_OUTPUT_DRAIN_SECONDS` (2). */
  outputDrainSeconds?: number;
  /** Seconds. Default `DEFAULT_PROGRESS_INTERVAL_SECONDS` (30). 0 disables heartbeats entirely. */
  progressIntervalSeconds?: number;
  /**
   * Exceptions thrown by this callback (and any return value it produces) are
   * swallowed, mirroring `Invoke-HdoProgressAction`: progress is an observability
   * channel and a closed parent stream must not turn a still-running process into a
   * failed HDO run.
   */
  activityCallback?: (event: ProcessHeartbeatEvent) => unknown;
  /** When true and the resolved exit code is non-zero, `run()` throws instead of returning. */
  throwOnError?: boolean;
}

export interface ProcessResult {
  command: string;
  arguments: string[];
  exitCode: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  outputLimitStream: "" | "stdout" | "stderr";
  outputDrainTimedOut: boolean;
  maximumOutputBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** The caller-supplied `standardOutputPath`, or "" when omitted (mirrors an unbound PowerShell `-StandardOutputPath` string parameter). */
  stdoutPath: string;
  /** Same semantics as `stdoutPath`, for stderr. */
  stderrPath: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ProcessHeartbeatEvent {
  type: "process.heartbeat";
  at: string;
  startedAt: string;
  elapsedSeconds: number;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface ExitCodeInputs {
  timedOut: boolean;
  outputLimitExceeded: boolean;
  /** Non-empty iff writing `inputText` to stdin failed. */
  inputError: string;
  /** Non-empty iff spawning the process or capturing its output failed outright (including a drain timeout). */
  captureError: string;
  /** The process's own real exit code, or null when it never reported one (mirrors `process.HasExited ? ExitCode : -1`). */
  realExitCode: number | null;
}

/**
 * Pure implementation of the precedence chain PowerShell's `Invoke-HdoProcess`
 * applies (Common.ps1:816): `timedOut` (124) > `outputLimitExceeded` (125) >
 * `inputError` (126) > `captureError` (127) > the process's own real exit code (or
 * -1 if it never reported one). Each cause is evaluated independently - not a
 * "first cause wins" model - so, for example, a timeout that raced ahead of a stdin
 * EPIPE still yields 124 even when `inputError` is also non-empty, matching
 * `tests/fixtures/runtime/ignore-input.ps1`'s timeout scenario.
 */
export function resolveExitCode(input: ExitCodeInputs): number {
  if (input.timedOut) return 124;
  if (input.outputLimitExceeded) return 125;
  if (input.inputError !== "") return 126;
  if (input.captureError !== "") return 127;
  return input.realExitCode ?? -1;
}
