import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "./runner.ts";

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

const platform = getPlatform();

function isProcessAlive(pid: number): boolean {
  if (process.platform === "win32") {
    // `process.kill(pid, 0)` on Windows only reports EPERM/ESRCH reliably for
    // processes owned by the caller in some Node builds; tasklist is the mechanism
    // that this PoC found to be trustworthy across Node versions on Windows.
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" });
      return output.includes(String(pid));
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
    args: ["-e", script],
    cwd: process.cwd(),
    inputText: "héllo 世界\n",
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "stdout:héllo 世界\n");
  assert.equal(result.stderr, "stderr-marker");
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
});

test("enforces bounded stdout and retains only a diagnostic tail once truncated", async () => {
  const totalBytes = 5 * 1024 * 1024;
  const limitBytes = 1 * 1024 * 1024;
  const tailBytes = 8 * 1024;
  const script = `process.stdout.write(Buffer.alloc(${totalBytes}, 65));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutSeconds: 20,
    maximumOutputBytes: limitBytes,
    outputTailBytes: tailBytes,
  });
  assert.equal(result.exitCode, 125);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.outputLimitStream, "stdout");
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") <= tailBytes,
    `retained tail (${Buffer.byteLength(result.stdout, "utf8")} bytes) exceeded the configured tail size (${tailBytes})`,
  );
  // G-05: once the limit fires, the runner destroys the OFFENDING stream immediately
  // (see `maybeEnforceLimit` in runner.ts) instead of continuing to read-and-discard
  // until the async tree-kill lands, so `stdoutBytes` is bounded deterministically to
  // (roughly) the limit plus at most one more pipe chunk. Node's default pipe
  // `highWaterMark` is 64 KiB; allow two chunks of slack for scheduling variance on
  // both Windows and POSIX (verified empirically: observed overshoot was well under
  // one chunk in repeated local runs).
  assert.ok(
    result.stdoutBytes <= limitBytes + 65536 * 2,
    `expected stdoutBytes (${result.stdoutBytes}) to be bounded to maximumOutputBytes (${limitBytes}) plus a small pipe-chunk slack`,
  );
});

test("explicit env replaces the inherited environment (allow-list only)", async (t) => {
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
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutSeconds: 10,
    env: { MARKER: "yes" },
  });
  const childEnv = JSON.parse(result.stdout) as Record<string, string | undefined>;
  assert.equal(childEnv.MARKER, "yes");
  assert.equal(childEnv.GH_TOKEN, undefined);
});

test(
  "timeout terminates the whole process tree: exit code 124 and the grandchild is dead afterwards",
  async () => {
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
      args: ["-e", parentScript],
      cwd: process.cwd(),
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
  },
);

// F-01: a child that exits before consuming a large stdin write must not crash the
// host with an uncaught EPIPE/EOF error, and must be reported as exit 126.
test("stdin write failure (child exits immediately) is reported as 126, not a host crash", async () => {
  const script = "process.exit(3);";
  const bigInput = "x".repeat(8 * 1024 * 1024); // 8 MiB: comfortably larger than an OS pipe buffer
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    inputText: bigInput,
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 126);
  assert.equal(result.terminationReason, "inputError");
  assert.notEqual(result.inputError, "");
  assert.match(result.stderr, /Failed to write process input:/);
  // Reaching this assertion at all proves the host process (running this test) is
  // still alive - an uncaught EPIPE/EOF in the runner would have crashed it instead.
});

// F-02: a direct child that spawns a detached grandchild inheriting stdio, then exits
// immediately, must not make the runner hang until the grandchild (which outlives it)
// closes the pipe. The bounded drain must give up after ~outputDrainSeconds.
test("bounded output drain: a surviving detached grandchild does not block the result", async (t) => {
  const grandchildScript = "process.stdout.write('grandchild-pid:' + process.pid + '\\n'); setTimeout(() => {}, 15000);";
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: true });
    child.unref();
  `;
  const runner = new NodeProcessRunner({ platform });
  const startedAt = Date.now();
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", parentScript],
    cwd: process.cwd(),
    timeoutSeconds: 30,
    outputDrainSeconds: 2,
  });
  const elapsedMs = Date.now() - startedAt;

  const match = result.stdout.match(/grandchild-pid:(\d+)/);
  const grandchildPid = match ? Number(match[1]) : undefined;
  t.after(() => {
    // On Windows this grandchild is expected to survive: it is never job-assigned in
    // the first place (SILENT_BREAKAWAY_OK means libuv's one global job per Node host
    // process - shared by every non-detached direct child - never gains grandchildren),
    // and by the time `killProcessTree(child.pid)` runs, the direct
    // child has already exited - so `taskkill /T` has no live root left to walk down
    // to the grandchild. On POSIX it may also survive if it re-parented out of the
    // killed process group. Either way, clean it up so the test run does not leak a
    // process that sleeps for 15s.
    if (grandchildPid !== undefined) killByPid(grandchildPid);
  });

  assert.ok(grandchildPid !== undefined, `expected to find the grandchild pid in captured stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.timedOut, false, "this must resolve via the bounded drain, not the 30s timeout");
  assert.equal(result.outputDrainTimedOut, true);
  assert.equal(result.terminationReason, "captureError");
  assert.equal(result.exitCode, 127);
  assert.ok(
    elapsedMs < 6000,
    `expected the runner to return within ~outputDrainSeconds(2s)+1s instead of waiting for the grandchild's 15s sleep, took ${elapsedMs}ms`,
  );
});

