// ADR-0001 phase 5 plan §5(c): compares `node src/cli/main.ts doctor -DryRun -Json`
// against `pwsh -NoProfile -File hdo.ps1 doctor -DryRun -Json` (the oracle) - the
// `Test-HdoEnvironment -ReadOnly` half of the phase-5 "run -DryRun parity" exit
// criterion (the execution-plan half is already covered by configParity.test.ts).
// Both processes share `process.env` (only APPDATA/LOCALAPPDATA are redirected to a
// fresh temp directory, exactly like configParity.test.ts), so `gh auth status`,
// PATH, and ollama presence are IDENTICAL for both runs: CI machines with no
// claude/codex/ollama installed still get comparable `fail`/`skipped` rows on both
// sides. Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
//
// Non-DryRun `doctor` is intentionally NOT compared here (per the plan): it creates
// real probe files under `paths.worktreeRoot`/`paths.artifactRoot` and may run a real
// `ollama create`, neither of which this test wants to trigger twice (once per
// implementation) as a side effect of a parity check.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function runNode(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync(process.execPath, [MAIN_TS_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPwsh(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", HDO_PS1_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

/**
 * The ONE tolerated string difference (ADR-0001 phase 6, Issue #8 `gate:<id>` checks):
 * a resolved path whose file name is `pwsh.exe`. PowerShell prepends `$PSHOME` to its
 * own process PATH, so `Get-Command pwsh -CommandType Application` inside `hdo.ps1`
 * always resolves to the running pwsh itself (e.g. `C:\Program Files\WindowsApps\
 * Microsoft.PowerShell_<ver>\pwsh.exe` for a Store install), while the Node process
 * resolves `pwsh` through the ambient PATH (e.g. the `%LOCALAPPDATA%\Microsoft\
 * WindowsApps\pwsh.exe` app-execution alias). Both name the same binary; only the
 * spelling differs, and only for `pwsh`, and only on machines where `$PSHOME` is not
 * itself the first PATH hit (GitHub windows-latest resolves both to
 * `C:\Program Files\PowerShell\7\pwsh.exe`). Recorded in docs/architecture.md 16.4.
 */
function normalizePwshPath(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\<>:"|?*\r\n]+\\)*pwsh\.exe/gi, "<PWSH>");
}

/**
 * Recursively sorts object keys, for an order-independent comparison of object keys -
 * array element ORDER is always preserved (`Array.prototype.map` never reorders),
 * which matters for `checks`: ADR-0001 phase 5 plan §7 risk 5 says its order is
 * contractual, unlike every other array/object in this repository's config/state
 * JSON. String VALUES are compared verbatim, with no casing or separator
 * normalization (review round 2 should-fix 3): `windows.ts`'s `realCasing` (P-1) was
 * fixed specifically so TS reports the same ON-DISK casing PowerShell's own
 * `Get-Command` does, and lower-casing both sides here would silently hide any
 * regression of that fix instead of pinning it. Separators were checked too (a
 * `\\` -> `/` normalization was previously applied "just in case"): every string
 * value in a byte-identical `doctor -DryRun -Json` run (default profile,
 * `-IgnoreRepositoryConfig`, every `config/examples/*.json`, including
 * `ollama-lean-worker.json`) already matches PowerShell verbatim, backslashes
 * included, so there is no actual TS/PS divergence to tolerate here.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return normalizePwshPath(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function deleteCheckedAt(value: unknown): void {
  if (value && typeof value === "object" && "checkedAt" in value) {
    delete (value as Record<string, unknown>).checkedAt;
  }
}

interface ParityCase {
  name: string;
  args: string[];
}

const CASES: ParityCase[] = [
  { name: "default config (no -Config)", args: [] },
  { name: "-Config config/examples/cloud-only.json", args: ["-Config", "config/examples/cloud-only.json"] },
  { name: "-Config config/examples/ollama-hybrid.json", args: ["-Config", "config/examples/ollama-hybrid.json"] },
  { name: "-Config config/examples/claude-only.json", args: ["-Config", "config/examples/claude-only.json"] },
  { name: "-Config config/examples/ollama-lean-worker.json", args: ["-Config", "config/examples/ollama-lean-worker.json"] },
  { name: "-IgnoreRepositoryConfig", args: ["-IgnoreRepositoryConfig"] },
];

for (const parityCase of CASES) {
  test(`doctor parity: ${parityCase.name}`, { skip: SKIP_REASON, timeout: 60_000 }, () => {
    // A fresh temp dir per case: nothing this repository's real %APPDATA%/%LOCALAPPDATA%
    // holds should be able to leak into either process.
    const tempHome = mkdtempSync(join(tmpdir(), "hdo-doctor-parity-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(tempHome, "AppData", "Local"),
      };

      const args = ["doctor", "-DryRun", "-Json", ...parityCase.args, "-RepositoryPath", REPO_ROOT];
      const psResult = runPwsh(args, env);
      const tsResult = runNode(args, env);

      assert.equal(
        tsResult.exitCode,
        psResult.exitCode,
        `exit code differs for case '${parityCase.name}'.\nPS stdout: ${psResult.stdout}\nPS stderr: ${psResult.stderr}\nTS stdout: ${tsResult.stdout}\nTS stderr: ${tsResult.stderr}`,
      );
      assert.ok([0, 3].includes(psResult.exitCode), `expected PowerShell to exit 0 or 3 for case '${parityCase.name}'. PS stderr: ${psResult.stderr}`);

      const psValue: unknown = JSON.parse(psResult.stdout);
      const tsValue: unknown = JSON.parse(tsResult.stdout);
      deleteCheckedAt(psValue);
      deleteCheckedAt(tsValue);

      assert.deepStrictEqual(
        canonicalize(tsValue),
        canonicalize(psValue),
        `TS and PowerShell 'doctor -DryRun -Json' output differ for case '${parityCase.name}'.\nTS: ${JSON.stringify(tsValue, null, 2)}\nPS: ${JSON.stringify(psValue, null, 2)}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

interface NegativeParityCase {
  name: string;
  buildArgs: (overlayPath: string) => string[];
  overlay?: unknown;
  /** Overrides `-RepositoryPath REPO_ROOT`; used for the non-Git-repository case. */
  repositoryPath?: () => string;
}

