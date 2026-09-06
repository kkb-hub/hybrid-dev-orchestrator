// NodeProcessRunner: the Node.js equivalent of `Invoke-HdoProcess`/`BoundedProcessCapture`
// (Common.ps1). Spawns with an argv array (never `shell: true`), bounds stdout/stderr
// to `maximumOutputBytes` each, enforces a wall-clock timeout, contains the process
// tree via the platform's strongest available mechanism (a Windows Job Object, see
// `../platform/jobObject.ts`/docs/adr/0002-windows-job-object-via-koffi.md), bounds
// the post-exit output drain, and always redacts secrets out of the captured text
// before returning it.
//
// Environment: when `options.environment` is omitted, the child inherits
// `process.env` (matching `Invoke-HdoProcess`'s default of not clearing `$env`). When
// `options.environment` IS provided, the child gets exactly those variables as far as
// this runner is concerned - but on Windows, libuv itself (not this code) always
// injects a fixed list of variables into a child spawned with an explicit `env`: see
// `core/process/types.ts`'s `ProcessRunOptions.environment` doc comment. POSIX has no
// such injection.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buildCmdShimCommandLine, CMD_SHIM_EXTENSION_PATTERN } from "../core/process/cmdShim.ts";
import { protectObject, protectText } from "../core/process/redact.ts";
import {
  DEFAULT_MAXIMUM_OUTPUT_BYTES,
  DEFAULT_OUTPUT_DRAIN_SECONDS,
  DEFAULT_OUTPUT_TAIL_BYTES,
  DEFAULT_PROGRESS_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  resolveExitCode,
  type ProcessHeartbeatEvent,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from "../core/process/types.ts";
import type { PlatformAdapter, ProcessContainer } from "../platform/types.ts";

// H-05 (ported from the PoC): Node's own `err.message` for an errno error (e.g.
// "EEXIST: file already exists, mkdir 'x'") already starts with the error code, so
// naively prepending `${code}: ` again would produce "EEXIST: EEXIST: file already
// exists...". Strip that leading `${code}: ` from the raw message (if present) before
// re-adding it exactly once.
function errnoMessage(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  const rawMessage = err.message ?? String(error);
  const code = err.code;
  if (!code) return rawMessage;
  const duplicatedPrefix = `${code}: `;
  const message = rawMessage.startsWith(duplicatedPrefix) ? rawMessage.slice(duplicatedPrefix.length) : rawMessage;
  return `${code}: ${message}`;
}

/**
 * Bounded byte capture for a single stream. When `hasFile` is false, retains the FULL
 * accepted byte stream (up to `maximumBytes`) in memory, like PowerShell's
 * `MemoryStream` path in `PumpAsync`. When `hasFile` is true, retains only the last
 * `tailBytes` accepted bytes as a ring buffer (the full accepted stream is written to
 * the file by the caller instead).
 */
class StreamCapture {
  private readonly maximumBytes: number;
  private readonly hasFile: boolean;
  private readonly tail: Buffer;
  private tailStart = 0;
  private tailCount = 0;
  private readonly memoryChunks: Buffer[] = [];
  totalBytes = 0;
  limitExceeded = false;

  constructor(maximumBytes: number, tailBytes: number, hasFile: boolean) {
    this.maximumBytes = maximumBytes;
    this.hasFile = hasFile;
    this.tail = Buffer.alloc(Math.max(1, tailBytes));
  }

  /** Returns the prefix of `chunk` that was within the remaining budget (for bounding file writes). */
  append(chunk: Buffer): Buffer {
    const remaining = this.maximumBytes - this.totalBytes;
    const accepted = remaining <= 0 ? 0 : Math.min(chunk.length, remaining);
    const acceptedChunk = chunk.subarray(0, accepted);
    if (accepted > 0) {
      if (this.hasFile) {
        this.appendTail(acceptedChunk);
      } else {
        this.memoryChunks.push(Buffer.from(acceptedChunk));
      }
    }
    this.totalBytes += chunk.length;
    if (chunk.length > accepted) this.limitExceeded = true;
    return acceptedChunk;
  }

  private appendTail(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.tailCount < this.tail.length) {
        this.tail[(this.tailStart + this.tailCount) % this.tail.length] = byte;
        this.tailCount++;
      } else {
        this.tail[this.tailStart] = byte;
        this.tailStart = (this.tailStart + 1) % this.tail.length;
      }
    }
  }

  text(): string {
    if (this.hasFile) {
      const out = Buffer.alloc(this.tailCount);
      for (let i = 0; i < this.tailCount; i++) out[i] = this.tail[(this.tailStart + i) % this.tail.length];
      return out.toString("utf8");
    }
    return Buffer.concat(this.memoryChunks).toString("utf8");
  }
}

