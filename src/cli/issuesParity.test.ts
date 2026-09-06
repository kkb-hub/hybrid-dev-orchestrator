// ADR-0001 phase 7: `issues` is not one of the ADR's exit-criterion commands, but it
// is one of the four newly-wired-up commands (plan §0), so it gets parity coverage
// too. Compares `pwsh -NoProfile -File hdo.ps1 issues -Repository <slug> -Json`
// against `node src/cli/main.ts issues -Repository <slug> -Json` over a mock `gh`
// (`tests/fixtures/cli/gh/gh.cmd`) - no real GitHub, no network. `issues` never
// touches `git` beyond `resolveCliConfig`'s best-effort `git rev-parse
// --show-toplevel` (swallowed on failure), so a plain temp directory is a sufficient
// `-RepositoryPath`.
//
// Two cases: a non-empty candidate list (`tests/fixtures/cli/gh/issue-list.json`,
// three ready Issues with distinct priority/createdAt so `priorityRank` is
// non-trivial - comparing ordering and `priorityRank`, not just set membership) and
// an empty one (both sides must exit 4 - hdo.ps1:82 / phase 7 plan Q4).
//
// NOTE on ordering (R1-1, found while writing this test and fixed in the same change):
// `Get-HdoIssueCandidate`'s final `Sort-Object @{Expression='priorityRank';...},
// @{...}, @{...}` (GitHub.ps1, at the end of the function) silently did NOT reorder
// its input when the candidates are `[ordered]` dictionaries (which
// `ConvertTo-HdoHashtable`, GitHub.ps1's own JSON decoder, always produces) -
// PowerShell's calculated-property `Sort-Object` binds against `Hashtable`/
// `PSCustomObject` but not `OrderedDictionary`, so `hdo.ps1 issues` used to return
// candidates in whatever order `gh issue list` returned them, never re-sorted by
// priority/createdAt/number. `src/github/issues.ts`'s `getIssueCandidate` (the TS
// port) has always sorted correctly (`Array.prototype.sort`). The fix switches the
// PS Sort-Object to script-block Expressions, which DO evaluate against an
// OrderedDictionary; see the comment on that return statement.
//
// `issue-list.json` is deliberately kept UNSORTED (101, 102, 103 in the fixture file,
// not priority/createdAt order) specifically so this test exercises a genuine
// re-order on both sides rather than merely confirming a no-op pass-through matches
// an already-sorted input. `tests/run-tests.ps1` carries a lower-level regression
// assertion for the same fix, built from this same fixture data.
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_TS_PATH = resolve(HERE, "main.ts");
const HDO_PS1_PATH = resolve(REPO_ROOT, "hdo.ps1");
const CLI_GH_FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures", "cli", "gh");
const WORKFLOW_GH_FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures", "workflow", "gh");

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

/**
 * Per-test mock `gh` PATH directory: `gh.cmd` plus `issue-list.json` from
 * `tests/fixtures/cli/gh`, and `issue-events.json`/`issue-comments.json`/
 * `graphql-last-edited.json` copied in as DATA from `tests/fixtures/workflow/gh`
 * (phase 7 plan §5) - `getIssueCandidate` runs the same ready-label-authorization and
 * claim-comment checks `run`/`issues.ts` already exercise for every non-excluded
 * candidate.
 */
function buildMockGhDirectory(dir: string, issueListPath: string): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(CLI_GH_FIXTURES_ROOT, "gh.cmd"), join(dir, "gh.cmd"));
  copyFileSync(join(WORKFLOW_GH_FIXTURES_ROOT, "issue-events.json"), join(dir, "issue-events.json"));
  copyFileSync(join(WORKFLOW_GH_FIXTURES_ROOT, "issue-comments.json"), join(dir, "issue-comments.json"));
  copyFileSync(join(WORKFLOW_GH_FIXTURES_ROOT, "graphql-last-edited.json"), join(dir, "graphql-last-edited.json"));
  copyFileSync(issueListPath, join(dir, "issue-list.json"));
}

