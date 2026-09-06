import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { loadSchemaRegistry } from "../cli/schemaLoader.ts";
import { buildCmdShimCommandLine } from "../core/process/cmdShim.ts";
import { toClaudeTransportSchemaJson } from "../core/runners/claudeSchema.ts";
import { getPlatform } from "../platform/index.ts";
import type { PlatformAdapter, ProcessContainer } from "../platform/types.ts";
import { __setCreateCaptureWriteStreamForTests, NodeProcessRunner, resolveOutputLimitStream } from "./runner.ts";
import type { CaptureSink } from "./runner.ts";

const platform = getPlatform();
const IS_WINDOWS = process.platform === "win32";

function killByPid(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// S-8: `output.includes(String(pid))` (the previous implementation) false-positives
// whenever the target PID's digits happen to appear elsewhere in the row (e.g. a
// memory-usage column like "12,345 K", or another process's own PID) - CSV output
// with the header suppressed is parsed field-by-field instead, matching exactly what
// `tasklist /FI "PID eq N"` was asked to filter for.
function isProcessAlive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
      return output.split(/\r?\n/).some((line) => {
        if (!line.startsWith('"')) return false;
        const pidField = line.split('","')[1]?.replace(/"/g, "");
        return pidField === String(pid);
      });
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return predicate();
}

test("propagates exit code, captures stdout/stderr separately, and round-trips UTF-8 stdin", async () => {
  const script = `
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const input = Buffer.concat(chunks).toString('utf8');
      process.stdout.write('stdout:' + input);
      process.stderr.write('stderr-marker');
      process.exitCode = 7;
    });
  `;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    inputText: "héllo 世界\n",
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "stdout:héllo 世界\n");
  assert.equal(result.stderr, "stderr-marker");
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(result.stdoutPath, "");
  assert.equal(result.stderrPath, "");
});

test("ProcessResult exposes exactly the PowerShell key set, in order", async () => {
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.exit(0);"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.deepEqual(Object.keys(result), [
    "command",
    "arguments",
    "exitCode",
    "timedOut",
    "outputLimitExceeded",
    "outputLimitStream",
    "outputDrainTimedOut",
    "maximumOutputBytes",
    "stdoutBytes",
    "stderrBytes",
    "stdoutPath",
    "stderrPath",
    "startedAt",
    "endedAt",
    "durationMs",
    "stdout",
    "stderr",
  ]);
});

test("enforces bounded stdout in-memory and retains only a diagnostic tail once truncated when no file path is given", async () => {
  const totalBytes = 5 * 1024 * 1024;
  const limitBytes = 1 * 1024 * 1024;
  const tailBytes = 8 * 1024;
  const script = `process.stdout.write(Buffer.alloc(${totalBytes}, 65));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 20,
    maximumOutputBytes: limitBytes,
    outputTailBytes: tailBytes,
  });
  assert.equal(result.exitCode, 125);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.outputLimitStream, "stdout");
  assert.match(result.stderr, /Process stdout exceeded the HDO output limit of \d+ bytes\./);
  assert.ok(
    result.stdout.length <= limitBytes,
    `without a file path, the in-memory stdout should be bounded to the limit, got ${result.stdout.length} chars`,
  );
  assert.ok(
    result.stdoutBytes <= limitBytes + 65536 * 2,
    `expected stdoutBytes (${result.stdoutBytes}) to be bounded to maximumOutputBytes (${limitBytes}) plus a small pipe-chunk slack`,
  );
});

test("full text is retained in memory (not just a tail) when no file path is given and the limit is not hit", async () => {
  const totalBytes = 200_000;
  // Generated INSIDE the child script (not embedded as a huge argv literal) to stay
  // well under the OS command-line length limit.
  const script = `process.stdout.write('x'.repeat(${totalBytes}));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    outputTailBytes: 1024, // deliberately smaller than the full text - must not truncate when no file is given
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "x".repeat(totalBytes));
});

test("with a file path, the in-memory result is only the tail while the file holds the full bounded output", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-tailfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "stdout.log");

  const totalBytes = 200_000;
  const tailBytes = 4096;
  const script = `process.stdout.write('y'.repeat(${totalBytes}));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    outputTailBytes: tailBytes,
    standardOutputPath: stdoutPath,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, tailBytes);
  assert.equal(result.stdout, "y".repeat(tailBytes));
  assert.equal(result.stdoutPath, stdoutPath);
  const fileContents = statSync(stdoutPath);
  assert.equal(fileContents.size, totalBytes);
});

test("explicit environment replaces the inherited environment (allow-list only)", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "should-not-leak";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });

  const script = `process.stdout.write(JSON.stringify(process.env));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    environment: { MARKER: "yes" },
  });
  const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;
  assert.equal(childEnv.MARKER, "yes");
  assert.equal(childEnv.GH_TOKEN, undefined);
});

