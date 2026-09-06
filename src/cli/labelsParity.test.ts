// ADR-0001 phase 7 exit criterion (ii), the last of its three commands: compares
// `pwsh -NoProfile -File hdo.ps1 labels -WhatIf -Json` and `... labels -Apply -WhatIf
// -Json` against their `node src/cli/main.ts` equivalents over a mock `gh`
// (`tests/fixtures/cli/gh/gh.cmd`) - no real GitHub, no network. `labels` never
// touches `git` beyond `resolveCliConfig`'s best-effort `git rev-parse
// --show-toplevel` (swallowed on failure) and `resolveRepositorySlug`'s remote-url
// fallback (never reached here - `-Repository` is always passed explicitly), so a
// plain temp directory is a sufficient `-RepositoryPath`.
//
// Two cases (phase 7 plan Q2):
//   1. `-WhatIf` alone (no `-Apply`, `Sync-HdoLabels`'s `$Apply -and
//      $PSCmdlet.ShouldProcess(...)` short-circuits on `$Apply` first) - byte-identical
//      to plain `labels -Json` on EACH side, then PS-vs-TS.
//   2. `-Apply -WhatIf` - one What-if line per label on stdout, every `applied:
//      false`, and the mock `gh` must never see a `label create` call (asserted via
//      the mock's own `exit /b 9` "unhandled arguments" fallback, which fires for any
//      command shape this fixture does not explicitly script for).
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_TS_PATH = resolve(HERE, "main.ts");
const HDO_PS1_PATH = resolve(REPO_ROOT, "hdo.ps1");
const CLI_GH_FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures", "cli", "gh");

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

const UNHANDLED_GH_MARKER = "mock gh: unhandled arguments";

function buildMockGhDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(CLI_GH_FIXTURES_ROOT, "gh.cmd"), join(dir, "gh.cmd"));
  copyFileSync(join(CLI_GH_FIXTURES_ROOT, "label-list.json"), join(dir, "label-list.json"));
}

