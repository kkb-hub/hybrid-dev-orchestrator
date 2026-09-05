// AC-04: for each `tests/fixtures/runtime/*.ps1` scenario, runs BOTH PowerShell's
// `Invoke-HdoProcess` (via the real module, inside its own session state, exactly
// like `tests/test-process-output.ps1` does) and `NodeProcessRunner.run` with the
// same parameters, then asserts the two results are IDENTICAL - same key set, same
// key ORDER, and every value strictly equal - after deleting `startedAt`/`endedAt`/
// `durationMs` (real timestamps that can never match) and after normalizing the
// handful of fields that are legitimately platform-specific (see
// `normalizeByteFloor`/`normalizeMessageTail` below). Skipped entirely when `pwsh` is
// not on PATH.
//
// S-5: an earlier version of this file only did this full comparison for one
// scenario (and even then only compared SORTED key sets plus two fields by name);
// every other scenario asserted a handful of individual fields, and one assertion
// (`assert.ok(true, ...)`) could never fail at all. Every scenario below now goes
// through `assertFullParity`, so a divergence in ANY field (including one nobody
// thought to check by name) fails the test.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "./runner.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const platform = getPlatform();

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

interface OracleSpec {
  command: string;
  arguments?: string[];
  workingDirectory: string;
  inputText?: string;
  timeoutSeconds: number;
  standardOutputPath?: string;
  standardErrorPath?: string;
  maximumOutputBytes?: number;
  outputTailBytes?: number;
  outputDrainSeconds?: number;
}

interface OracleOutcome {
  result: Record<string, unknown> | null;
  errorMessage: string | null;
}

// Invokes `Invoke-HdoProcess` (a private, un-exported function) inside the module's
// own session state - the same `& $module { scriptblock }` trick
// tests/test-process-output.ps1 uses - so no export changes are needed to the
// PowerShell module. A thrown exception (e.g. "Command was not found: ...") is
// captured as `errorMessage` rather than failing the harness script itself.
const ORACLE_SCRIPT = `
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$SpecPath,
    [Parameter(Mandatory)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $RepositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator
$spec = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json -Depth 100

function Get-SpecProperty {
    param([Parameter(Mandatory)]$Spec, [Parameter(Mandatory)][string]$Name)
    if ($Spec.PSObject.Properties.Match($Name).Count -eq 0) { return $null }
    return $Spec.$Name
}

$params = [ordered]@{
    Command = [string]$spec.command
    Arguments = @($spec.arguments)
    WorkingDirectory = [string]$spec.workingDirectory
    TimeoutSeconds = [int]$spec.timeoutSeconds
}
$inputText = Get-SpecProperty $spec 'inputText'
if ($null -ne $inputText) { $params.InputText = [string]$inputText }
$standardOutputPath = Get-SpecProperty $spec 'standardOutputPath'
if ($standardOutputPath) { $params.StandardOutputPath = [string]$standardOutputPath }
$standardErrorPath = Get-SpecProperty $spec 'standardErrorPath'
if ($standardErrorPath) { $params.StandardErrorPath = [string]$standardErrorPath }
$maximumOutputBytes = Get-SpecProperty $spec 'maximumOutputBytes'
if ($maximumOutputBytes) { $params.MaximumOutputBytes = [long]$maximumOutputBytes }
$outputTailBytes = Get-SpecProperty $spec 'outputTailBytes'
if ($outputTailBytes) { $params.OutputTailBytes = [int]$outputTailBytes }
$outputDrainSeconds = Get-SpecProperty $spec 'outputDrainSeconds'
if ($outputDrainSeconds) { $params.OutputDrainSeconds = [int]$outputDrainSeconds }

$outcome = & $module {
    param($Params)
    try {
        $r = Invoke-HdoProcess @Params
        return [ordered]@{ result = $r; errorMessage = $null }
    }
    catch {
        return [ordered]@{ result = $null; errorMessage = $_.Exception.Message }
    }
} $params

$outcome | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
`;