test("timeout terminates the whole process tree: exit code 124 and the grandchild is dead afterwards", async () => {
  const grandchildScript = "process.stdout.write('grandchild-alive:' + process.pid + '\\n'); setTimeout(() => {}, 60000);";
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });
    process.stdout.write('grandchild-pid:' + child.pid + '\\n');
    setTimeout(() => {}, 60000);
  `;
  const runner = new NodeProcessRunner({ platform });
  const startedAt = Date.now();
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", parentScript],
    workingDirectory: process.cwd(),
    timeoutSeconds: 2,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 8000, `expected the runner to return within ~8s of a 2s timeout, took ${elapsedMs}ms`);

  const match = result.stdout.match(/grandchild-pid:(\d+)/);
  assert.ok(match, `expected to find the grandchild pid in captured stdout, got: ${JSON.stringify(result.stdout)}`);
  const grandchildPid = Number(match[1]);

  const died = await pollUntil(() => !isProcessAlive(grandchildPid), 5000, 200);
  assert.ok(died, `expected grandchild pid ${grandchildPid} to be dead after process-tree termination`);
});

test("stdin write failure (child exits immediately) is reported as 126, not a host crash", async () => {
  const script = "process.exit(3);";
  const bigInput = "x".repeat(8 * 1024 * 1024); // 8 MiB: comfortably larger than an OS pipe buffer
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    inputText: bigInput,
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /Failed to write process input:/);
  // Reaching this assertion at all proves the host process (running this test) is
  // still alive - an uncaught EPIPE/EOF in the runner would have crashed it instead.
});

test("bounded output drain: a surviving detached grandchild does not block the result", async (t) => {
  const grandchildScript = "process.stdout.write('grandchild-pid:' + process.pid + '\\n'); setTimeout(() => {}, 15000);";
  // The parent deliberately waits ~800ms before exiting - long enough for the
  // grandchild to actually get scheduled and flush its startup line through the
  // inherited (shared) stdout pipe before the parent (and, on Windows, this
  // container's dispose()) goes away. Without this delay the parent can win a race
  // against the grandchild's very first write, especially now that Job Object
  // containment can terminate the grandchild almost instantly once the direct child
  // exits.
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: true });
    child.unref();
    setTimeout(() => { process.exit(0); }, 800);
  `;
  const runner = new NodeProcessRunner({ platform });
  const startedAt = Date.now();
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", parentScript],
    workingDirectory: process.cwd(),
    timeoutSeconds: 30,
    outputDrainSeconds: 2,
  });
  const elapsedMs = Date.now() - startedAt;

  const match = result.stdout.match(/grandchild-pid:(\d+)/);
  const grandchildPid = match ? Number(match[1]) : undefined;
  t.after(() => {
    if (grandchildPid !== undefined) killByPid(grandchildPid);
  });

  assert.ok(grandchildPid !== undefined, `expected to find the grandchild pid in captured stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.timedOut, false, "this must resolve via the bounded drain, not the 30s timeout");
  // S-7: this grandchild IS spawned with `detached: true` (line 270 above) - fixed
  // from an earlier version of this comment that claimed otherwise. On Windows,
  // `detached` only affects process-group/Ctrl+C creation flags; it does not opt a
  // child out of the Job Object its parent already belongs to (that requires the
  // child to explicitly break away, which nothing here does), so this machine's
  // Windows Job Object attach still assigns the grandchild to HDO's job (see
  // docs/adr/0002-windows-job-object-via-koffi.md) and `container.dispose()` should
  // kill it before the drain timeout is ever reached.
  if (process.platform === "win32") {
    assert.equal(result.outputDrainTimedOut, false);
    assert.equal(result.exitCode, 0);
  }
  assert.ok(elapsedMs < 10000, `expected the bounded drain to resolve well within the 30s timeout, took ${elapsedMs}ms`);
});

test("running a nonexistent command throws Command was not found (not a 127 result)", async () => {
  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: "hdo-runner-definitely-does-not-exist-anywhere",
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
      }),
    /^Error: Command was not found: hdo-runner-definitely-does-not-exist-anywhere$/,
  );
});

test("nonexistent working directory throws Failed to start command", async () => {
  const runner = new NodeProcessRunner({ platform });
  const bogusCwd = join(tmpdir(), "hdo-runner-definitely-does-not-exist", "deeper");
  assert.equal(existsSync(bogusCwd), false);
  await assert.rejects(
    () =>
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.exit(0);"],
        workingDirectory: bogusCwd,
        timeoutSeconds: 10,
      }),
    /^Error: Failed to start command: /,
  );
});

test("standardOutputPath pointing at an existing directory is reported as 127, host stays alive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-stdoutpath-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "is-a-directory");
  mkdirSync(stdoutPath);

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.stdout.write('hello');"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    standardOutputPath: stdoutPath,
  });
  assert.equal(result.exitCode, 127);
  assert.match(result.stderr, /^Failed to capture process output: stdout: /);
  assert.ok(statSync(stdoutPath).isDirectory(), "the path must still be the directory it was, untouched");
});

test("NB-2: standardOutputPath pointing at a directory while standardErrorPath is ALSO given is a 127 result, not an uncaught 'error' (the stdout sink's EISDIR fires during the stderr file's open)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-bothpaths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "is-a-directory");
  mkdirSync(stdoutPath);
  const stderrPath = join(dir, "nested", "deeper", "stderr.log");

  // An unhandled 'error' event would surface as an uncaughtException that kills the
  // test process; guard it so the failure is reported as an assertion instead.
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  t.after(() => process.off("uncaughtException", onUncaught));

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.stdout.write('hello'); process.stderr.write('world');"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    standardOutputPath: stdoutPath,
    standardErrorPath: stderrPath,
  });
  assert.deepEqual(uncaught, [], "the stdout sink 'error' must be handled, never uncaught");
  assert.equal(result.exitCode, 127);
  assert.match(result.stderr, /^Failed to capture process output: stdout: /);
  assert.ok(statSync(stdoutPath).isDirectory(), "the path must still be the directory it was, untouched");
});

test("standardOutputPath whose parent directory cannot be created (ancestor is a file) is reported as 127, run() does not reject", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-mkdirfail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ancestorFile = join(dir, "existing-file");
  writeFileSync(ancestorFile, "not a directory\n", "utf8");
  const stdoutPath = join(ancestorFile, "out.log");

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.stdout.write('hello');"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    standardOutputPath: stdoutPath,
  });
  assert.equal(result.exitCode, 127);
  assert.match(result.stderr, /^Failed to capture process output: stdout: /);
});

test("file output is bounded to maximumOutputBytes, not the full received chunk", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-boundedfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "stdout.log");

  const totalBytes = 4 * 1024 * 1024;
  const limitBytes = 1 * 1024 * 1024;
  const script = `process.stdout.write(Buffer.alloc(${totalBytes}, 65));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 20,
    maximumOutputBytes: limitBytes,
    standardOutputPath: stdoutPath,
  });
  assert.equal(result.exitCode, 125);
  const fileSize = statSync(stdoutPath).size;
  assert.ok(fileSize <= limitBytes, `expected the capture file to be bounded to ${limitBytes} bytes, got ${fileSize}`);
  assert.ok(fileSize > 0);
});

