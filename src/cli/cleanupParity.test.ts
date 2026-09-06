// ADR-0001 phase 7 exit criterion (ii), and the most involved of the three: compares
// `pwsh -NoProfile -File hdo.ps1 cleanup -RunId <id> -WhatIf -Json` against
// `node src/cli/main.ts cleanup -RunId <id> -WhatIf -Json` (phase 7 plan Q1, WP-C/
// WP-F) for five scenarios, each built from a REAL temporary Git repository (no
// mocking - mirrors `src/workflow/cleanup.test.ts`'s style), with two independent,
// byte-identical fixture setups (one per implementation, mirroring `runParity.test.
// ts`'s `setupSide`). For every scenario this asserts stdout, stderr, exit code, AND
// that the worktree directory and `run.json` are BYTE-IDENTICAL before and after the
// invocation (all five scenarios are non-mutating: a `-WhatIf` preview or an early
// refusal) - on EACH side independently, since the two sides are independent
// directory trees.
//
// PowerShell decorates a thrown error with `Write-Error: ` framing and ANSI colour
// codes on stderr; this strips exactly that decoration (configParity.test.ts's
// `stripPsStderrDecoration`) and then replaces each side's own (independent) temp
// root with a shared `<TEMP>` token before comparing PS's message text against TS's -
// comparing the underlying MESSAGE, not PowerShell's console framing, while still
// requiring the actual message text to match verbatim (a genuine text difference is
// never papered over).
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/** Same decoration-strip as configParity.test.ts's NEGATIVE_CASES. */
function stripPsStderrDecoration(stderr: string): string {
  return stderr.replace(ANSI_ESCAPE_PATTERN, "").replace(/^(Write-Error: |hdo\.ps1: )/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every spelling (either path separator, either case) of `tempRoot` with
 * `<TEMP>`, mirroring runParity.test.ts's `tempRootPattern`. Also normalizes CRLF to
 * LF: PowerShell's console host writes the `ShouldProcess`/`-WhatIf` preview line
 * (and PowerShell's own `Write-Error`) with `\r\n` line endings on Windows, while
 * Node's `process.stdout.write`/`console.error` write bare `\n` - a tolerated
 * formatting difference, like `normalizePwshPath` elsewhere, not a real text
 * difference.
 */
function replaceTempRoot(text: string, tempRoot: string): string {
  const pattern = new RegExp(tempRoot.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]"), "gi");
  return text.replace(pattern, "<TEMP>").replace(/\\/g, "/").replace(/\r\n/g, "\n");
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGit(["init", "-q"], dir);
  runGit(["config", "user.email", "hdo-tests@example.invalid"], dir);
  runGit(["config", "user.name", "HDO Tests"], dir);
  runGit(["config", "commit.gpgSign", "false"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  runGit(["add", "-A"], dir);
  runGit(["commit", "-q", "-m", "baseline"], dir);
}

function headCommit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function addWorktree(repoDir: string, worktreePath: string, branch: string): void {
  runGit(["worktree", "add", "-b", branch, worktreePath, headCommit(repoDir)], repoDir);
}

/** Sorted `{relPath, content}` snapshot of every file under `dir` (recursive), or `null` if `dir` does not exist. */
function snapshotDir(dir: string): Array<{ relPath: string; content: string }> | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const files: Array<{ relPath: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    const fullPath = join(parentDir, entry.name);
    const relPath = fullPath.slice(dir.length).replace(/\\/g, "/");
    files.push({ relPath, content: readFileSync(fullPath, "utf8") });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function assertUnchanged(before: unknown, after: unknown, label: string): void {
  assert.deepStrictEqual(after, before, `${label}: on-disk state changed when it must not have.`);
}

interface RunFixture {
  worktreePath: string;
  branch: string;
}

interface SideSetup {
  tempRoot: string;
  repoDir: string;
  worktreeRoot: string;
  artifactRoot: string;
  overlayPath: string;
  env: NodeJS.ProcessEnv;
  worktreePath: string;
}

const RUN_ID = "issue-9-cleanup-fixture";
const BRANCH = `hdo/${RUN_ID}`;

type ScenarioSetup = (side: SideSetup) => void;

/** Writes `run.json` for `side`, with `worktree.path`/`worktree.branch` from `fixture`. */
function writeRunJson(side: SideSetup, fixture: RunFixture): void {
  mkdirSync(join(side.artifactRoot, RUN_ID), { recursive: true });
  const run = {
    schemaVersion: 1,
    id: RUN_ID,
    state: "APPROVED",
    worktree: { path: fixture.worktreePath, branch: fixture.branch },
  };
  writeFileSync(join(side.artifactRoot, RUN_ID, "run.json"), JSON.stringify(run, null, 2), "utf8");
}

interface Scenario {
  id: string;
  name: string;
  setup: ScenarioSetup;
  expectExitCode: number;
  /**
   * Builds the expected stdout (after temp-root canonicalisation), given the
   * (per-side) worktreePath text already replaced with `<WORKTREE>`. Only for the
   * PLAIN-TEXT stdout scenario (`writeHostLine`'s What-if line + the literal `null`
   * `main.ts` prints for an `undefined` result) - NOT valid for a JSON-object stdout
   * scenario, whose Windows path backslashes are JSON-escaped (doubled) and so
   * cannot be matched by this raw-text, single-backslash-aware regex replace (see
   * `expectJsonStdout` for that shape instead).
   */
  expectStdout?: string;
  /** For the `already-missing` scenario: the expected parsed JSON object, structurally, with `worktreePath` substituted verbatim (no text canonicalisation needed - it is compared as a real value, not matched against escaped JSON text). */
  expectJsonStdout?: (worktreePath: string) => unknown;
  /** Builds the expected stderr message (after decoration-strip + temp-root canonicalisation), given `<WORKTREE>` for the worktree path. */
  expectStderr?: string;
  /** Whether the worktree directory is expected to exist before the call (and must still exist, unchanged, after). */
  worktreeExists: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: "whatif-clean-listed",
    name: "-WhatIf on a clean, git-listed worktree",
    worktreeExists: true,
    expectExitCode: 0,
    expectStdout: 'What if: Performing the operation "Remove HDO Git worktree" on target "<WORKTREE>".\nnull\n',
    setup: (side) => {
      addWorktree(side.repoDir, side.worktreePath, BRANCH);
      writeRunJson(side, { worktreePath: side.worktreePath, branch: BRANCH });
    },
  },
  {
    id: "already-missing",
    name: "a run whose worktree directory is already gone",
    worktreeExists: false,
    expectExitCode: 0,
    expectJsonStdout: (worktreePath) => ({ runId: RUN_ID, removed: false, reason: "already-missing", path: worktreePath }),
    setup: (side) => {
      writeRunJson(side, { worktreePath: side.worktreePath, branch: BRANCH });
    },
  },
  {
    id: "outside-root",
    name: "a worktree path outside the configured worktreeRoot",
    worktreeExists: false,
    expectExitCode: 2,
    expectStderr: "Refusing cleanup because worktree is outside configured root: <WORKTREE>",
    setup: (side) => {
      // `side.worktreePath` is overridden to a path OUTSIDE worktreeRoot for this
      // scenario - see the special-cased assignment in the test loop below.
      writeRunJson(side, { worktreePath: side.worktreePath, branch: BRANCH });
    },
  },
  {
    id: "not-listed-not-orphan",
    name: "a directory Git does not list as a worktree and is not an orphan",
    worktreeExists: true,
    expectExitCode: 2,
    expectStderr: "Refusing cleanup because Git does not list the target as a worktree: <WORKTREE>",
    setup: (side) => {
      mkdirSync(side.worktreePath, { recursive: true });
      writeFileSync(join(side.worktreePath, "stray.txt"), "not a real worktree", "utf8");
      // Empty branch: isOrphanedWorktree/Test-HdoOrphanedWorktree both require a
      // non-empty branch that resolves via `git show-ref`, so this can never look
      // orphaned.
      writeRunJson(side, { worktreePath: side.worktreePath, branch: "" });
    },
  },
  {
    id: "dirty-without-force",
    name: "a dirty worktree without -Force",
    worktreeExists: true,
    expectExitCode: 2,
    expectStderr: "Worktree has uncommitted changes. Re-run with -Force only after preserving the diff: <WORKTREE>",
    setup: (side) => {
      addWorktree(side.repoDir, side.worktreePath, BRANCH);
      writeFileSync(join(side.worktreePath, "README.md"), "dirty\n", "utf8");
      writeRunJson(side, { worktreePath: side.worktreePath, branch: BRANCH });
    },
  },
];

function setupSide(scenarioId: string, label: string): SideSetup {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name, so
  // this side's `tempRoot` (used to strip its own path out of compared output) must
  // already be long-form (doctorParity.test.ts / runParity.test.ts).
  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `hdo-cleanup-parity-${scenarioId}-${label}-`)));
  const repoDir = join(tempRoot, "repo");
  const worktreeRoot = join(tempRoot, "worktrees");
  const artifactRoot = join(tempRoot, "runs");
  const overlayPath = join(tempRoot, "overlay.json");
  initRepo(repoDir);
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(overlayPath, JSON.stringify({ paths: { worktreeRoot, artifactRoot } }), "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(tempRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempRoot, "AppData", "Local"),
  };

  const worktreePath =
    scenarioId === "outside-root" ? join(tempRoot, "outside-worktree-root", RUN_ID) : join(worktreeRoot, RUN_ID);

  return { tempRoot, repoDir, worktreeRoot, artifactRoot, overlayPath, env, worktreePath };
}

for (const scenario of SCENARIOS) {
  test(`cleanup parity: ${scenario.name}`, { skip: SKIP_REASON, timeout: 60_000 }, () => {
    const psSide = setupSide(scenario.id, "ps");
    const tsSide = setupSide(scenario.id, "ts");
    try {
      scenario.setup(psSide);
      scenario.setup(tsSide);

      const beforeRunJsonPs = readFileSync(join(psSide.artifactRoot, RUN_ID, "run.json"), "utf8");
      const beforeRunJsonTs = readFileSync(join(tsSide.artifactRoot, RUN_ID, "run.json"), "utf8");
      const beforeWorktreePs = snapshotDir(psSide.worktreePath);
      const beforeWorktreeTs = snapshotDir(tsSide.worktreePath);
      assert.equal(beforeWorktreePs !== null, scenario.worktreeExists, `scenario ${scenario.id}: PS fixture worktree existence setup`);
      assert.equal(beforeWorktreeTs !== null, scenario.worktreeExists, `scenario ${scenario.id}: TS fixture worktree existence setup`);

      const psArgs = ["cleanup", "-RunId", RUN_ID, "-WhatIf", "-Json", "-RepositoryPath", psSide.repoDir, "-Config", psSide.overlayPath];
      const tsArgs = ["cleanup", "-RunId", RUN_ID, "-WhatIf", "-Json", "-RepositoryPath", tsSide.repoDir, "-Config", tsSide.overlayPath];
      const psResult = runPwsh(psArgs, psSide.env);
      const tsResult = runNode(tsArgs, tsSide.env);

      // Oracle pin: PS's exit code must match what the plan (Git.ps1's exact
      // control flow) says this scenario produces.
      assert.equal(psResult.exitCode, scenario.expectExitCode, `scenario ${scenario.id}: PS exit code pin.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
      assert.equal(tsResult.exitCode, scenario.expectExitCode, `scenario ${scenario.id}: TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

      if (scenario.expectStdout) {
        const expectedPs = scenario.expectStdout.replaceAll("<WORKTREE>", replaceTempRoot(psSide.worktreePath, psSide.tempRoot));
        const expectedTs = scenario.expectStdout.replaceAll("<WORKTREE>", replaceTempRoot(tsSide.worktreePath, tsSide.tempRoot));
        const psStdout = replaceTempRoot(psResult.stdout, psSide.tempRoot);
        const tsStdout = replaceTempRoot(tsResult.stdout, tsSide.tempRoot);
        assert.equal(psStdout, expectedPs, `scenario ${scenario.id}: PS stdout pin.\nGot: ${JSON.stringify(psResult.stdout)}`);
        assert.equal(tsStdout, expectedTs, `scenario ${scenario.id}: TS stdout differs from the PS-pinned expectation.\nGot: ${JSON.stringify(tsResult.stdout)}`);
        assert.equal(tsStdout, psStdout, `scenario ${scenario.id}: TS stdout (canonicalised) differs from PS stdout (canonicalised).`);
      }

      if (scenario.expectJsonStdout) {
        const expectedPs = scenario.expectJsonStdout(psSide.worktreePath);
        const expectedTs = scenario.expectJsonStdout(tsSide.worktreePath);
        const psValue = JSON.parse(psResult.stdout) as unknown;
        const tsValue = JSON.parse(tsResult.stdout) as unknown;
        assert.deepEqual(psValue, expectedPs, `scenario ${scenario.id}: PS JSON stdout pin.\nGot: ${JSON.stringify(psValue, null, 2)}`);
        assert.deepEqual(tsValue, expectedTs, `scenario ${scenario.id}: TS JSON stdout differs from the PS-pinned expectation.\nGot: ${JSON.stringify(tsValue, null, 2)}`);
      }

      if (scenario.expectStderr) {
        const expectedPs = scenario.expectStderr.replaceAll("<WORKTREE>", replaceTempRoot(psSide.worktreePath, psSide.tempRoot));
        const expectedTs = scenario.expectStderr.replaceAll("<WORKTREE>", replaceTempRoot(tsSide.worktreePath, tsSide.tempRoot));
        const psStderr = replaceTempRoot(stripPsStderrDecoration(psResult.stderr).trim(), psSide.tempRoot);
        const tsStderr = replaceTempRoot(tsResult.stderr.trim(), tsSide.tempRoot);
        assert.equal(psStderr, expectedPs, `scenario ${scenario.id}: PS stderr pin.\nGot: ${JSON.stringify(psStderr)}\nRaw: ${JSON.stringify(psResult.stderr)}`);
        assert.equal(tsStderr, expectedTs, `scenario ${scenario.id}: TS stderr differs from the PS-pinned expectation.\nGot: ${JSON.stringify(tsStderr)}`);
        assert.equal(tsStderr, psStderr, `scenario ${scenario.id}: TS stderr (canonicalised) differs from PS stderr (canonicalised).`);
      }

      // Nothing was mutated: run.json and the worktree directory (when present) are
      // byte-identical before and after, on EACH side independently.
      const afterRunJsonPs = readFileSync(join(psSide.artifactRoot, RUN_ID, "run.json"), "utf8");
      const afterRunJsonTs = readFileSync(join(tsSide.artifactRoot, RUN_ID, "run.json"), "utf8");
      assertUnchanged(beforeRunJsonPs, afterRunJsonPs, `scenario ${scenario.id}: PS run.json`);
      assertUnchanged(beforeRunJsonTs, afterRunJsonTs, `scenario ${scenario.id}: TS run.json`);

      const afterWorktreePs = snapshotDir(psSide.worktreePath);
      const afterWorktreeTs = snapshotDir(tsSide.worktreePath);
      assertUnchanged(beforeWorktreePs, afterWorktreePs, `scenario ${scenario.id}: PS worktree directory`);
      assertUnchanged(beforeWorktreeTs, afterWorktreeTs, `scenario ${scenario.id}: TS worktree directory`);
    } finally {
      // `git worktree add` registers worktrees in `<repo>/.git/worktrees/*`; clean
      // those up too so a leftover admin entry never confuses a later `git worktree
      // list` on the same machine (not that any later test reuses these repos, but
      // matches cleanup.test.ts's own finally-block discipline).
      try {
        runGit(["worktree", "remove", "--force", psSide.worktreePath], psSide.repoDir);
      } catch {
        // best effort
      }
      try {
        runGit(["worktree", "remove", "--force", tsSide.worktreePath], tsSide.repoDir);
      } catch {
        // best effort
      }
      rmSync(psSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
      rmSync(tsSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