function runOracle(spec: OracleSpec): OracleOutcome {
  const tempDir = mkdtempSync(join(tmpdir(), "hdo-process-parity-"));
  try {
    const scriptPath = join(tempDir, "oracle.ps1");
    const specPath = join(tempDir, "spec.json");
    const outputPath = join(tempDir, "output.json");
    writeFileSync(scriptPath, ORACLE_SCRIPT, "utf8");
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-File", scriptPath, "-RepositoryRoot", REPO_ROOT, "-SpecPath", specPath, "-OutputPath", outputPath],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, `oracle harness script failed: ${result.stderr}\n${result.stdout}`);
    return JSON.parse(readFileSync(outputPath, "utf8")) as OracleOutcome;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runTs(spec: OracleSpec): Promise<OracleOutcome> {
  const runner = new NodeProcessRunner({ platform });
  try {
    const result = await runner.run({
      command: spec.command,
      arguments: spec.arguments,
      workingDirectory: spec.workingDirectory,
      inputText: spec.inputText,
      timeoutSeconds: spec.timeoutSeconds,
      standardOutputPath: spec.standardOutputPath,
      standardErrorPath: spec.standardErrorPath,
      maximumOutputBytes: spec.maximumOutputBytes,
      outputTailBytes: spec.outputTailBytes,
      outputDrainSeconds: spec.outputDrainSeconds,
    });
    return { result: result as unknown as Record<string, unknown>, errorMessage: null };
  } catch (error) {
    return { result: null, errorMessage: (error as Error).message };
  }
}

function fixture(name: string): string {
  return resolve(REPO_ROOT, "tests/fixtures/runtime", name);
}

/** Deletes the three fields that are real wall-clock timestamps and can never match between two independent runs. Mutates and returns `result`. */
function stripVolatileFields(result: Record<string, unknown>): Record<string, unknown> {
  delete result.startedAt;
  delete result.endedAt;
  delete result.durationMs;
  return result;
}

/**
 * Asserts `ps` and `ts` are identical: same key set AND ORDER (`Object.keys`
 * arrays compared without `.sort()` - PowerShell's ordered hashtable and
 * `ProcessResult`'s field order must genuinely agree, not just happen to contain
 * the same names), and every remaining value strictly equal, after
 * `stripVolatileFields`. Call this LAST, after any scenario-specific
 * `normalizeByteFloor`/`normalizeMessageTail` calls have already mutated `ps`/`ts`
 * in place.
 */
function assertFullParity(ps: Record<string, unknown>, ts: Record<string, unknown>, label: string): void {
  const psClean = stripVolatileFields(ps);
  const tsClean = stripVolatileFields(ts);
  assert.deepStrictEqual(Object.keys(tsClean), Object.keys(psClean), `${label}: ProcessResult key order differs`);
  assert.deepStrictEqual(tsClean, psClean, `${label}: ProcessResult values differ`);
}

/**
 * Byte counts past `maximumOutputBytes` are legitimately implementation-defined
 * (how many bytes .NET/Node had already read from the pipe at the exact moment the
 * limit-enforcement code ran depends on OS/runtime buffering granularity, not on
 * any behaviour this port needs to match). Asserts BOTH sides are at least `floor`
 * (a real assertion: either implementation stopping short of the limit would be a
 * bug), then overwrites both fields with the same sentinel so `assertFullParity`
 * can still strictly compare everything else.
 */
function normalizeByteFloor(ps: Record<string, unknown>, ts: Record<string, unknown>, field: string, floor: number): void {
  const psValue = ps[field] as number;
  const tsValue = ts[field] as number;
  assert.ok(psValue >= floor, `PS ${field} (${psValue}) expected to be >= ${floor}`);
  assert.ok(tsValue >= floor, `TS ${field} (${tsValue}) expected to be >= ${floor}`);
  ps[field] = `>=${floor}`;
  ts[field] = `>=${floor}`;
}

/**
 * Normalizes a message field whose PREFIX must match exactly between PS and TS but
 * whose TAIL is a raw OS/runtime error string that legitimately differs (.NET's
 * `UnauthorizedAccessException`/localized pipe-closed text vs Node's `errno` code).
 * Asserts the common prefix is present on BOTH sides (a real assertion - losing the
 * prefix would mean the wrong code path fired), asserts each side's tail
 * independently satisfies its own platform-specific expectation (also real
 * assertions - an empty or unrelated tail would fail), then collapses both tails to
 * the same placeholder so `assertFullParity` can strictly compare the rest.
 */
function normalizeMessageTail(
  ps: Record<string, unknown>,
  ts: Record<string, unknown>,
  field: string,
  commonPrefix: string,
  checkPsTail: (tail: string) => void,
  checkTsTail: (tail: string) => void,
): void {
  const psValue = ps[field] as string;
  const tsValue = ts[field] as string;
  assert.ok(psValue.startsWith(commonPrefix), `PS ${field} missing expected prefix ${JSON.stringify(commonPrefix)}: ${JSON.stringify(psValue)}`);
  assert.ok(tsValue.startsWith(commonPrefix), `TS ${field} missing expected prefix ${JSON.stringify(commonPrefix)}: ${JSON.stringify(tsValue)}`);
  checkPsTail(psValue.slice(commonPrefix.length));
  checkTsTail(tsValue.slice(commonPrefix.length));
  ps[field] = `${commonPrefix}<PLATFORM-SPECIFIC-TAIL>`;
  ts[field] = `${commonPrefix}<PLATFORM-SPECIFIC-TAIL>`;
}

test("spam-output.ps1 -Stream stdout: both implementations hit the output limit identically", { skip: SKIP_REASON }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-parity-spam-stdout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Same paths for both runs (PS then TS run strictly sequentially - `runOracle` is
  // synchronous - so there is no concurrent-write hazard): `arguments`/`stdoutPath`/
  // `stderrPath` must be byte-for-byte identical for `assertFullParity` to compare
  // anything at all, and inventing a "ps."/"ts."-prefixed pair of paths (an earlier
  // version of this test did) just manufactures a fake divergence in exactly those
  // fields.
  const stdoutPath = join(dir, "out.log");
  const stderrPath = join(dir, "err.log");

  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("spam-output.ps1"), "-Stream", "stdout"],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    standardOutputPath: stdoutPath,
    standardErrorPath: stderrPath,
    maximumOutputBytes: 32768,
    outputTailBytes: 4096,
  };

  const psOutcome = runOracle(spec);
  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  assert.equal(statSync(stdoutPath).size, 32768);

  const tsOutcome = await runTs(spec);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ts = tsOutcome.result!;
  assert.equal(statSync(stdoutPath).size, 32768);

  normalizeByteFloor(ps, ts, "stdoutBytes", 32768);
  assertFullParity(ps, ts, "spam-output stdout");
});