test("heartbeat: activityCallback receives process.heartbeat events without command/arguments/inputText, and a throwing callback does not affect the result", async () => {
  const events: unknown[] = [];
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "setTimeout(() => { process.stdout.write('done'); }, 1500);"],
    workingDirectory: process.cwd(),
    inputText: "should-not-leak-into-heartbeat",
    timeoutSeconds: 10,
    progressIntervalSeconds: 1,
    activityCallback: (event) => {
      events.push(event);
      throw new Error("simulated closed progress stream");
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "done");
  assert.ok(events.length >= 1, `expected at least one heartbeat event, got ${events.length}`);
  const first = events[0] as Record<string, unknown>;
  assert.equal(first.type, "process.heartbeat");
  assert.ok(typeof first.at === "string");
  assert.ok(typeof first.startedAt === "string");
  assert.ok(typeof first.elapsedSeconds === "number" && first.elapsedSeconds >= 0);
  assert.deepEqual(Object.keys(first).sort(), ["at", "elapsedSeconds", "startedAt", "type"]);
});

test("progressIntervalSeconds 0 disables heartbeats entirely", async () => {
  const events: unknown[] = [];
  const runner = new NodeProcessRunner({ platform });
  await runner.run({
    command: process.execPath,
    arguments: ["-e", "setTimeout(() => { process.exit(0); }, 500);"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    progressIntervalSeconds: 0,
    activityCallback: (event) => events.push(event),
  });
  assert.equal(events.length, 0);
});

test("throwOnError throws with the composed message on a non-zero exit code", async () => {
  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.stderr.write('boom'); process.exit(3);"],
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
        throwOnError: true,
      }),
    /^Error: Command '.*' failed with exit code 3\. boom$/,
  );
});

test("throwOnError does not throw on exit code 0", async () => {
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.exit(0);"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    throwOnError: true,
  });
  assert.equal(result.exitCode, 0);
});

test("N-2: throwOnError falls back to stdout only when stderr is EMPTY, not merely whitespace-only", async () => {
  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('stdout-should-be-ignored'); process.stderr.write('   '); process.exit(3);"],
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
        throwOnError: true,
      }),
      // A whitespace-only stderr is still non-empty (truthy) in both PowerShell and
      // JS, so the detail must be stderr trimmed down to "" (never falling back to
      // stdout's text) - the composed message ends right after the exit code.
      /^Error: Command '.*' failed with exit code 3\.\s?$/,
  );
});

test("N-5: out-of-range options throw a RangeError naming the option and its bounds", async () => {
  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.exit(0);"],
        workingDirectory: process.cwd(),
        timeoutSeconds: 0,
      }),
    (error: unknown) => error instanceof RangeError && /^timeoutSeconds must be between 1 and 86400/.test(error.message),
  );
  await assert.rejects(
    () =>
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.exit(0);"],
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
        maximumOutputBytes: 1,
      }),
    (error: unknown) =>
      error instanceof RangeError && /^maximumOutputBytes must be between 1024 and 1073741824/.test(error.message),
  );
});

