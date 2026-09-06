// ADR-0001 phase 7 exit criterion (i), the last of its four commands: compares
// `pwsh -NoProfile -File hdo.ps1 inspect -Issue <n> -Repository <slug> -Json` against
// `node src/cli/main.ts inspect -Issue <n> -Repository <slug> -Json` over a mock `gh`
// (`tests/fixtures/cli/gh/gh.cmd`) - no real GitHub, no network. `inspect` never
// touches `git` beyond `resolveCliConfig`'s best-effort `git rev-parse
// --show-toplevel` (swallowed into `isGitRepository = false` on failure), so a plain
// temp directory (no `git init`) is a sufficient `-RepositoryPath`.
//
// Two cases: a ready, contract-valid Issue (`validation.valid === true`), and an
// Issue missing the ready label (`validation.valid === false`, comparing the
// `validation.errors` array, not just the happy path) - per the WP-F brief. Both
// cases pin the PowerShell oracle against the known-correct value FIRST (Test-
// HdoIssueContract's exact error text), then compare PS against TS, so a
// coincidentally-matching pair of equally-broken implementations cannot pass.
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

/** Same tolerated divergence as doctorParity/runParity: `$PSHOME`-resolved `pwsh.exe`. */
function normalizePwshPath(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\<>:"|?*\r\n]+\\)*pwsh\.exe/gi, "<PWSH>");
}

const DROP_KEYS = new Set(["capturedAt"]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "string") return normalizePwshPath(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const UNHANDLED_GH_MARKER = "mock gh: unhandled arguments";

/** Per-test mock `gh` PATH directory: `gh.cmd` from `tests/fixtures/cli/gh`, plus a scenario-specific `issue-view.json` (`inspect` only ever calls `gh issue view`). */
function buildMockGhDirectory(dir: string, issueView: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(CLI_GH_FIXTURES_ROOT, "gh.cmd"), join(dir, "gh.cmd"));
  writeFileSync(join(dir, "issue-view.json"), JSON.stringify(issueView), "utf8");
}

function issueViewFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 7,
    title: "Fixture: deterministic HDO inspect Issue",
    body: [
      "## Problem / Context",
      "",
      "Context text.",
      "",
      "## Goal",
      "",
      "Goal text.",
      "",
      "## In scope",
      "",
      "- included",
      "",
      "## Out of scope",
      "",
      "- excluded",
      "",
      "## Acceptance Criteria",
      "",
      "- AC-01: first",
      "",
      "## Validation Gate IDs",
      "",
      "- gate-pass",
      "",
      "## Constraints",
      "",
      "- Do not require network access.",
      "",
      "## Dependencies",
      "",
      "_No response_",
      "",
      "## Affected Areas",
      "",
      "- cli",
      "",
      "## Additional Context",
      "",
      "_No response_",
    ].join("\n"),
    state: "OPEN",
    labels: [{ name: "hdo:ready" }, { name: "hdo:priority/p2" }, { name: "hdo:risk/low" }],
    assignees: [],
    milestone: null,
    author: { login: "fixture-owner" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/hdo-fixture/repo/issues/7",
    comments: [],
    ...overrides,
  };
}

interface ParityCase {
  name: string;
  issueView: Record<string, unknown>;
  /** Oracle pin: what the PowerShell side (Test-HdoIssueContract) must produce for this fixture. */
  expectValid: boolean;
  expectErrorsInclude?: string[];
}

const CASES: ParityCase[] = [
  {
    name: "ready, contract-valid Issue",
    issueView: issueViewFixture({}),
    expectValid: true,
  },
  {
    name: "Issue missing the ready label (contract validation fails)",
    issueView: issueViewFixture({ labels: [{ name: "hdo:priority/p2" }, { name: "hdo:risk/low" }] }),
    expectValid: false,
    expectErrorsInclude: ["Issue must have ready label 'hdo:ready'."],
  },
];

for (const parityCase of CASES) {
  test(`inspect parity: ${parityCase.name}`, { skip: SKIP_REASON, timeout: 60_000 }, () => {
    // realpathSync.native expands 8.3 short names: on GitHub windows-latest %TEMP% is
    // `RUNNER~1`, but PowerShell's own path expansion always yields the long name
    // (doctorParity.test.ts / runParity.test.ts).
    const repoDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-inspect-parity-repo-")));
    const ghDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-inspect-parity-gh-")));
    const tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hdo-inspect-parity-home-")));
    try {
      buildMockGhDirectory(ghDir, parityCase.issueView);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(tempHome, "AppData", "Local"),
        PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;

      const args = ["inspect", "-Issue", "7", "-Repository", "hdo-fixture/repo", "-Json", "-RepositoryPath", repoDir];
      const psResult = runPwsh(args, env);
      const tsResult = runNode(args, env);

      assert.ok(!psResult.stderr.includes(UNHANDLED_GH_MARKER), `PS hit the mock gh's unhandled-arguments branch.\nstderr: ${psResult.stderr}`);
      assert.ok(!tsResult.stderr.includes(UNHANDLED_GH_MARKER), `TS hit the mock gh's unhandled-arguments branch.\nstderr: ${tsResult.stderr}`);

      assert.equal(psResult.exitCode, 0, `PS exit code.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
      assert.equal(tsResult.exitCode, 0, `TS exit code.\nstdout: ${tsResult.stdout}\nstderr: ${tsResult.stderr}`);

      const psValue = JSON.parse(psResult.stdout) as Record<string, unknown>;
      const tsValue = JSON.parse(tsResult.stdout) as Record<string, unknown>;

      // Oracle pin (PS, independently of TS): the known-correct validation outcome.
      const psValidation = psValue.validation as { valid: boolean; errors: string[] };
      assert.equal(psValidation.valid, parityCase.expectValid, `PS validation.valid pin.\nerrors: ${JSON.stringify(psValidation.errors)}`);
      for (const expectedError of parityCase.expectErrorsInclude ?? []) {
        assert.ok(
          psValidation.errors.includes(expectedError),
          `PS validation.errors pin: expected to include '${expectedError}'. Got: ${JSON.stringify(psValidation.errors)}`,
        );
      }

      assert.deepEqual(Object.keys(psValue), ["issue", "contract", "validation"], "PS output key order pin");
      assert.deepEqual(Object.keys(tsValue), ["issue", "contract", "validation"], "TS output key order");

      assert.deepStrictEqual(
        canonicalize(tsValue),
        canonicalize(psValue),
        `TS and PowerShell 'inspect -Json' output differ for case '${parityCase.name}'.\nPS: ${JSON.stringify(psValue, null, 2)}\nTS: ${JSON.stringify(tsValue, null, 2)}`,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true, maxRetries: 3 });
      rmSync(ghDir, { recursive: true, force: true, maxRetries: 3 });
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