const NEGATIVE_CASES: NegativeParityCase[] = [
  {
    name: "-Config overlay pointing a runner command at something unresolvable",
    buildArgs: (overlayPath) => ["-Config", overlayPath],
    overlay: { runners: { "claude-planner": { command: "hdo-command-that-does-not-exist" } } },
  },
  {
    name: "-RepositoryPath outside any Git repository",
    buildArgs: () => [],
    // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
    // `RUNNER~1`, and this path is compared verbatim inside the "Project contract was
    // not found: <path>" message on both sides (processParity.test.ts, runnersParity.test.ts
    // rely on the same expansion; review round 1 finding 10).
    repositoryPath: () => realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-doctor-parity-non-git-"))),
  },
];

for (const negativeCase of NEGATIVE_CASES) {
  test(`doctor parity (negative, both exit 3): ${negativeCase.name}`, { skip: SKIP_REASON, timeout: 60_000 }, () => {
    const tempHome = mkdtempSync(join(tmpdir(), "hdo-doctor-parity-neg-"));
    let extraDirToClean = "";
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(tempHome, "AppData", "Local"),
      };

      let overlayPath = "";
      if (negativeCase.overlay !== undefined) {
        overlayPath = join(tempHome, "overlay.json");
        writeFileSync(overlayPath, JSON.stringify(negativeCase.overlay), "utf8");
      }
      const repositoryPath = negativeCase.repositoryPath ? negativeCase.repositoryPath() : REPO_ROOT;
      if (negativeCase.repositoryPath) extraDirToClean = repositoryPath;

      const args = ["doctor", "-DryRun", "-Json", ...negativeCase.buildArgs(overlayPath), "-RepositoryPath", repositoryPath];
      const psResult = runPwsh(args, env);
      const tsResult = runNode(args, env);

      assert.equal(psResult.exitCode, 3, `expected PowerShell to exit 3. stdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
      assert.equal(tsResult.exitCode, 3, `expected TypeScript to exit 3. stdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

      const psValue: unknown = JSON.parse(psResult.stdout);
      const tsValue: unknown = JSON.parse(tsResult.stdout);
      deleteCheckedAt(psValue);
      deleteCheckedAt(tsValue);

      assert.deepStrictEqual(
        canonicalize(tsValue),
        canonicalize(psValue),
        `TS and PowerShell 'doctor -DryRun -Json' output differ for negative case '${negativeCase.name}'.\nTS: ${JSON.stringify(tsValue, null, 2)}\nPS: ${JSON.stringify(psValue, null, 2)}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
      if (extraDirToClean) rmSync(extraDirToClean, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