test("S-3: killTree is a no-op once the child has already exited (a late capture-file-error trigger must not call killProcessTree again)", async (t) => {
  // A real OS-level race (e.g. a stdin-write EPIPE landing "around" the same time as
  // 'exit') cannot reliably prove the trigger fires STRICTLY after exit, so this
  // deliberately controls the timing instead: a fake capture sink (injected via
  // `__setCreateCaptureWriteStreamForTests`) hands back its registered 'error'
  // listener, which the test fires itself, well after the child - which exits
  // almost instantly - is certain to have already exited and for `run()` to have
  // already returned. Firing it late still runs the closures `run()` set up
  // (`fireTrigger`/`killTree`), since the listener keeps them alive.
  let errorListener: ((error: Error) => void) | undefined;
  const restore = __setCreateCaptureWriteStreamForTests((): CaptureSink => {
    const sink: CaptureSink = {
      write(): boolean {
        return true;
      },
      on(event, listener): CaptureSink {
        if (event === "error") errorListener = listener as (error: Error) => void;
        return sink;
      },
      end(callback: () => void): CaptureSink {
        callback();
        return sink;
      },
      destroyed: false,
    };
    return sink;
  });
  t.after(() => restore());

  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-s3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "stdout.log");

  let killProcessTreeCalls = 0;
  const spyPlatform: PlatformAdapter = {
    ...platform,
    async createProcessContainer(): Promise<ProcessContainer> {
      return {
        attached: false,
        error: "",
        terminate(): void {
          // no-op
        },
        dispose(): void {
          // no-op
        },
      };
    },
    async killProcessTree(pid: number): Promise<void> {
      killProcessTreeCalls++;
      return platform.killProcessTree(pid);
    },
  };
  const runner = new NodeProcessRunner({ platform: spyPlatform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.exit(0);"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    outputDrainSeconds: 2,
    standardOutputPath: stdoutPath,
  });
  assert.equal(result.exitCode, 0, "the child exits cleanly on its own, well before the delayed error below fires");

  assert.ok(errorListener, "expected the runner to have registered the fake sink's error listener");
  errorListener?.(new Error("simulated late capture error"));
  // Give the (synchronous) killTree()/platform.killProcessTree call a moment to run
  // before checking the final count.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));

  assert.equal(killProcessTreeCalls, 0, "killProcessTree must never be called once the child has already exited");
});

test("CI-EPERM: run() does not resolve until the capture sink has released its file descriptor ('close'), not merely flushed ('finish')", async (t) => {
  // Regression for the windows-latest failure of agentStep.integration.test.ts:
  // protectLogFile(stdout.log) renamed over the capture file right after run()
  // resolved and got EPERM because the fs.WriteStream's fd was still open - end()'s
  // callback fires on 'finish', the descriptor is only released on 'close'. This fake
  // sink fires 'finish' immediately but delays 'close' by 300 ms and reports
  // closed=false until then; run() must wait for it.
  let closeListener: (() => void) | undefined;
  let closedAt = 0;
  const restore = __setCreateCaptureWriteStreamForTests((): CaptureSink => {
    const sink: CaptureSink & { closed: boolean } = {
      write(): boolean {
        return true;
      },
      on(): CaptureSink {
        return sink;
      },
      end(callback: () => void): CaptureSink {
        callback();
        setTimeout(() => {
          sink.closed = true;
          closedAt = Date.now();
          closeListener?.();
        }, 300);
        return sink;
      },
      once(event: "close", listener: () => void): CaptureSink {
        if (event === "close") closeListener = listener;
        return sink;
      },
      destroyed: false,
      closed: false,
    };
    return sink;
  });
  t.after(() => restore());

  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    arguments: ["-e", "process.stdout.write('x'); process.exit(0);"],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    outputDrainSeconds: 2,
    standardOutputPath: join(dir, "stdout.log"),
  });
  const resolvedAt = Date.now();
  assert.equal(result.exitCode, 0);
  assert.ok(closedAt > 0, "the fake sink's delayed 'close' must have fired before run() resolved");
  assert.ok(resolvedAt >= closedAt, "run() resolved before the sink reported 'close'");
});