/** `issues` (`getIssueCandidate`) loads a project contract for every candidate's gate-id check (GitHub.ps1:422); reuse the workflow fixture's, whose only gate id is `gate-pass` (matching `issue-list.json`'s bodies). */
function writeProjectContract(repoDir: string): void {
  mkdirSync(join(repoDir, ".hdo"), { recursive: true });
  copyFileSync(join(WORKFLOW_GH_FIXTURES_ROOT, "..", "project.json"), join(repoDir, ".hdo", "project.json"));
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

test("issues parity: non-empty candidate list - ordering and priorityRank match", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name
  // (doctorParity.test.ts / runParity.test.ts).
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-repo-")));
  const ghDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-gh-")));
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-home-")));
  try {
    buildMockGhDirectory(ghDir, join(CLI_GH_FIXTURES_ROOT, "issue-list.json"));
    writeProjectContract(repoDir);
    const env = buildEnv(ghDir, tempHome);

    const args = ["issues", "-Repository", "hdo-fixture/repo", "-Json", "-RepositoryPath", repoDir];
    const psResult = runPwsh(args, env);
    const tsResult = runNode(args, env);

    assert.ok(!psResult.stderr.includes(UNHANDLED_GH_MARKER), `PS hit the mock gh's unhandled-arguments branch.\nstderr: ${psResult.stderr}`);
    assert.ok(!tsResult.stderr.includes(UNHANDLED_GH_MARKER), `TS hit the mock gh's unhandled-arguments branch.\nstderr: ${tsResult.stderr}`);

    assert.equal(psResult.exitCode, 0, `PS exit code.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
    assert.equal(tsResult.exitCode, 0, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

    const psValue = JSON.parse(psResult.stdout) as Array<Record<string, unknown>>;
    const tsValue = JSON.parse(tsResult.stdout) as Array<Record<string, unknown>>;

    // Oracle pin: fixture `issue-list.json` is listed in [101, 102, 103] order (see
    // the file header note - deliberately unsorted) but the candidate order both
    // sides must produce is [103, 102, 101] with priorityRank [1, 1, 3] (github.
    // priorityOrder's default 4-tier list: p0=0, p1=1, p2=2, p3=3), i.e. 103 and 102
    // (both priorityRank 1) ordered by createdAt ascending, then 101 (priorityRank 3)
    // last.
    const psNumbers = psValue.map((candidate) => candidate.number);
    const psRanks = psValue.map((candidate) => candidate.priorityRank);
    assert.deepEqual(psNumbers, [103, 102, 101], `PS candidate order pin. Got: ${JSON.stringify(psNumbers)}`);
    assert.deepEqual(psRanks, [1, 1, 3], `PS priorityRank pin. Got: ${JSON.stringify(psRanks)}`);

    const tsNumbers = tsValue.map((candidate) => candidate.number);
    const tsRanks = tsValue.map((candidate) => candidate.priorityRank);
    assert.deepEqual(tsNumbers, [103, 102, 101], `TS candidate order differs from the PS-pinned expectation. Got: ${JSON.stringify(tsNumbers)}`);
    assert.deepEqual(tsRanks, [1, 1, 3], `TS priorityRank differs from the PS-pinned expectation. Got: ${JSON.stringify(tsRanks)}`);

    assert.deepStrictEqual(
      canonicalize(tsValue),
      canonicalize(psValue),
      `TS and PowerShell 'issues -Json' output differ.\nPS: ${JSON.stringify(psValue, null, 2)}\nTS: ${JSON.stringify(tsValue, null, 2)}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(ghDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("issues parity: empty candidate list - both sides exit 4 (hdo.ps1:82)", { skip: SKIP_REASON, timeout: 60_000 }, () => {
  // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
  // `RUNNER~1`, but PowerShell's own path expansion always yields the long name
  // (doctorParity.test.ts / runParity.test.ts).
  const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-repo-")));
  const ghDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-gh-")));
  const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-issues-parity-home-")));
  try {
    const emptyListPath = join(tempHome, "issue-list-empty.json");
    writeFileSync(emptyListPath, "[]", "utf8");
    buildMockGhDirectory(ghDir, emptyListPath);
    writeProjectContract(repoDir);
    const env = buildEnv(ghDir, tempHome);

    const args = ["issues", "-Repository", "hdo-fixture/repo", "-Json", "-RepositoryPath", repoDir];
    const psResult = runPwsh(args, env);
    const tsResult = runNode(args, env);

    assert.ok(!psResult.stderr.includes(UNHANDLED_GH_MARKER), `PS hit the mock gh's unhandled-arguments branch.\nstderr: ${psResult.stderr}`);
    assert.ok(!tsResult.stderr.includes(UNHANDLED_GH_MARKER), `TS hit the mock gh's unhandled-arguments branch.\nstderr: ${tsResult.stderr}`);

    // Oracle pin: hdo.ps1:82, "if ($candidates.Count -eq 0) { exit 4 }".
    assert.equal(psResult.exitCode, 4, `PS exit code pin.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
    assert.equal(tsResult.exitCode, 4, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

    // Oracle pin (a genuine, pre-existing PS quirk found while writing this test -
    // see the task report): `Write-HdoCliOutput`'s `$Value | ConvertTo-Json` pipes
    // `$candidates` through the PowerShell pipeline, which unwraps a zero-element
    // array into zero pipeline objects - `ConvertTo-Json` then receives nothing and
    // emits nothing, so PS stdout is EMPTY (not the literal `[]` a direct
    // `ConvertTo-Json -InputObject @()` would produce). `Write-HdoCliOutput` is
    // shared by every JSON-emitting command, but only `issues` can produce a
    // genuinely empty top-level array in practice, so this is the one place the
    // quirk is externally observable. `main.ts` always emits the literal `[]` via
    // `JSON.stringify`, so TS/PS output text intentionally differs here even though
    // both exit 4 identically.
    assert.equal(psResult.stdout.trim(), "", "PS empty-candidates stdout pin (ConvertTo-Json's pipeline-unwrap quirk)");
    const tsValue = JSON.parse(tsResult.stdout) as unknown[];
    assert.deepEqual(tsValue, [], "TS empty candidate array");
  } finally {
    rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(ghDir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
  }
});