test("spam-output.ps1 -Stream stderr: both implementations hit the output limit identically", { skip: SKIP_REASON }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-parity-spam-stderr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdoutPath = join(dir, "out.log");
  const stderrPath = join(dir, "err.log");

  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("spam-output.ps1"), "-Stream", "stderr"],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    standardOutputPath: stdoutPath,
    standardErrorPath: stderrPath,
    maximumOutputBytes: 32768,
    outputTailBytes: 4096,
  };

  const psOutcome = runOracle(spec);
  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  assert.equal(statSync(stderrPath).size, 32768);

  const tsOutcome = await runTs(spec);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ts = tsOutcome.result!;
  assert.equal(statSync(stderrPath).size, 32768);

  normalizeByteFloor(ps, ts, "stderrBytes", 32768);
  assertFullParity(ps, ts, "spam-output stderr");
});

test("delayed-output.ps1: both implementations succeed with identical results", { skip: SKIP_REASON }, async () => {
  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("delayed-output.ps1")],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 10,
  };
  const psOutcome = runOracle(spec);
  const tsOutcome = await runTs(spec);

  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  const ts = tsOutcome.result!;
  assert.equal(ps.stdout, '{"status":"ok"}');
  assert.equal(ts.stdout, '{"status":"ok"}');

  // Heartbeat itself is asserted TS-side only (runner.test.ts); this scenario is
  // shared with PowerShell purely for the exit code/stdout parity check.
  assertFullParity(ps, ts, "delayed-output");
});