// G-01: the drain-race timer (see F-02 above) must be cleared as soon as `close`
// arrives first, instead of staying armed for the rest of `outputDrainSeconds`. A
// grandchild that inherits stdio but exits on its own shortly after the direct child
// (closing the shared pipe) must let `run()` return promptly even though
// `outputDrainSeconds` is generous (5s) - and must NOT report a drain timeout, proving
// the `close` path (not the timer) is what settled the race. (The specific host-level
// property this fixes - that the internal `setTimeout` no longer keeps the Node
// process's event loop alive after `run()` returns - is not directly observable from
// inside a node:test process; it was verified separately with a standalone scratch
// script that measures wall-clock time until the host process itself exits.)
test("bounded output drain: timer is cleared once close arrives first, no drain timeout is reported", async (t) => {
  const grandchildScript =
    "process.stdout.write('grandchild-pid:' + process.pid + '\\n'); setTimeout(() => { process.exit(0); }, 500);";
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit', detached: true });
    child.unref();
  `;
  const runner = new NodeProcessRunner({ platform });
  const startedAt = Date.now();
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", parentScript],
    cwd: process.cwd(),
    timeoutSeconds: 30,
    outputDrainSeconds: 5,
  });
  const elapsedMs = Date.now() - startedAt;

  const match = result.stdout.match(/grandchild-pid:(\d+)/);
  const grandchildPid = match ? Number(match[1]) : undefined;
  t.after(() => {
    if (grandchildPid !== undefined) killByPid(grandchildPid);
  });

  assert.ok(grandchildPid !== undefined, `expected to find the grandchild pid in captured stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.outputDrainTimedOut, false, "the grandchild's own exit should close the pipe well before the 5s drain timer");
  assert.ok(
    elapsedMs < 2000,
    `expected run() to return in well under outputDrainSeconds(5s) once the grandchild exits at ~500ms, took ${elapsedMs}ms`,
  );
});

// F-04: spawning a `.cmd` path directly must not make `run()` reject (Node's `spawn`
// throws synchronously - EINVAL, CVE-2024-27980 - for a `.cmd` target); it must come
// back as a normal 127 result instead.
test("running a .cmd path directly returns 127, not a rejection (Windows)", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only case: this EINVAL behaviour is specific to Windows spawn()");
    return;
  }
  const { dirname, join: pathJoin } = await import("node:path");
  const nodeDir = dirname(process.execPath);
  const npmCmd = pathJoin(nodeDir, "npm.cmd");
  if (!existsSync(npmCmd)) {
    t.skip(`npm.cmd not found alongside node.exe at ${npmCmd}`);
    return;
  }
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: npmCmd,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 127);
  assert.equal(result.terminationReason, "captureError");
  assert.notEqual(result.stderr, "");
});