/**
 * N-4: mirrors PowerShell's `stdout.LimitExceeded ? "stdout" : (stderr.LimitExceeded
 * ? "stderr" : "")` (Common.ps1) exactly - stdout always takes priority over stderr
 * when BOTH streams have exceeded `maximumOutputBytes` by the time capture finishes,
 * regardless of which one's limit fired the kill first (the kill is asynchronous,
 * so the other stream can go on to exceed the limit too before it actually lands).
 * Exported and kept pure/side-effect-free so this priority rule can be tested
 * directly, without depending on the real timing of a spawned process.
 */
export function resolveOutputLimitStream(stdoutLimitExceeded: boolean, stderrLimitExceeded: boolean): "" | "stdout" | "stderr" {
  if (stdoutLimitExceeded) return "stdout";
  if (stderrLimitExceeded) return "stderr";
  return "";
}

/** N-5: throws a `RangeError` naming the option and its bounds, mirroring PowerShell's `[ValidateRange(min, max)]`. */
function validateRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max} (got ${value}).`);
  }
}

/** Resolves after `value` settles, or after `ms` elapses, whichever comes first - without leaking the timer handle either way. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise({ done: false });
      }
    }, ms);
    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ done: true, value });
      }
    });
  });
}

export interface NodeProcessRunnerOptions {
  platform: PlatformAdapter;
}

const NOOP_CONTAINER: ProcessContainer = {
  attached: false,
  error: "",
  terminate(): void {
    // No-op.
  },
  dispose(): void {
    // No-op.
  },
};

export class NodeProcessRunner implements ProcessRunner {
  private readonly platform: PlatformAdapter;

  constructor(options: NodeProcessRunnerOptions) {
    this.platform = options.platform;
  }

  async run(options: ProcessRunOptions): Promise<ProcessResult> {
    const command = options.command;
    // N-3: copy up front (PS's `@($Arguments)` does the same at parameter-binding
    // time) so a caller mutating the array it passed in - while this run is still in
    // flight, or after `run()` returns - can never change what was actually spawned
    // or what `ProcessResult.arguments` reports.
    const args = [...(options.arguments ?? [])];
    const workingDirectory = options.workingDirectory;
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    const outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
    const outputDrainSeconds = options.outputDrainSeconds ?? DEFAULT_OUTPUT_DRAIN_SECONDS;
    const progressIntervalSeconds = options.progressIntervalSeconds ?? DEFAULT_PROGRESS_INTERVAL_SECONDS;
    const standardOutputPath = options.standardOutputPath ?? "";
    const standardErrorPath = options.standardErrorPath ?? "";
    const startedAt = new Date();

    // N-5: mirrors PowerShell's `[ValidateRange(...)]` parameter attributes, which
    // reject an out-of-range value at parameter-binding time - before anything else
    // in the function runs. Checked here, first, for the same reason: the exact
    // "same-shape" bounds by option, matching the PowerShell `Invoke-HdoProcess`/
    // `BoundedProcessCapture` signature this runner ports.
    validateRange("timeoutSeconds", timeoutSeconds, 1, 86400);
    validateRange("maximumOutputBytes", maximumOutputBytes, 1024, 1073741824);
    validateRange("outputTailBytes", outputTailBytes, 1024, 1048576);
    validateRange("outputDrainSeconds", outputDrainSeconds, 1, 60);
    validateRange("progressIntervalSeconds", progressIntervalSeconds, 0, 3600);

    // Mirrors `Get-Command $Command -ErrorAction SilentlyContinue` + `throw` in
    // `Invoke-HdoProcess`: an unresolvable command throws, it is never represented as
    // a 127 result (unlike the frozen PoC - see ADR-0001 Rationale "Security" and the
    // module banner in `poc/typescript/src/process/runner.ts`).
    const resolvedCommand = this.platform.resolveExecutable(command);
    if (!resolvedCommand) throw new Error(`Command was not found: ${command}`);

    // F-06 (adapted): validate the working directory up front so an invalid one is a
    // "failed to start" throw with a clear message, rather than an opaque spawn-time
    // ENOENT. Divergence from PowerShell, documented in docs/architecture.md 16.4:
    // `Invoke-HdoProcess` throws a bare "Failed to start command: $Command" (no
    // detail) when `.Start()` returns false; this runner appends `. <detail>` since
    // Node surfaces a specific error message here that PowerShell's boolean
    // `Process.Start()` return value does not.
    let workingDirectoryOk = false;
    try {
      workingDirectoryOk = statSync(workingDirectory).isDirectory();
    } catch {
      workingDirectoryOk = false;
    }
    if (!workingDirectoryOk) {
      throw new Error(
        `Failed to start command: ${command}. ENOENT: working directory does not exist or is not a directory: ${workingDirectory}`,
      );
    }

    // WP-D (ADR-0001 phase 5): a resolved `.cmd`/`.bat` shim (e.g. an npm-global
    // `claude.cmd`) cannot be `spawn()`-ed directly - Node throws EINVAL
    // synchronously for that (CVE-2024-27980) unless `shell: true` is set, and this
    // runner never sets `shell: true`. Instead, `cmd.exe` itself is spawned with a
    // single validated command-line string built by `buildCmdShimCommandLine` (see
    // src/core/process/cmdShim.ts for the full quoting/escaping/rejection rules).
    // `windowsVerbatimArguments: true` stops Node from re-quoting `spawnArgs` itself,
    // since `line` inside the fourth element is already the exact text cmd.exe must
    // see. `ProcessResult.command`/`.arguments` below still report the CALLER's
    // `command`/`args` (unchanged), never `spawnFile`/`spawnArgs` - mirroring
    // PowerShell, which reports `$Command`/`$Arguments`, not cmd.exe's own view.
    //
    // Gated on `process.platform === "win32"`: off Windows `resolveExecutable` never
    // resolves a `.cmd`/`.bat` shim at all (see src/platform/posix.ts), but a
    // caller-qualified path with that extension could still reach here - it must be
    // spawned directly like any other executable, never routed through a `cmd.exe`
    // this host does not have.
    const isCmdShim = process.platform === "win32" && CMD_SHIM_EXTENSION_PATTERN.test(resolvedCommand);
    let spawnFile = resolvedCommand;
    let spawnArgs = args;
    if (isCmdShim) {
      const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
      // `||`, not `??`: COMSPEC set but empty must fall back to the SystemRoot
      // default too, not resolve to an empty spawn target.
      spawnFile = process.env.COMSPEC || join(systemRoot, "System32", "cmd.exe");
      // S-3 (nit 5, review round 2): PowerShell's `Process.Start` (which
      // `CreateProcess` uses internally) consults COMSPEC itself and throws
      // immediately when it does not point at a real, absolute cmd.exe file;
      // without this check, Node's async spawn 'error' event would instead surface
      // as a misleading 127 result ("Failed to capture process output: ENOENT:
      // spawn ... ENOENT") well after this function had already committed to the
      // shim path - checked here so a missing/invalid COMSPEC is a clear "failed to
      // start" throw instead, matching the existing contract for every other
      // pre-spawn failure in this function. A RELATIVE COMSPEC is rejected outright
      // (rather than silently resolved against `process.cwd()`, which `statSync`
      // would otherwise do) - this runner does not attempt to reproduce
      // `CreateProcess`'s own relative-path search rules, only to fail clearly
      // instead of depending on an ambient cwd. `statSync(...).isFile()` (not
      // `existsSync`) so a COMSPEC pointing at a DIRECTORY is rejected here too,
      // instead of reaching spawn() and failing with a misleading ENOENT-shaped
      // result (measured: `COMSPEC=C:\Windows\System32` -> `exitCode: 127, stderr:
      // "Failed to capture process output: ENOENT: spawn C:\Windows\System32
      // ENOENT"`).
      if (!isAbsolute(spawnFile)) {
        throw new Error(`Failed to start command: ${command}. COMSPEC must be an absolute path to cmd.exe, got '${spawnFile}'.`);
      }
      let spawnFileIsFile: boolean;
      try {
        spawnFileIsFile = statSync(spawnFile).isFile();
      } catch {
        spawnFileIsFile = false;
      }
      if (!spawnFileIsFile) {
        throw new Error(`Failed to start command: ${command}. cmd.exe was not found at '${spawnFile}' (COMSPEC)`);
      }
      // review round 2 should-fix 2: the 8191-character check inside
      // `buildCmdShimCommandLine` must measure the REAL command line `CreateProcess`
      // receives - `<spawnFile> /d /s /v:off /c "<line>"` - not a placeholder
      // `cmd.exe` literal, so the exact fixed text between the resolved `spawnFile`
      // and this function's own `line` is passed here. Node's `spawn()` with
      // `windowsVerbatimArguments: true` does not quote `spawnFile` itself (or any
      // other argument), so no surrounding quotes are added around it here -
      // matching the value measured empirically: a real spawn's total command line
      // works up to exactly 8191 characters and fails at 8192.
      let line: string;
      try {
        line = buildCmdShimCommandLine(resolvedCommand, args, { commandLinePrefix: `${spawnFile} /d /s /v:off /c "` });
      } catch (error) {
        throw new Error(`Failed to start command: ${command}. ${(error as Error).message}`);
      }
      // /v:off (finding 5): disables delayed environment-variable expansion
      // regardless of the `HKCU/HKLM\Software\Microsoft\Command Processor\
      // DelayedExpansion` registry default - without it, a whitespace-quoted
      // argument like `"a b!PATH!"` (accepted by buildCmdShimCommandLine today)
      // would have `!PATH!` expanded even inside real quotes whenever that registry
      // value is set to enable delayed expansion machine-wide.
      spawnArgs = ["/d", "/s", "/v:off", "/c", `"${line}"`];
    }

    let child: ChildProcess;
    try {
      child = spawn(spawnFile, spawnArgs, {
        cwd: workingDirectory,
        env: options.environment ? { ...options.environment } : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform.spawnDetached,
        windowsHide: true,
        windowsVerbatimArguments: isCmdShim,
      });
    } catch (error) {
      throw new Error(`Failed to start command: ${command}. ${errnoMessage(error)}`);
    }

    // Attach `close` synchronously, right after spawn, with no `await` in between -
    // Node can emit `close` synchronously right after `exit` when the pipes have
    // already ended (e.g. a child that produced no output and exited instantly), and
    // a listener attached later would miss it.
    let closeSeen = false;
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolvePromise) => {
      closeResolve = resolvePromise;
    });
    child.on("close", () => {
      closeSeen = true;
      closeResolve?.();
    });

    // Single unified "the process is done" signal, resolved by whichever of
    // 'exit'/'error' fires first (an 'error' here means the process could not run at
    // all after all - rare, given the resolveExecutable/cwd checks above - and is
    // reported with a null exit code, matching `process.HasExited ? ExitCode : -1`
    // when nothing else claims a real exit code).
    let exitResolve: ((code: number | null) => void) | undefined;
    const exitPromise = new Promise<number | null>((resolvePromise) => {
      exitResolve = resolvePromise;
    });
    let hasExited = false;
    let realExitCode: number | null = null;
    exitPromise.then((code) => {
      hasExited = true;
      realExitCode = code;
    });
    // S-3: set SYNCHRONOUSLY inside the event handlers themselves (not via the
    // `exitPromise.then` microtask above, which could still be pending when a
    // same-tick caller - e.g. a 'data' handler's `maybeEnforceLimit` - calls
    // `killTree()`), mirroring PowerShell's `KillTree`'s own
    // `if (!process.HasExited)` check: once the child has genuinely exited,
    // `killTree()` must never fire `taskkill /T /F /PID <pid>` again, since Windows
    // can reuse that PID for an unrelated process in the meantime.
    let exited = false;
    child.once("exit", (code) => {
      exited = true;
      exitResolve?.(code);
    });
    child.once("error", () => {
      exited = true;
      exitResolve?.(null);
    });

    // Immediately after spawn: attempt to place the child under this platform's
    // strongest containment mechanism (Windows Job Object via koffi). Mirrors
    // `KillOnCloseJob.TryAttach` running at the very start of `CaptureAsync`, before
    // any output pump/capture-file work begins.
    const container: ProcessContainer =
      typeof child.pid === "number" ? await this.platform.createProcessContainer(child.pid) : NOOP_CONTAINER;

    let timedOut = false;
    let outputLimitExceeded = false;
    let inputErrorMessage = "";
    // Raw capture-failure text (spawn/file errors only - NOT yet the
    // process-exit-timeout/drain-timeout overrides, which are applied at the very
    // end so their priority matches PowerShell's if/else-if chain exactly).
    let earlyCaptureError = "";

    let triggerFired = false;
    let triggerResolve: (() => void) | undefined;
    const triggerPromise = new Promise<void>((resolvePromise) => {
      triggerResolve = resolvePromise;
    });
    const fireTrigger = (): void => {
      if (triggerFired) return;
      triggerFired = true;
      triggerResolve?.();
    };

    // Kill tree = the job's TerminateJobObject when attached, else the platform's PID
    // -tree fallback (taskkill /T /F on Windows, process group SIGKILL on POSIX).
    // Mirrors "Kill tree = container.terminate() when attached else
    // platform.killProcessTree(pid)". S-3: a no-op once the child has already
    // exited, mirroring PS `KillTree`'s `if (!process.HasExited) process.Kill(true);`
    // - without this, a `taskkill /T /F /PID <pid>` fired after exit could hit an
    // unrelated process that reused the same PID.
    const killTree = async (): Promise<void> => {
      if (exited) return;
      if (container.attached) {
        container.terminate();
        return;
      }
      if (typeof child.pid === "number") await this.platform.killProcessTree(child.pid);
    };

    // Order of operations mirrors PowerShell: spawn (done above) then open capture
    // files. A file open/mkdir failure here is a capture error - the process is
    // already running by this point, so it must be killed just like any other
    // terminating cause.
    // NB-2: the 'error' listener must be attached to each sink SYNCHRONOUSLY, in the
    // same tick the sink is created - the real `fs.WriteStream` opens its file
    // asynchronously and emits 'error' (e.g. EISDIR when the path is a directory) on
    // a later tick. If that tick falls inside the `await` that opens the OTHER capture
    // file (its `mkdir` round-trip), an 'error' with no listener is an uncaught
    // exception that takes the whole host down instead of a 127 result.
    const attachSinkError = (sink: CaptureSink, streamName: "stdout" | "stderr"): void => {
      sink.on("error", (error) => {
        if (!earlyCaptureError) {
          earlyCaptureError = `${streamName}: ${errnoMessage(error)}`;
          fireTrigger();
          void killTree();
        }
      });
    };
    let stdoutFile: CaptureSink | undefined;
    let stderrFile: CaptureSink | undefined;
    if (standardOutputPath) {
      try {
        stdoutFile = await this.openWriteStream(standardOutputPath);
        attachSinkError(stdoutFile, "stdout");
      } catch (error) {
        earlyCaptureError = `stdout: ${errnoMessage(error)}`;
      }
    }
    if (!earlyCaptureError && standardErrorPath) {
      try {
        stderrFile = await this.openWriteStream(standardErrorPath);
        attachSinkError(stderrFile, "stderr");
      } catch (error) {
        earlyCaptureError = `stderr: ${errnoMessage(error)}`;
      }
    }
    if (earlyCaptureError) {
      fireTrigger();
      void killTree();
    }

    const stdoutCapture = new StreamCapture(maximumOutputBytes, outputTailBytes, Boolean(standardOutputPath));
    const stderrCapture = new StreamCapture(maximumOutputBytes, outputTailBytes, Boolean(standardErrorPath));

    // G-05 (ported from the PoC): once the limit fires, stop reading from the
    // OFFENDING stream only, by destroying that Readable - closing this end of the
    // pipe so the child's next write to that fd fails, rather than continuing to
    // read-and-discard megabytes per second until the async tree-kill lands.
    //
    // N-4: this only sets the BOOLEAN (used to trigger the kill on whichever stream
    // exceeds first, and to compute exitCode 125). Which stream NAME is reported is
    // computed once at the very end, from the streams' final `limitExceeded` state -
    // mirrors PowerShell's `stdout.LimitExceeded ? "stdout" : (stderr.LimitExceeded ?
    // "stderr" : "")`, which always prefers stdout over stderr regardless of which
    // one actually fired the kill first (both can end up exceeded once the
    // asynchronous tree-kill is in flight).
    const maybeEnforceLimit = (capture: StreamCapture, streamName: "stdout" | "stderr"): void => {
      if (!outputLimitExceeded && capture.limitExceeded) {
        outputLimitExceeded = true;
        if (streamName === "stdout") child.stdout?.destroy();
        else child.stderr?.destroy();
        fireTrigger();
        void killTree();
      }
    };

    // S-4: honour `write()`'s return value for backpressure (mirrors PS's
    // `await WriteAsync(...)`, which does not return until the OS accepts the
    // bytes) - without this, an arbitrarily large amount of output can accumulate in
    // the WriteStream's internal buffer (bounded only by `maximumOutputBytes`, i.e.
    // up to 32 MiB by default) whenever the destination disk/device is slower than
    // the child produces output. `pause()`/`resume()` operate on the SAME stream
    // `write()` was just called for, so a slow stdout file never throttles stderr
    // (and vice versa).
    child.stdout?.on("data", (chunk: Buffer) => {
      const accepted = stdoutCapture.append(chunk);
      if (stdoutFile && accepted.length > 0) {
        if (!stdoutFile.write(accepted)) child.stdout?.pause();
      }
      maybeEnforceLimit(stdoutCapture, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const accepted = stderrCapture.append(chunk);
      if (stderrFile && accepted.length > 0) {
        if (!stderrFile.write(accepted)) child.stderr?.pause();
      }
      maybeEnforceLimit(stderrCapture, "stderr");
    });
    stdoutFile?.on("drain", () => child.stdout?.resume());
    stderrFile?.on("drain", () => child.stderr?.resume());

    // A spawn-time-adjacent failure that only surfaces asynchronously (the child
    // could not actually run after all, despite passing the checks above).
    child.on("error", (error) => {
      if (!earlyCaptureError) {
        earlyCaptureError = errnoMessage(error);
        fireTrigger();
        void killTree();
      }
    });

    // F-01 (ported from the PoC): writing to stdin can fail (EPIPE/EOF) whenever the
    // child exits before consuming all of `inputText`. This is recorded independently
    // of any other trigger - even one that already fired (e.g. a timeout) - matching
    // PowerShell's `WaitForInputErrorAsync`, which keeps observing the input task in
    // the background regardless of which task first won the race.
    child.stdin?.on("error", (error) => {
      if (!inputErrorMessage) {
        inputErrorMessage = errnoMessage(error);
        fireTrigger();
        void killTree();
      }
    });
    if (options.inputText !== undefined) {
      child.stdin?.write(options.inputText, "utf8", (error) => {
        if (error && !inputErrorMessage) {
          inputErrorMessage = errnoMessage(error);
          fireTrigger();
          void killTree();
        }
      });
    }
    child.stdin?.end();

    let heartbeatTimer: NodeJS.Timeout | undefined;
    if (options.activityCallback && progressIntervalSeconds > 0) {
      heartbeatTimer = setInterval(() => {
        const now = new Date();
        const event: ProcessHeartbeatEvent = {
          type: "process.heartbeat",
          at: now.toISOString(),
          startedAt: startedAt.toISOString(),
          elapsedSeconds: Math.floor((now.getTime() - startedAt.getTime()) / 1000),
        };
        try {
          // Mirrors Invoke-HdoProgressAction: the callback's return value (and any
          // exception it throws) is ignored - progress is an observability channel,
          // a closed parent stream must not turn a still-producing process into a
          // failed HDO run.
          options.activityCallback?.(protectObject(event) as ProcessHeartbeatEvent);
        } catch {
          // swallow
        }
      }, progressIntervalSeconds * 1000);
      heartbeatTimer.unref();
    }

    const timeoutTimer = setTimeout(
      () => {
        if (!timedOut) {
          timedOut = true;
          fireTrigger();
          void killTree();
        }
      },
      Math.max(1, timeoutSeconds) * 1000,
    );

    // Primary wait: either the process exits on its own (no trigger ever fires), or
    // some trigger (limit/input-error/capture-error/timeout) fires first and we must
    // then separately confirm the process actually goes away.
    await Promise.race([exitPromise, triggerPromise]);
    clearTimeout(timeoutTimer);

    let processExitTimedOut = false;
    if (!hasExited) {
      // S-2: mirrors PowerShell's two-stage wait exactly - `processExitTimedOut` is
      // set as soon as the FIRST 5s wait fails, unconditionally, regardless of
      // whether the second (post-re-kill) 2s wait subsequently succeeds. PS's
      // `CaptureAsync` never un-sets it: `processExitTimedOut = true; KillTree(...);
      // await WaitWithinAsync(exitTask, 2s);` with no branching on that second wait's
      // result.
      const firstWait = await raceWithTimeout(exitPromise, 5000);
      if (!firstWait.done) {
        processExitTimedOut = true;
        // N-6: a child that survives even the tree-kill (e.g. it is itself
        // ignoring/blocking termination) must never keep this host process alive on
        // its own - `run()` is about to give up waiting for it either way.
        child.unref();
        await killTree();
        await raceWithTimeout(exitPromise, 2000);
      }
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // A child may inherit redirected handles and outlive the parent. Disposing the
    // container here (closing the Windows Job Object) terminates every remaining
    // descendant still assigned to it before the stream drain below.
    container.dispose();

    let outputDrainTimedOut = false;
    if (typeof child.pid === "number" && !closeSeen) {
      const drainResult = await raceWithTimeout(closePromise, Math.max(1, outputDrainSeconds) * 1000);
      if (!drainResult.done && !closeSeen) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        outputDrainTimedOut = true;
      }
    }

    await Promise.all([this.closeWriteStream(stdoutFile), this.closeWriteStream(stderrFile)]);

    // Priority chain matching PowerShell's `CaptureAsync` (Common.ps1:373-377):
    // processExitTimedOut > outputDrainTimedOut > the original spawn/file error.
    let captureErrorMessage = earlyCaptureError;
    if (processExitTimedOut) {
      captureErrorMessage = "process did not exit after termination was requested.";
    } else if (outputDrainTimedOut) {
      const suffix = container.error ? ` Process-tree containment was unavailable: ${container.error}` : "";
      captureErrorMessage = `stdout/stderr remained open after the process exited; output capture was cancelled after the drain timeout.${suffix}`;
    }

    const exitCode = resolveExitCode({
      timedOut,
      outputLimitExceeded,
      inputError: inputErrorMessage,
      captureError: captureErrorMessage,
      realExitCode: hasExited ? realExitCode : null,
    });

    // N-4: computed once, here, from each stream's FINAL `limitExceeded` state, not
    // from whichever stream's `maybeEnforceLimit` call happened to fire the kill
    // first (both can end up exceeded once the asynchronous tree-kill is in flight -
    // see `resolveOutputLimitStream`'s doc comment).
    const outputLimitStream = resolveOutputLimitStream(stdoutCapture.limitExceeded, stderrCapture.limitExceeded);

    let stderr = protectText(stderrCapture.text());
    // Cascading overrides, each unconditionally overwriting the previous - matching
    // `Invoke-HdoProcess`'s three sequential `if` statements (Common.ps1:837-841),
    // never an "else if" chain.
    if (inputErrorMessage) stderr = protectText(`Failed to write process input: ${inputErrorMessage}`);
    if (captureErrorMessage) stderr = protectText(`Failed to capture process output: ${captureErrorMessage}`);
    if (outputLimitExceeded) {
      stderr = protectText(`Process ${outputLimitStream} exceeded the HDO output limit of ${maximumOutputBytes} bytes.`);
    }
    const stdout = protectText(stdoutCapture.text());

    const endedAt = new Date();
    const result: ProcessResult = {
      command,
      arguments: args,
      exitCode,
      timedOut,
      outputLimitExceeded,
      outputLimitStream,
      outputDrainTimedOut,
      maximumOutputBytes,
      stdoutBytes: stdoutCapture.totalBytes,
      stderrBytes: stderrCapture.totalBytes,
      stdoutPath: standardOutputPath,
      stderrPath: standardErrorPath,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      stdout,
      stderr,
    };

    if (options.throwOnError && exitCode !== 0) {
      // N-2: mirrors PowerShell's `if ($result.stderr) { stderr.Trim() } else {
      // stdout.Trim() }` - falls back to stdout only when stderr is EMPTY, not
      // merely whitespace-only (a whitespace-only stderr is still truthy in both PS
      // and JS, so it must trim to "" rather than being discarded in favor of
      // stdout).
      const detail = result.stderr ? result.stderr.trim() : result.stdout.trim();
      throw new Error(`Command '${command}' failed with exit code ${exitCode}. ${detail}`);
    }

    return result;
  }

  private async openWriteStream(path: string): Promise<CaptureSink> {
    await mkdir(dirname(path), { recursive: true });
    return createCaptureWriteStream(path);
  }

  private async closeWriteStream(stream?: CaptureSink): Promise<void> {
    if (!stream) return;
    if (stream.destroyed) return;
    // `end(callback)` resolves on 'finish' (all data handed to the OS), but a real
    // `fs.WriteStream` only releases its file descriptor afterwards, on 'close'
    // (autoDestroy). On Windows an open descriptor makes a subsequent rename over
    // the capture file fail with EPERM (seen in CI: `protectLogFile(stdout.log)`
    // immediately after `run()` resolved), so also wait for 'close' when the sink
    // exposes it. Fake sinks in tests may omit `once`/`closed`; they are then treated
    // as closed once 'finish' fired, exactly as before.
    await new Promise<void>((resolvePromise) => stream.end(() => resolvePromise()));
    if (stream.closed === true || typeof stream.once !== "function") return;
    await new Promise<void>((resolvePromise) => {
      if (stream.closed === true) {
        resolvePromise();
        return;
      }
      stream.once?.("close", () => resolvePromise());
    });
  }
}

