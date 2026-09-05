// Windows-only: exercises the real Win32 Job Object attach/terminate/dispose cycle
// (AC-03) through both a direct unit test of `createWindowsProcessContainer` and an
// end-to-end run of `tests/fixtures/runtime/hold-output-handle.ps1` through the real
// `NodeProcessRunner`. Skipped entirely off Windows.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NodeProcessRunner } from "../process/runner.ts";
import { createWindowsPlatformAdapter } from "./windows.ts";
import { __setKoffiImporterForTests, createWindowsProcessContainer } from "./jobObject.ts";
import type { PlatformAdapter, ProcessContainer } from "./types.ts";

const IS_WINDOWS = process.platform === "win32";
const SKIP_REASON = IS_WINDOWS ? false : "windows-only";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const HOLD_OUTPUT_HANDLE_PS1 = resolve(REPO_ROOT, "tests/fixtures/runtime/hold-output-handle.ps1");

// S-8: `output.includes(String(pid))` (the previous implementation) false-positives
// whenever the target PID's digits happen to appear inside another row's memory
// column (e.g. "12,345 K") or a different process's own PID - CSV output with the
// header suppressed is parsed field-by-field instead, matching exactly what
// `tasklist /FI "PID eq N"` was asked to filter for.
function isProcessAlive(pid: number): boolean {
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

async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return predicate();
}

function killPidIfAlive(pid: number): void {
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

test(
  "S-1: two concurrent FIRST-time createWindowsProcessContainer calls both resolve (no 'Duplicate type name' koffi error) - must run before any other koffi use in this file/process",
  { skip: SKIP_REASON },
  async () => {
    // Deliberately the very first koffi use in this test file/process: two
    // concurrent calls, before `loadJobObjectLib`'s underlying koffi.struct
    // declarations have ever run for this process, is exactly the race that used to
    // make the second caller's `koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", ...)`
    // throw "Duplicate type name" (caching only the *resolved* lib/error, not the
    // in-flight load promise, left a window where both callers saw nothing cached
    // yet and both ran the declaration body). Two invalid-but-distinct PIDs so
    // neither call can short-circuit on the other's result.
    const [a, b] = await Promise.all([createWindowsProcessContainer(2_000_000_001), createWindowsProcessContainer(2_000_000_002)]);
    assert.equal(a.attached, false);
    assert.equal(b.attached, false);
    assert.match(a.error, /^OpenProcess failed with Win32 error \d+\.$/);
    assert.match(b.error, /^OpenProcess failed with Win32 error \d+\.$/);
  },
);

test("createWindowsProcessContainer reports a PowerShell-compatible error when the target process cannot be opened", { skip: SKIP_REASON }, async () => {
  // A PID astronomically unlikely to belong to a running process on this machine -
  // CreateJobObject/SetInformationJobObject do not depend on the target PID at all
  // and succeed unconditionally here, so OpenProcess is specifically the call that
  // fails (ERROR_INVALID_PARAMETER, 87), which this codebase surfaces as its own
  // (documented, non-PowerShell-equivalent) "OpenProcess failed with Win32 error N."
  // message - see jobObject.ts's module comment on `createWindowsProcessContainer`
  // for why this step has no PowerShell analogue. S-8: asserts the EXACT expected
  // message for this scenario, not an any-of-three regex that would also accept a
  // CreateJobObject/SetInformationJobObject failure this test never exercises.
  const container = await createWindowsProcessContainer(2_000_000_000);
  assert.equal(container.attached, false);
  assert.match(container.error, /^OpenProcess failed with Win32 error \d+\.$/);
  // Must be safe to call even though nothing was ever attached.
  container.terminate();
  container.dispose();
});

test("createWindowsProcessContainer: koffi import failure downgrades to attached:false with the documented error prefix (S-8)", { skip: SKIP_REASON }, async () => {
  const restore = __setKoffiImporterForTests(() => Promise.reject(new Error("simulated koffi import failure")));
  try {
    const container = await createWindowsProcessContainer(process.pid);
    assert.equal(container.attached, false);
    assert.equal(container.error, "koffi could not be loaded: simulated koffi import failure");
    container.terminate();
    container.dispose();
  } finally {
    restore();
  }
});

test("koffi import failure surfaces through NodeProcessRunner's drain-timeout message suffix too (S-8)", { skip: SKIP_REASON }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-jobobject-koffifail-"));
  const pidPath = join(dir, "child.pid");
  let grandchildPid: number | undefined;
  const restore = __setKoffiImporterForTests(() => Promise.reject(new Error("simulated koffi import failure")));
  t.after(() => {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) killPidIfAlive(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
    restore();
  });

  const platform = createWindowsPlatformAdapter();
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: "pwsh",
    arguments: ["-NoProfile", "-File", HOLD_OUTPUT_HANDLE_PS1, "-PidPath", pidPath],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    outputDrainSeconds: 1,
  });

  grandchildPid = Number(readFileSync(pidPath, "utf8").trim());
  assert.equal(result.outputDrainTimedOut, true);
  assert.match(
    result.stderr,
    /Process-tree containment was unavailable: koffi could not be loaded: simulated koffi import failure$/,
  );
});