test("S-4: capture-file writes honour backpressure - the child's stdout is paused while the sink reports write()=false", async (t) => {
  const totalBytes = 8 * 1024 * 1024; // 8 MiB: comfortably larger than any single pipe-chunk/highWaterMark read
  let totalWrittenToSink = 0;
  const restore = __setCreateCaptureWriteStreamForTests((): CaptureSink => {
    const sink: CaptureSink = {
      write(chunk: Buffer): boolean {
        totalWrittenToSink += chunk.length;
        return false; // permanently "backpressured": never signals acceptance
      },
      on(): CaptureSink {
        return sink; // 'drain' is deliberately never fired - see the assertion below
      },
      end(callback: () => void): CaptureSink {
        callback();
        return sink;
      },
      destroyed: false,
    };
    return sink;
  });
  t.after(() => restore());

  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-backpressure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "stdout.log"); // never actually touched - the sink above is fake

  const script = "process.stdout.write(Buffer.alloc(" + String(totalBytes) + ", 65));";
  const runner = new NodeProcessRunner({ platform });
  await runner.run({
    command: process.execPath,
    arguments: ["-e", script],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
    outputDrainSeconds: 2,
    standardOutputPath: stdoutPath,
  });

  // The sink never drains (so the child's stdout, once paused, is never resumed) -
  // without honouring write()'s return value (the pre-fix, fire-and-forget
  // behaviour), the runner keeps reading and forwarding data regardless of
  // backpressure and the sink ends up with (up to) the full amount. With the fix,
  // pause() should stop new 'data' events almost immediately, bounding the sink to a
  // handful of pipe chunks.
  assert.ok(
    totalWrittenToSink > 0 && totalWrittenToSink < totalBytes / 4,
    "expected backpressure to bound writes well under " + String(totalBytes) + ", got " + String(totalWrittenToSink),
  );
});

test("N-4: resolveOutputLimitStream prefers stdout over stderr when both are exceeded", () => {
  // A real end-to-end repro of "both streams end up exceeded, stderr's fires the
  // kill first" turned out to be impractical to make deterministic: on this
  // machine, the Windows Job Object kill this codebase relies on (see
  // docs/adr/0002-windows-job-object-via-koffi.md) is fast enough that the
  // offending stream's kill routinely prevents the OTHER stream from ever being
  // scheduled at all (observed: the non-offending stream ends up with 0 bytes
  // read), so it never independently exceeds in practice. The priority RULE itself
  // - PowerShell's `stdout.LimitExceeded ? "stdout" : (stderr.LimitExceeded ?
  // "stderr" : "")` - is still exactly what must hold whenever both genuinely have
  // exceeded, so it is tested directly and deterministically here instead.
  assert.equal(resolveOutputLimitStream(true, true), "stdout");
  assert.equal(resolveOutputLimitStream(true, false), "stdout");
  assert.equal(resolveOutputLimitStream(false, true), "stderr");
  assert.equal(resolveOutputLimitStream(false, false), "");
});

test(
  "S-2: processExitTimedOut is set as soon as the FIRST 5s post-trigger wait fails, even if the process exits during the later re-kill wait",
  async () => {
    // A never-exiting child under a 1s timeout. killProcessTree deliberately delays
    // the REAL kill until 6 real seconds after it is first called (memoized so the
    // runner's own second, redundant killTree() call - made once the first 5s
    // post-trigger wait fails - awaits the SAME in-flight delay instead of restarting
    // it). This puts the process's actual death just past the first 5s wait but well
    // within the second 2s wait: the old ("only if the SECOND wait also fails")
    // logic would report processExitTimedOut:false here since the second wait
    // succeeds; this fix reports it unconditionally once the first wait alone has
    // failed.
    const script = "setTimeout(() => {}, 60000);";
    let killPromise: Promise<void> | undefined;
    const slowKillPlatform: PlatformAdapter = {
      ...platform,
      async createProcessContainer(): Promise<ProcessContainer> {
        return {
          attached: false,
          error: "",
          terminate(): void {
            // no-op
          },
          dispose(): void {
            // no-op
          },
        };
      },
      async killProcessTree(pid: number): Promise<void> {
        if (!killPromise) {
          killPromise = new Promise((resolvePromise) => {
            setTimeout(() => {
              platform.killProcessTree(pid).then(resolvePromise);
            }, 6000);
          });
        }
        return killPromise;
      },
    };
    const runner = new NodeProcessRunner({ platform: slowKillPlatform });
    const result = await runner.run({
      command: process.execPath,
      arguments: ["-e", script],
      workingDirectory: process.cwd(),
      timeoutSeconds: 1,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.stderr, "Failed to capture process output: process did not exit after termination was requested.");
  },
);

// --- WP-D (ADR-0001 phase 5): .cmd/.bat shim spawning through the validated cmd.exe
// wrapper (src/core/process/cmdShim.ts). Windows-only: off Windows, `resolveExecutable`
// never resolves a `.cmd`/`.bat` shim at all (see src/platform/posix.ts), so this path
// cannot be exercised there.

test("shim spawn: echo-args.cmd round-trips argv for plain/spaced/empty/JSON-with-quotes/metacharacter arguments", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "echo-args.cmd");
  // node is resolved via `process.execPath` (this test's own Node), quoted so a path
  // containing spaces (e.g. "C:\Program Files\nodejs\node.exe") still works.
  writeFileSync(
    shimPath,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
    "utf8",
  );

  const runner = new NodeProcessRunner({ platform });
  const cases: string[][] = [["plain"], ["two words"], [""], ['{"a":"b c"}'], ["a&b"], ["x", "y z", "&"]];
  for (const args of cases) {
    const result = await runner.run({
      command: shimPath,
      arguments: args,
      workingDirectory: process.cwd(),
      timeoutSeconds: 10,
    });
    assert.equal(result.exitCode, 0, `expected exit 0 for args ${JSON.stringify(args)}, stderr: ${JSON.stringify(result.stderr)}`);
    assert.deepEqual(JSON.parse(result.stdout), args, `argv round trip failed for ${JSON.stringify(args)}`);
    // ProcessResult.command/.arguments report the CALLER's values (the shim path as
    // given, and the args as given) - never cmd.exe's own view.
    assert.equal(result.command, shimPath);
    assert.deepEqual(result.arguments, args);
  }
});