function buildEnv(ghDir: string, tempHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(tempHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempHome, "AppData", "Local"),
    PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Asserts neither side's mock `gh` ever hit its `label create`-shaped fallback (the "must never see a `label create` call" requirement). */
function assertGhNeverCalledLabelCreate(result: ProcessResult, label: string): void {
  assert.ok(!result.stderr.includes(UNHANDLED_GH_MARKER), `${label}: mock gh hit its unhandled-arguments fallback (would fire for 'label create', which must never be called under -WhatIf).\nstderr: ${result.stderr}`);
}

test("labels parity: -WhatIf alone (no -Apply) is byte-identical to plain 'labels -Json'", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name
  // (doctorParity.test.ts / runParity.test.ts).
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-repo-")));
  const ghDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-gh-")));
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-home-")));
  try {
    buildMockGhDirectory(ghDir);
    const env = buildEnv(ghDir, tempHome);

    const baseArgs = ["labels", "-Repository", "hdo-fixture/repo", "-Json", "-RepositoryPath", repoDir];
    const psPlain = runPwsh(baseArgs, env);
    const psWhatIf = runPwsh([...baseArgs, "-WhatIf"], env);
    const tsPlain = runNode(baseArgs, env);
    const tsWhatIf = runNode([...baseArgs, "-WhatIf"], env);

    for (const [label, result] of [
      ["PS plain", psPlain],
      ["PS -WhatIf", psWhatIf],
      ["TS plain", tsPlain],
      ["TS -WhatIf", tsWhatIf],
    ] as const) {
      assertGhNeverCalledLabelCreate(result, label);
      assert.equal(result.exitCode, 0, `${label} exit code.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }

    // Oracle pin: PS's own documented short-circuit (`$Apply -and $PSCmdlet.
    // ShouldProcess(...)`, GitHub.ps1:712) - `-WhatIf` without `-Apply` never reaches
    // `ShouldProcess`, so PS's plain and `-WhatIf` runs must be byte-identical.
    assert.equal(psWhatIf.stdout, psPlain.stdout, "PS -WhatIf (no -Apply) must be byte-identical to plain 'labels -Json' (Q2 short-circuit pin)");
    // Same pin, TS side (src/github/labels.ts's `apply && whatIf` short-circuit).
    assert.equal(tsWhatIf.stdout, tsPlain.stdout, "TS -WhatIf (no -Apply) must be byte-identical to plain 'labels -Json'");

    const psValue = JSON.parse(psPlain.stdout) as Record<string, unknown>;
    const tsValue = JSON.parse(tsPlain.stdout) as Record<string, unknown>;
    assert.equal(psValue.apply, false, "PS apply pin");
    assert.deepStrictEqual(
      canonicalize(tsValue),
      canonicalize(psValue),
      `TS and PowerShell 'labels -Json' output differ.\nPS: ${JSON.stringify(psValue, null, 2)}\nTS: ${JSON.stringify(tsValue, null, 2)}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(ghDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("labels parity: -Apply -WhatIf previews every label, applies none, and never calls 'gh label create'", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name
  // (doctorParity.test.ts / runParity.test.ts).
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-repo-")));
  const ghDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-gh-")));
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-labels-parity-home-")));
  try {
    buildMockGhDirectory(ghDir);
    const env = buildEnv(ghDir, tempHome);

    const args = ["labels", "-Repository", "hdo-fixture/repo", "-Apply", "-WhatIf", "-Json", "-RepositoryPath", repoDir];
    const psResult = runPwsh(args, env);
    const tsResult = runNode(args, env);

    assertGhNeverCalledLabelCreate(psResult, "PS -Apply -WhatIf");
    assertGhNeverCalledLabelCreate(tsResult, "TS -Apply -WhatIf");

    assert.equal(psResult.exitCode, 0, `PS exit code.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
    assert.equal(tsResult.exitCode, 0, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

    // Split each stdout into its What-if preview lines (one per label) and the
    // trailing JSON object (mirrors runCleanupCommand's interleaving: `Sync-
    // HdoLabels`/`syncLabels` write one line per label via the ShouldProcess/
    // shouldProcessSink stream DURING the call, then `Write-HdoCliOutput` prints the
    // final JSON afterward).
    function splitPreviewAndJson(stdout: string): { previewLines: string[]; value: Record<string, unknown> } {
      const normalized = stdout.replace(/\r\n/g, "\n");
      const lines = normalized.split("\n").filter((line) => line.length > 0);
      const jsonStartIndex = lines.findIndex((line) => line.trim().startsWith("{"));
      assert.ok(jsonStartIndex >= 0, `stdout has no JSON object.\nstdout: ${JSON.stringify(stdout)}`);
      const previewLines = lines.slice(0, jsonStartIndex);
      const value = JSON.parse(lines.slice(jsonStartIndex).join("\n")) as Record<string, unknown>;
      return { previewLines, value };
    }

    const psSplit = splitPreviewAndJson(psResult.stdout);
    const tsSplit = splitPreviewAndJson(tsResult.stdout);

    // Oracle pin: PS's own documented What-if text (Q2), one line per label, ALL
    // labels (`Sync-HdoLabels` never skips a label under `-Apply -WhatIf`).
    const psValue = psSplit.value;
    const psLabels = psValue.labels as Array<{ name: string; applied: boolean }>;
    assert.ok(psLabels.length > 0, "PS labels list pin: must be non-empty (config/labels.json's static + dynamic catalog)");
    assert.equal(psSplit.previewLines.length, psLabels.length, `PS What-if line count must equal label count.\nlines: ${JSON.stringify(psSplit.previewLines)}\nlabels: ${JSON.stringify(psLabels)}`);
    for (let index = 0; index < psLabels.length; index++) {
      const expectedLine = `What if: Performing the operation "Create or update" on target "hdo-fixture/repo label '${psLabels[index].name}'".`;
      assert.equal(psSplit.previewLines[index], expectedLine, `PS What-if line ${index} pin.`);
      assert.equal(psLabels[index].applied, false, `PS labels[${index}].applied pin (must stay false under -WhatIf).`);
    }
    assert.equal(psValue.apply, true, "PS apply pin");

    // TS side: same line count, same per-line text, same `applied: false`.
    const tsValue = tsSplit.value;
    const tsLabels = tsValue.labels as Array<{ name: string; applied: boolean }>;
    assert.deepEqual(tsSplit.previewLines, psSplit.previewLines, `TS What-if lines differ from the PS-pinned expectation.\nPS: ${JSON.stringify(psSplit.previewLines)}\nTS: ${JSON.stringify(tsSplit.previewLines)}`);
    for (const label of tsLabels) {
      assert.equal(label.applied, false, `TS labels['${label.name}'].applied must stay false under -WhatIf.`);
    }

    assert.deepStrictEqual(
      canonicalize(tsValue),
      canonicalize(psValue),
      `TS and PowerShell 'labels -Apply -WhatIf -Json' JSON output differ.\nPS: ${JSON.stringify(psValue, null, 2)}\nTS: ${JSON.stringify(tsValue, null, 2)}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(ghDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
  }
});
