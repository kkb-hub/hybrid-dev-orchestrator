// ADR-0001 phase 7 exit criterion (ii), first of its three commands: compares
// `pwsh -NoProfile -File hdo.ps1 status -RunId <id> -Json` against `node src/cli/
// main.ts status -RunId <id> -Json` against a shared fixture `run.json` (phase 7 plan
// WP-F). `status` never touches `git`/`gh` (`readRun`, `src/workflow/runStore.ts`, is
// a plain file read once `paths.artifactRoot` is resolved), so a plain temp directory
// (no `git init`, no mock `gh`) is sufficient - only `paths.artifactRoot` needs to be
// pointed at a fixture-controlled directory, via a minimal `-Config` overlay (the
// same technique `runParity.test.ts`/`cleanup.test.ts` use).
//
// Two cases: an existing run artifact (`run.json` deep-equal after canonicalisation)
// and a missing run id (both sides must fail the same way - `Read-HdoJsonFile`/
// `readJsonObjectFile`'s identical "JSON file was not found: <path>" text, compared
// after stripping PowerShell's `Write-Error:`/ANSI decoration exactly like
// `configParity.test.ts`'s negative cases, and after replacing each side's own
// (independent) temp artifactRoot with a shared placeholder token).
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_TS_PATH = resolve(HERE, "main.ts");
const HDO_PS1_PATH = resolve(REPO_ROOT, "hdo.ps1");

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CHILD_TIMEOUT_MS = 60_000;

function assertChildCompleted(result: SpawnSyncReturns<string>, label: string): void {
  assert.equal(result.error, undefined, `${label}: spawnSync reported an error.\nerror: ${String(result.error)}`);
  assert.equal(result.signal, null, `${label}: child process was terminated by signal ${String(result.signal)}.`);
}

function runNode(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync(process.execPath, [MAIN_TS_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assertChildCompleted(result, `runNode ${args.join(" ")}`);
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPwsh(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", HDO_PS1_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assertChildCompleted(result, `runPwsh ${args.join(" ")}`);
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

function normalizePwshPath(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\<>:"|?*\r\n]+\\)*pwsh\.exe/gi, "<PWSH>");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "string") return normalizePwshPath(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/** Same decoration-strip as configParity.test.ts's NEGATIVE_CASES. */
function stripPsStderrDecoration(stderr: string): string {
  return stderr.replace(ANSI_ESCAPE_PATTERN, "").replace(/^(Write-Error: |hdo\.ps1: )/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces every spelling (either path separator, either case) of `tempRoot` with `<TEMP>`, mirroring runParity.test.ts's `tempRootPattern`. */
function replaceTempRoot(text: string, tempRoot: string): string {
  const pattern = new RegExp(tempRoot.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]"), "gi");
  return text.replace(pattern, "<TEMP>").replace(/\\/g, "/");
}

const RUN_ID = "issue-42-run-fixture";

const FIXTURE_RUN = {
  schemaVersion: 1,
  id: RUN_ID,
  state: "APPROVED",
  iteration: 1,
  issue: { repository: "hdo-fixture/repo", number: 42, title: "Fixture run" },
  worktree: { path: "irrelevant-for-status", branch: "hdo/issue-42-run-fixture" },
  github: { claim: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
};

interface SideSetup {
  tempRoot: string;
  repoDir: string;
  artifactRoot: string;
  overlayPath: string;
  env: NodeJS.ProcessEnv;
}

function setupSide(label: string, withRun: boolean): SideSetup {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name, so
  // this side's `tempRoot` (used to strip its own path out of compared output) must
  // already be long-form (doctorParity.test.ts / runParity.test.ts).
  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `hdo-status-parity-${label}-`)));
  const repoDir = join(tempRoot, "repo");
  const artifactRoot = join(tempRoot, "runs");
  const overlayPath = join(tempRoot, "overlay.json");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  if (withRun) {
    mkdirSync(join(artifactRoot, RUN_ID), { recursive: true });
    writeFileSync(join(artifactRoot, RUN_ID, "run.json"), JSON.stringify(FIXTURE_RUN, null, 2), "utf8");
  }
  writeFileSync(overlayPath, JSON.stringify({ paths: { artifactRoot } }), "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(tempRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempRoot, "AppData", "Local"),
  };
  return { tempRoot, repoDir, artifactRoot, overlayPath, env };
}

test("status parity: existing run artifact", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  const psSide = setupSide("ps", true);
  const tsSide = setupSide("ts", true);
  try {
    const psArgs = ["status", "-RunId", RUN_ID, "-Json", "-RepositoryPath", psSide.repoDir, "-Config", psSide.overlayPath];
    const tsArgs = ["status", "-RunId", RUN_ID, "-Json", "-RepositoryPath", tsSide.repoDir, "-Config", tsSide.overlayPath];
    const psResult = runPwsh(psArgs, psSide.env);
    const tsResult = runNode(tsArgs, tsSide.env);

    assert.equal(psResult.exitCode, 0, `PS exit code.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
    assert.equal(tsResult.exitCode, 0, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

    const psValue = JSON.parse(psResult.stdout) as Record<string, unknown>;
    const tsValue = JSON.parse(tsResult.stdout) as Record<string, unknown>;

    // Oracle pin: PS must read back exactly the fixture written to disk.
    assert.deepEqual(canonicalize(psValue), canonicalize(FIXTURE_RUN), `PS status output must equal the fixture run.json verbatim.\nPS: ${JSON.stringify(psValue, null, 2)}`);

    assert.deepStrictEqual(
      canonicalize(tsValue),
      canonicalize(psValue),
      `TS and PowerShell 'status -Json' output differ.\nPS: ${JSON.stringify(psValue, null, 2)}\nTS: ${JSON.stringify(tsValue, null, 2)}`,
    );
  } finally {
    rmSync(psSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tsSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("status parity: missing run id - both sides fail the same way", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  const psSide = setupSide("ps", false);
  const tsSide = setupSide("ts", false);
  try {
    const psArgs = ["status", "-RunId", RUN_ID, "-Json", "-RepositoryPath", psSide.repoDir, "-Config", psSide.overlayPath];
    const tsArgs = ["status", "-RunId", RUN_ID, "-Json", "-RepositoryPath", tsSide.repoDir, "-Config", tsSide.overlayPath];
    const psResult = runPwsh(psArgs, psSide.env);
    const tsResult = runNode(tsArgs, tsSide.env);

    // Oracle pin: Read-HdoJsonFile/readJsonObjectFile's exact "JSON file was not
    // found: <path>" text (Common.ps1:499 / runStore.ts) - not a generic failure.
    const psStripped = replaceTempRoot(stripPsStderrDecoration(psResult.stderr).trim(), psSide.tempRoot);
    const tsStripped = replaceTempRoot(tsResult.stderr.trim(), tsSide.tempRoot);

    assert.equal(psResult.exitCode, 2, `PS exit code pin.\nstderr: ${psResult.stderr}`);
    assert.ok(psStripped.startsWith("JSON file was not found: "), `PS stderr pin.\nGot: ${JSON.stringify(psStripped)}`);
    assert.ok(psStripped.includes("<TEMP>/runs/") && psStripped.endsWith(`${RUN_ID}/run.json`), `PS stderr path pin.\nGot: ${JSON.stringify(psStripped)}`);

    assert.equal(tsResult.exitCode, 2, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);
    assert.equal(tsStripped, psStripped, `TS stderr (after temp-root canonicalisation) differs from the PS-pinned text.\nPS: ${JSON.stringify(psStripped)}\nTS: ${JSON.stringify(tsStripped)}`);
  } finally {
    rmSync(psSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tsSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});