test("shim spawn: a rejected argument throws before spawn - no process ever starts", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-reject-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "marker-writer.cmd");
  const markerPath = join(dir, "marker.txt");
  writeFileSync(shimPath, `@echo off\r\necho written> "${markerPath}"\r\n`, "utf8");

  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: shimPath,
        arguments: ["50%"],
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
      }),
    new RegExp(
      `^Error: Failed to start command: .*\\. The shim path or an argument cannot be passed safely through the batch shim '.*': argument 0 contains a percent sign$`,
    ),
  );
  assert.equal(existsSync(markerPath), false, "the shim must never have run - the marker file must not exist");
});

test("shim spawn: exitCode propagates from the .cmd's own exit /b", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-exit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "exit-three.cmd");
  writeFileSync(shimPath, "@echo off\r\nexit /b 3\r\n", "utf8");

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: shimPath,
    arguments: [],
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 3);
});

// --- Fix-1 (review round 1, B-1/S-1/S-2/S-3/finding 5/6/11): the parity-aware
// builder, cmd.exe existence check, /v:off, and Job Object containment through a
// .cmd shim's grandchild - see src/core/process/cmdShim.ts and cmdShim.test.ts for
// the pure-builder half of B-1's proof.

// review round 2 nit 6: every one of these 8 vectors is ALSO known (from the round-2
// attack sweep, `r2\attack.mjs`) to round-trip byte-exactly through a real cmd.exe in
// every shim directory tested - none of them is a REJECTED vector. Asserting the argv
// round-trip here (not just "no marker") turns this test from proving "not injected"
// into proving "correct", which is the actual contract `buildCmdShimCommandLine` makes.
test("shim spawn: B-1 vectors never create the marker file through a REAL cmd.exe, and the argv round-trips byte-exact", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-b1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "echo-args.cmd");
  writeFileSync(
    shimPath,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`,
    "utf8",
  );
  const markerPath = join(dir, "MARKER.txt");
  writeFileSync(join(dir, "whoami.cmd"), `@echo off\r\necho injected> "${markerPath}"\r\n`, "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const vectors: string[][] = [
    ['a"', "x y&whoami"],
    ['{"a":"x\\"y"}', "safe arg&echo INJECTED2"],
    ['"', "&whoami"],
    ['a"b', "(x)"],
    ['x" & whoami'],
    ['" & whoami & "'],
    ['a\\"&whoami'],
    ['x"y"z&whoami'],
  ];

  const runner = new NodeProcessRunner({ platform });
  for (const args of vectors) {
    if (existsSync(markerPath)) rmSync(markerPath);
    const result = await runner.run({
      command: shimPath,
      arguments: args,
      workingDirectory: process.cwd(),
      timeoutSeconds: 10,
    });
    assert.equal(
      existsSync(markerPath),
      false,
      `expected the marker to never be created for args ${JSON.stringify(args)}, stdout: ${JSON.stringify(result.stdout)}`,
    );
    assert.equal(result.exitCode, 0, `args ${JSON.stringify(args)}: stderr ${JSON.stringify(result.stderr)}`);
    assert.deepEqual(JSON.parse(result.stdout), args, `argv round-trip failed for args ${JSON.stringify(args)}`);
  }
});

test("shim spawn: the full review-result transport schema JSON round-trips as a single argument (formerly rejected as 'undecidable')", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "echo-args.cmd");
  writeFileSync(
    shimPath,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`,
    "utf8",
  );

  const registry = loadSchemaRegistry();
  const reviewResultSchemaJson = toClaudeTransportSchemaJson(registry.getDocument("review-result"));
  assert.ok(reviewResultSchemaJson.includes('"'));
  assert.ok(reviewResultSchemaJson.includes("^"), "expected the review-result transport schema to still contain a '^' (a regex anchor)");

  const args = ["-p", "--output-format", "json", "--json-schema", reviewResultSchemaJson, "--model", "claude-opus-5"];
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: shimPath,
    arguments: args,
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0, `stderr: ${JSON.stringify(result.stderr)}`);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("shim spawn: S-1 a shim directory containing cmd.exe metacharacters/comma without whitespace still launches", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-dirs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const echoBody = `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`;

  const runner = new NodeProcessRunner({ platform });
  for (const dirName of ["x(1)", "a,b", "dir with space"]) {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const shimPath = join(dir, "echo-args.cmd");
    writeFileSync(shimPath, echoBody, "utf8");

    const args = ["plain", "two words", "a&b"];
    const result = await runner.run({
      command: shimPath,
      arguments: args,
      workingDirectory: process.cwd(),
      timeoutSeconds: 10,
    });
    assert.equal(result.exitCode, 0, `shim dir ${dirName}: stderr ${JSON.stringify(result.stderr)}`);
    assert.deepEqual(JSON.parse(result.stdout), args, `shim dir ${dirName}: argv round trip failed`);
  }
});