// F-06: a command that cannot be spawned at all is reported as 127 with a non-empty
// stderr, not silently as exit code 1 with nothing explaining why.
test("nonexistent command is reported as 127 with a non-empty stderr", async () => {
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: "hdo-poc-definitely-does-not-exist-anywhere",
    args: [],
    cwd: process.cwd(),
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 127);
  assert.equal(result.terminationReason, "captureError");
  assert.notEqual(result.stderr, "");
});

test("nonexistent cwd is reported as 127 with a non-empty stderr", async () => {
  const runner = new NodeProcessRunner({ platform });
  const bogusCwd = join(tmpdir(), "hdo-poc-definitely-does-not-exist", "deeper");
  assert.equal(existsSync(bogusCwd), false);
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", "process.exit(0);"],
    cwd: bogusCwd,
    timeoutSeconds: 10,
  });
  assert.equal(result.exitCode, 127);
  assert.equal(result.terminationReason, "captureError");
  assert.notEqual(result.stderr, "");
});

// F-07: an output capture file that cannot be written (path is an existing directory,
// EISDIR) must not crash the host either, and must be reported the same way.
test("stdoutPath pointing at an existing directory is reported as 127, host stays alive, no file is created", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-poc-stdoutpath-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "is-a-directory");
  mkdirSync(stdoutPath);

  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('hello');"],
    cwd: process.cwd(),
    timeoutSeconds: 10,
    stdoutPath,
  });
  assert.equal(result.exitCode, 127);
  assert.equal(result.terminationReason, "captureError");
  assert.match(result.stderr, /Failed to capture process output:/);
  assert.ok(statSync(stdoutPath).isDirectory(), "the path must still be the directory it was, untouched");
});

// G-03: when the capture file's parent directory cannot be created at all (an
// ancestor path segment is itself a regular file, so `mkdir(..., { recursive: true })`
// throws ENOTDIR rather than the file-write itself throwing EISDIR as in the F-07
// case above), `run()` must still resolve to a normal 127 result - never reject -
// since nothing has been spawned yet and there is no process tree to kill.
test("stdoutPath whose parent directory cannot be created (ancestor is a file) is reported as 127, run() does not reject", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-poc-mkdirfail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ancestorFile = join(dir, "existing-file");
  writeFileSync(ancestorFile, "not a directory\n", "utf8");
  const stdoutPath = join(ancestorFile, "out.log");

  const runner = new NodeProcessRunner({ platform });
  let result: Awaited<ReturnType<typeof runner.run>>;
  try {
    result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello');"],
      cwd: process.cwd(),
      timeoutSeconds: 10,
      stdoutPath,
    });
  } catch (error) {
    assert.fail(`run() must resolve, not reject, when the capture directory cannot be created: ${error}`);
  }
  assert.equal(result.exitCode, 127);
  assert.equal(result.terminationReason, "captureError");
  assert.match(result.stderr, /Failed to capture process output:/);
});

// A-2: once the output limit is hit, the runner must stop writing full chunks to the
// capture file - only the bytes that were within budget - instead of writing the
// entire (potentially far larger) chunk it just received.
test("file output is bounded to maximumOutputBytes, not the full received chunk", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-poc-boundedfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "stdout.log");

  const totalBytes = 4 * 1024 * 1024;
  const limitBytes = 1 * 1024 * 1024;
  const script = `process.stdout.write(Buffer.alloc(${totalBytes}, 65));`;
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutSeconds: 20,
    maximumOutputBytes: limitBytes,
    stdoutPath,
  });
  assert.equal(result.exitCode, 125);
  assert.equal(result.terminationReason, "outputLimit");
  const fileSize = statSync(stdoutPath).size;
  assert.ok(
    fileSize <= limitBytes,
    `expected the capture file to be bounded to ${limitBytes} bytes (chunk slicing should make this exact), got ${fileSize}`,
  );
  // Sanity: the file did receive real bytes, this isn't an empty-file false pass.
  assert.ok(fileSize > 0);
});