test("hold-output-handle.ps1 with a 1s drain: both implementations produce identical results (Windows)", { skip: SKIP_REASON }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only: this scenario's PS oracle result differs by OS ($IsWindows branch in test-process-output.ps1)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hdo-parity-hold-"));
  // Same path for both runs (PS then TS run strictly sequentially - see the
  // spam-output tests above for why): each run overwrites it with its own
  // grandchild's PID, which is captured into `pidsToKill` immediately afterward
  // (before the next run overwrites the file) so both grandchildren still get
  // cleaned up even though only one file is used.
  const pidPath = join(dir, "child.pid");
  const pidsToKill: number[] = [];
  t.after(() => {
    for (const pid of pidsToKill) {
      try {
        spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("hold-output-handle.ps1"), "-PidPath", pidPath],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    outputDrainSeconds: 1,
  };

  const psOutcome = runOracle(spec);
  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  try {
    pidsToKill.push(Number(readFileSync(pidPath, "utf8").trim()));
  } catch {
    // no pid file written / already gone
  }

  const tsOutcome = await runTs(spec);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ts = tsOutcome.result!;
  try {
    pidsToKill.push(Number(readFileSync(pidPath, "utf8").trim()));
  } catch {
    // no pid file written / already gone
  }

  assert.equal(ps.exitCode, 0);
  assert.equal(ts.exitCode, 0);
  assert.equal(ps.outputDrainTimedOut, false);
  assert.equal(ts.outputDrainTimedOut, false);

  assertFullParity(ps, ts, "hold-output-handle");
});

test("ignore-input.ps1 with a large stdin write and a 1s timeout: both implementations time out identically (124)", { skip: SKIP_REASON }, async () => {
  const inputText = "x".repeat(5 * 1024 * 1024);
  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("ignore-input.ps1")],
    workingDirectory: REPO_ROOT,
    inputText,
    timeoutSeconds: 1,
    outputDrainSeconds: 1,
  };
  const psOutcome = runOracle(spec);
  const tsOutcome = await runTs(spec);

  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  const ts = tsOutcome.result!;
  assert.equal(ps.exitCode, 124);
  assert.equal(ts.exitCode, 124);
  assert.equal(ps.timedOut, true);
  assert.equal(ts.timedOut, true);

  // Both implementations race a genuine 1s timeout against the stdin write's own
  // EPIPE/broken-pipe failure - `timedOut` wins the exit-code priority race either
  // way (Common.ps1's precedence chain / `resolveExitCode`), but the STDERR text is
  // governed by a separate, unconditional cascade that still reports the input
  // error - so this scenario really does exercise (and must match on) the
  // input-error message tail, which is a raw, un-normalized OS/runtime string:
  // .NET's (possibly localized) "the pipe has ended"-style text vs Node's `EOF: write
  // EOF`. The .NET side is checked only for non-emptiness (locale-independent); the
  // Node side's exact text is deterministic and checked precisely.
  normalizeMessageTail(
    ps,
    ts,
    "stderr",
    "Failed to write process input: ",
    (psTail) => assert.ok(psTail.trim().length > 0, `expected a non-empty PS input-error tail, got: ${JSON.stringify(psTail)}`),
    (tsTail) => assert.equal(tsTail, "EOF: write EOF"),
  );
  assertFullParity(ps, ts, "ignore-input timeout+input-error");
});

test("ignore-input.ps1 with standardOutputPath pointing at a directory: both implementations fail to capture identically (127)", { skip: SKIP_REASON }, async (t) => {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // C:\Users\RUNNER~1\... while .NET reports the long name (C:\Users\runneradmin\...)
  // in its error text, so the path both tails are checked against must be the long form.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-parity-captureerror-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invalidOutputPath = join(dir, "stdout-is-a-directory");
  mkdirSync(invalidOutputPath);

  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("ignore-input.ps1")],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 20,
    standardOutputPath: invalidOutputPath,
    outputDrainSeconds: 1,
  };
  const psOutcome = runOracle(spec);
  const tsOutcome = await runTs(spec);

  assert.equal(psOutcome.errorMessage, null, `PS oracle threw: ${psOutcome.errorMessage}`);
  assert.equal(tsOutcome.errorMessage, null, `TS runner threw: ${tsOutcome.errorMessage}`);
  const ps = psOutcome.result!;
  const ts = tsOutcome.result!;
  assert.equal(ps.exitCode, 127);
  assert.equal(ts.exitCode, 127);

  // Common prefix confirmed empirically on this machine: both report the capture
  // failure the same way up to "stdout: ", then diverge into a raw OS error for the
  // EISDIR-on-open condition. Each side's tail is checked against ITS OWN
  // deterministic pattern (both .NET's UnauthorizedAccessException text and Node's
  // `EISDIR` errno message are non-localized/deterministic here, so both can be
  // checked precisely rather than merely "non-empty") and must reference the actual
  // path, not just look plausible.
  normalizeMessageTail(
    ps,
    ts,
    "stderr",
    "Failed to capture process output: stdout: ",
    (psTail) => {
      assert.match(psTail, /^Access to the path '.*' is denied\.$/);
      assert.ok(psTail.includes(invalidOutputPath), `expected PS tail to reference ${invalidOutputPath}, got: ${psTail}`);
    },
    (tsTail) => {
      assert.match(tsTail, /^EISDIR: illegal operation on a directory, open '.*'$/);
      assert.ok(tsTail.includes(invalidOutputPath), `expected TS tail to reference ${invalidOutputPath}, got: ${tsTail}`);
    },
  );
  assertFullParity(ps, ts, "ignore-input capture-error");
});

test("every scenario above produces identical ProcessResult key sets AND ORDER between implementations", { skip: SKIP_REASON }, async () => {
  const spec: OracleSpec = {
    command: "pwsh",
    arguments: ["-NoProfile", "-File", fixture("delayed-output.ps1")],
    workingDirectory: REPO_ROOT,
    timeoutSeconds: 10,
  };
  const psOutcome = runOracle(spec);
  const tsOutcome = await runTs(spec);
  assert.deepStrictEqual(Object.keys(tsOutcome.result!), Object.keys(psOutcome.result!));
});