test("shim spawn: an 8000-character argument and unicode both round-trip", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-longuni-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "echo-args.cmd");
  writeFileSync(
    shimPath,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`,
    "utf8",
  );

  const runner = new NodeProcessRunner({ platform });
  const args = ["a".repeat(8000), "日本語 テスト", "émoji 🚀", "^!&|<>()"];
  const result = await runner.run({
    command: shimPath,
    arguments: args,
    workingDirectory: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 0, `stderr: ${JSON.stringify(result.stderr)}`);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

// review round 2 should-fix 2: proves the FIX end-to-end against a real cmd.exe - an
// argument whose total REAL command line lands at exactly 8191 characters actually
// runs to completion (byte-exact), and one landing at 8192 is rejected BEFORE spawn
// (a `Failed to start command` throw, never a spawned-then-failed process). The
// arithmetic mirrors what `src/process/runner.ts` itself computes: the REAL prefix is
// `<spawnFile> /d /s /v:off /c "` where `<spawnFile>` is the resolved COMSPEC (not a
// placeholder `cmd.exe` literal) - this is exactly the gap the previous, wrong-prefix
// check silently left open (builder-accepted lines that then failed at runtime with
// an ordinary exit code and mojibake CP932 stderr, "command line too long").
test("shim spawn: an argument landing the REAL command line at exactly 8191 characters runs to completion; 8192 is rejected before spawn", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "echo-args.cmd");
  writeFileSync(
    shimPath,
    `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`,
    "utf8",
  );

  // Mirrors runner.ts's own COMSPEC resolution exactly, so the boundary computed here
  // matches what the runner will actually spawn.
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  const spawnFile = process.env.COMSPEC || join(systemRoot, "System32", "cmd.exe");
  const commandLinePrefix = `${spawnFile} /d /s /v:off /c "`;

  // line = `"${shimPath}"` (always quoted, no metacharacters in a mkdtemp path) + " "
  // + "a"*N (unquoted: no whitespace/quote); total = commandLinePrefix.length +
  // line.length + 1 (closing quote) = commandLinePrefix.length + (shimPath.length + 2)
  // + 1 + N + 1. Solve for N at total = 8191.
  const quotedShimLength = shimPath.length + 2;
  const atLimitN = 8191 - commandLinePrefix.length - quotedShimLength - 2;
  const overLimitN = atLimitN + 1;

  // Sanity check against the pure builder first, with the SAME prefix, before ever
  // spawning anything - if this ever drifts, the arithmetic above (not the runner) is
  // what needs fixing.
  const atLimitLine = buildCmdShimCommandLine(shimPath, ["a".repeat(atLimitN)], { commandLinePrefix });
  assert.equal(commandLinePrefix.length + atLimitLine.length + 1, 8191);
  assert.throws(() => buildCmdShimCommandLine(shimPath, ["a".repeat(overLimitN)], { commandLinePrefix }));

  const runner = new NodeProcessRunner({ platform });
  const atLimitArgs = ["a".repeat(atLimitN)];
  const okResult = await runner.run({
    command: shimPath,
    arguments: atLimitArgs,
    workingDirectory: process.cwd(),
    timeoutSeconds: 30,
  });
  assert.equal(okResult.exitCode, 0, `stderr: ${JSON.stringify(okResult.stderr)}`);
  assert.deepEqual(JSON.parse(okResult.stdout), atLimitArgs, "expected the at-limit argument to round-trip byte-exact");

  const overLimitArgs = ["a".repeat(overLimitN)];
  await assert.rejects(
    () =>
      runner.run({
        command: shimPath,
        arguments: overLimitArgs,
        workingDirectory: process.cwd(),
        timeoutSeconds: 30,
      }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.startsWith("Failed to start command: "), message);
      assert.ok(message.includes("command line exceeds the 8191-character cmd.exe limit (8192 characters)"), message);
      return true;
    },
  );
});