// S-4: the narrow surface `NodeProcessRunner` actually needs from a capture
// destination - satisfied structurally by the real `fs.WriteStream` `createWriteStream`
// returns, and small enough for a test to implement a fake, slow-consumer sink (e.g.
// one whose `write()` always returns `false` and never emits `drain` on its own) to
// verify `run()` honours backpressure (pauses/resumes the child's Readable) rather
// than buffering an unbounded amount of output in the sink's internal queue.
export interface CaptureSink {
  write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean;
  on(event: "error" | "drain", listener: (error?: Error) => void): CaptureSink;
  end(callback: () => void): CaptureSink;
  readonly destroyed: boolean;
  /** Optional (present on a real `fs.WriteStream`): true once the file descriptor
   * has been released. `closeWriteStream` waits for 'close' when this is false. */
  readonly closed?: boolean;
  once?(event: "close", listener: () => void): CaptureSink;
}

// Test-only injection point (mirrors `jobObject.ts`'s `__setKoffiImporterForTests`):
// overridable so a test can supply a fake, deliberately slow `CaptureSink` without
// touching the real filesystem. Returns a restore function.
let createCaptureWriteStream: (path: string) => CaptureSink = (path) => createWriteStream(path);

export function __setCreateCaptureWriteStreamForTests(factory: (path: string) => CaptureSink): () => void {
  const previous = createCaptureWriteStream;
  createCaptureWriteStream = factory;
  return () => {
    createCaptureWriteStream = previous;
  };
}