test("hold-output-handle.ps1 through NodeProcessRunner: exitCode 0, no drain timeout, grandchild is gone", { skip: SKIP_REASON }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-jobobject-"));
  const pidPath = join(dir, "child.pid");
  let grandchildPid: number | undefined;
  t.after(() => {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) killPidIfAlive(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  });

  const platform = createWindowsPlatformAdapter();
  const runner = new NodeProcessRunner({ platform });
  const result = await runner.run({
    command: "pwsh",
    arguments: ["-NoProfile", "-File", HOLD_OUTPUT_HANDLE_PS1, "-PidPath", pidPath],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    outputDrainSeconds: 1,
  });

  grandchildPid = Number(readFileSync(pidPath, "utf8").trim());
  assert.equal(result.exitCode, 0, `expected exit 0, got: ${JSON.stringify(result)}`);
  assert.equal(result.outputDrainTimedOut, false);

  const died = await pollUntil(() => !isProcessAlive(grandchildPid!), 3000, 100);
  assert.ok(died, `expected grandchild pid ${grandchildPid} to be gone after the Windows Job Object was closed`);
});

test("drain-timeout message includes the container error suffix when containment is unavailable", { skip: SKIP_REASON }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-jobobject-unavailable-"));
  const pidPath = join(dir, "child.pid");
  let grandchildPid: number | undefined;
  t.after(() => {
    if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) killPidIfAlive(grandchildPid);
    rmSync(dir, { recursive: true, force: true });
  });

  const realPlatform = createWindowsPlatformAdapter();
  const simulatedError = "simulated failure injected by jobObject.test.ts";
  // A platform adapter identical to the real Windows one, except containment is
  // forced "unavailable" - simulating a koffi load failure or a Win32 API error
  // without needing to actually break koffi/kernel32 on this machine. The runner
  // then has no choice but to fall back to `killProcessTree` (taskkill /T /F), which
  // - once the direct child has already exited - has no live root left to walk down
  // to the grandchild, exactly like the pre-Job-Object PoC behaviour.
  const unavailableContainerPlatform: PlatformAdapter = {
    ...realPlatform,
    async createProcessContainer(): Promise<ProcessContainer> {
      return {
        attached: false,
        error: simulatedError,
        terminate(): void {
          // no-op
        },
        dispose(): void {
          // no-op
        },
      };
    },
  };

  const runner = new NodeProcessRunner({ platform: unavailableContainerPlatform });
  const result = await runner.run({
    command: "pwsh",
    arguments: ["-NoProfile", "-File", HOLD_OUTPUT_HANDLE_PS1, "-PidPath", pidPath],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    outputDrainSeconds: 1,
  });

  grandchildPid = Number(readFileSync(pidPath, "utf8").trim());
  assert.equal(result.outputDrainTimedOut, true);
  assert.equal(result.exitCode, 127);
  assert.match(result.stderr, /remained open after the process exited/);
  assert.match(result.stderr, new RegExp(`Process-tree containment was unavailable: ${simulatedError}$`));
});