// review round 2 nit 5: a COMSPEC pointing at a real, existing DIRECTORY (not a file)
// previously passed the old `existsSync` check and then failed at spawn time with a
// misleading `ENOENT`-shaped 127 result - exactly the shape S-3 was meant to remove.
// `statSync(...).isFile()` rejects it here instead, with the SAME clear message as a
// missing COMSPEC.
test("shim spawn: a COMSPEC pointing at a directory is rejected the same way as a missing one", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-comspecdir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "ok.cmd");
  const markerPath = join(dir, "marker.txt");
  writeFileSync(shimPath, `@echo off\r\necho written> "${markerPath}"\r\n`, "utf8");

  const previousComspec = process.env.COMSPEC;
  process.env.COMSPEC = dir; // a real, existing directory - not a file
  t.after(() => {
    if (previousComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = previousComspec;
  });

  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () => runner.run({ command: shimPath, arguments: [], workingDirectory: process.cwd(), timeoutSeconds: 10 }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.startsWith("Failed to start command: "), message);
      assert.ok(message.includes(`cmd.exe was not found at '${dir}' (COMSPEC)`), message);
      return true;
    },
  );
  assert.equal(existsSync(markerPath), false, "the shim must never have run");
});

// review round 2 nit 5: a RELATIVE COMSPEC (e.g. `cmd.exe`, resolvable by
// `CreateProcess` via its own PATH search) must be rejected outright rather than
// silently resolved against `process.cwd()` (which `statSync` would otherwise do
// implicitly, making the outcome depend on an ambient value this runner does not
// otherwise consult).
test("shim spawn: a relative COMSPEC is rejected outright, not resolved against process.cwd()", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-comspecrel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "ok.cmd");
  const markerPath = join(dir, "marker.txt");
  writeFileSync(shimPath, `@echo off\r\necho written> "${markerPath}"\r\n`, "utf8");

  const previousComspec = process.env.COMSPEC;
  process.env.COMSPEC = "cmd.exe";
  t.after(() => {
    if (previousComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = previousComspec;
  });

  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () => runner.run({ command: shimPath, arguments: [], workingDirectory: process.cwd(), timeoutSeconds: 10 }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(message.startsWith("Failed to start command: "), message);
      assert.ok(message.includes("COMSPEC must be an absolute path to cmd.exe, got 'cmd.exe'."), message);
      return true;
    },
  );
  assert.equal(existsSync(markerPath), false, "the shim must never have run");
});

test("shim spawn: an invalid COMSPEC throws Failed to start command, no process ever starts", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-comspec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shimPath = join(dir, "ok.cmd");
  const markerPath = join(dir, "marker.txt");
  writeFileSync(shimPath, `@echo off\r\necho written> "${markerPath}"\r\n`, "utf8");

  const previousComspec = process.env.COMSPEC;
  process.env.COMSPEC = join(dir, "does-not-exist", "cmd.exe");
  t.after(() => {
    if (previousComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = previousComspec;
  });

  const runner = new NodeProcessRunner({ platform });
  await assert.rejects(
    () =>
      runner.run({
        command: shimPath,
        arguments: [],
        workingDirectory: process.cwd(),
        timeoutSeconds: 10,
      }),
    new RegExp(`^Error: Failed to start command: .*\\. cmd\\.exe was not found at '.*does-not-exist.*cmd\\.exe' \\(COMSPEC\\)$`),
  );
  assert.equal(existsSync(markerPath), false, "the shim must never have run");
});

test("finding 11: Job Object containment reaches a grandchild spawned through a .cmd shim on timeout", { skip: !IS_WINDOWS && "windows-only" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runner-cmdshim-sleeper-"));
  const pidPath = join(dir, "grandchild.pid");
  let grandchildPid: number | undefined;
  t.after(() => {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) killByPid(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  });

  // A separate .mjs file (rather than an inline `-e` one-liner) sidesteps having to
  // escape JS-level quotes inside a batch line: the shim just passes the pid-file
  // path as a plain argv entry.
  const grandchildScriptPath = join(dir, "grandchild.mjs");
  writeFileSync(
    grandchildScriptPath,
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 60000);\n",
    "utf8",
  );
  const shimPath = join(dir, "sleeper.cmd");
  // The shim runs the 60s `node` process directly (foreground, no `start`/`/wait`
  // needed) - this is the "only place a grandchild is introduced deliberately
  // through the cmd.exe hop" per finding 11: `NodeProcessRunner` spawns cmd.exe
  // (replacing what would normally be a direct spawn of the command), and cmd.exe in
  // turn spawns `node` as ITS OWN child while running the shim's batch body -
  // structurally a grandchild of the runner. cmd.exe blocking on it for up to 60s is
  // fine: the 2s timeout below kills the whole tree long before that.
  writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${grandchildScriptPath}" "${pidPath}"\r\n`, "utf8");

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: shimPath,
    arguments: [],
    workingDirectory: process.cwd(),
    timeoutSeconds: 2,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);

  const deadline = Date.now() + 3000;
  while (!existsSync(pidPath) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.ok(existsSync(pidPath), "expected the grandchild to have recorded its own PID before the timeout killed it");
  grandchildPid = Number(readFileSync(pidPath, "utf8").trim());

  const died = await pollUntil(() => !isProcessAlive(grandchildPid!), 5000, 200);
  assert.ok(died, `expected grandchild pid ${grandchildPid} to be dead after process-tree termination through the .cmd shim`);
});
