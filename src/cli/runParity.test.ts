// ADR-0001 phase 6 exit criterion (WP-H): "`NoWriteBack` full run が両実装で同じ state
// 遷移・同じ diff・同じ review 判定に到達する" - measured here by running
// `pwsh -NoProfile -File hdo.ps1 run -Issue 7 -NoWriteBack -Json ...` and
// `node src/cli/main.ts run -Issue 7 -NoWriteBack -Json ...` against two independent,
// byte-identical throwaway fixture repositories, the same mock `gh` on PATH (`tests/
// fixtures/workflow/gh/gh.cmd`), and the same deterministic mock plan/implement/fix/
// review agent (`tests/fixtures/workflow/mock-workflow-agent.ps1`), for 13 scenarios
// (phase-6 plan §3.4). No real agent, no real GitHub, no network - the mock `gh`
// answers `auth status` with exit 0 and every other read HDO needs; any write-back
// call (`api user`, `api -X POST/PATCH`, `issue edit`) hits its `exit /b 9` branch,
// which is the harness's guarantee that NoWriteBack never mutates GitHub.
//
// One test per scenario, `run parity: <id>` (PS vs TS): runs PS exactly once and pins
// its exit code, terminal state, first event, ordered `state.transition` list, and the
// NoWriteBack `github.claim` invariant against the table in the plan (§3.4) - so a
// `run` dispatch regression on either side FAILS the test rather than merely comparing
// two (possibly equally wrong) outputs - then does the full PS-vs-TS comparison (§3.5)
// of exit code, canonicalised `run.json`, transitions, per-iteration `diff.json`/
// `validation/result.json`/`review/result.json`, `final/summary.json`, and stdout JSON.
//
// Skipped entirely when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_TS_PATH = resolve(HERE, "main.ts");
const HDO_PS1_PATH = resolve(REPO_ROOT, "hdo.ps1");
const WORKFLOW_FIXTURES_ROOT = resolve(REPO_ROOT, "tests", "fixtures", "workflow");

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `node:test`'s own `timeout` races the returned promise and cannot interrupt a
 * synchronous test body: `spawnSync` blocks the event loop until the child exits, so a
 * hung child (stuck on stdin, a runaway mock) would otherwise hang the whole file until
 * the CI job-level timeout with no diagnostic. `timeout`+`killSignal` bound the block;
 * asserting `result.error`/`result.signal` turns a hang into a failing assertion with
 * captured stdout/stderr instead of a silent process kill.
 */
const CHILD_TIMEOUT_MS = 200_000;

function assertChildCompleted(result: SpawnSyncReturns<string>, label: string): void {
  assert.equal(
    result.error,
    undefined,
    `${label}: spawnSync reported an error (e.g. timed out after ${CHILD_TIMEOUT_MS}ms).\nerror: ${String(result.error)}\nstdout: ${String(result.stdout)}\nstderr: ${String(result.stderr)}`,
  );
  assert.equal(
    result.signal,
    null,
    `${label}: child process was terminated by signal ${String(result.signal)} (likely a ${CHILD_TIMEOUT_MS}ms timeout kill).\nstdout: ${String(result.stdout)}\nstderr: ${String(result.stderr)}`,
  );
}

function runNode(args: string[], env: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): ProcessResult {
  const result = spawnSync(process.execPath, [MAIN_TS_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd,
    windowsHide: true,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assertChildCompleted(result, `runNode ${args.join(" ")}`);
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPwsh(args: string[], env: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): ProcessResult {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", HDO_PS1_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd,
    windowsHide: true,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  assertChildCompleted(result, `runPwsh ${args.join(" ")}`);
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
const PWSH_SKIP_REASON: string | false = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

/** `run parity: <id>` tests need exactly the same precondition as the oracle: pwsh on PATH. */
const PARITY_SKIP_REASON: string | false = PWSH_SKIP_REASON;

// A shared, process-lifetime empty global Git config (plus GIT_CONFIG_NOSYSTEM=1)
// applied to every git invocation (the harness's own fixture-repository commits AND
// both child processes' `git` calls): this machine's real user/system Git config must
// never influence a comparison that is supposed to be fully deterministic (a stray
// `core.autocrlf`, `commit.gpgSign`, or credential helper would otherwise leak in).
const SHARED_TEMP_ROOT = mkdtempSync(join(tmpdir(), "hdo-run-parity-shared-"));
const EMPTY_GIT_CONFIG_PATH = join(SHARED_TEMP_ROOT, "empty-gitconfig");
writeFileSync(EMPTY_GIT_CONFIG_PATH, "", "utf8");
process.on("exit", () => {
  try {
    rmSync(SHARED_TEMP_ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best effort - a leftover empty gitconfig in %TEMP% is harmless.
  }
});

/**
 * The ONE tolerated string difference (ADR-0001 phase 6, Issue #8 `gate:<id>` checks
 * and the mock runners, whose `command` is `pwsh`): PowerShell prepends `$PSHOME` to
 * its own process PATH, so `Get-Command pwsh -CommandType Application` inside
 * `hdo.ps1` always resolves to the running pwsh itself, while the Node process
 * resolves `pwsh` through the ambient PATH. Both name the same binary; only the
 * spelling differs, and only for `pwsh`. Copied verbatim from `doctorParity.test.ts`.
 */
function normalizePwshPath(text: string): string {
  return text.replace(/[A-Za-z]:\\(?:[^\\<>:"|?*\r\n]+\\)*pwsh\.exe/gi, "<PWSH>");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches `tempRoot` spelled with EITHER path separator, case-insensitively (Windows
 * paths). `tempRoot` itself comes from `realpathSync.native`, so it is already in its
 * canonical on-disk casing; both implementations may still render it with forward or
 * backward slashes, and PowerShell's `Join-Path` mixes with whatever was written into
 * the `-Config` overlay.
 */
function tempRootPattern(tempRoot: string): RegExp {
  const segments = tempRoot.split(/[\\/]/).map(escapeRegExp);
  return new RegExp(segments.join("[\\\\/]"), "gi");
}

/** Never matches anything - used as the run-id pattern for scenarios (DryRun) that never produce a runId. */
const NEVER_MATCHES = /(?!)/;

interface CanonicalizeContext {
  tempRoot: RegExp;
  runId: RegExp;
}

function makeContext(tempRoot: string, runId: string): CanonicalizeContext {
  return {
    tempRoot: tempRootPattern(tempRoot),
    runId: runId.length > 0 ? new RegExp(escapeRegExp(runId), "gi") : NEVER_MATCHES,
  };
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

/**
 * Keys dropped everywhere they occur (phase-6 plan §3.5): every timestamp and
 * duration field emitted anywhere in a run's artifacts. `updatedAt` is in this list,
 * which is also what makes the stdout-JSON comparison automatically equal to the
 * `run.json` comparison "minus `updatedAt`" (§3.5 item 7) without any special case.
 */
const DROP_KEYS = new Set<string>([
  "createdAt",
  "updatedAt",
  "capturedAt",
  "completedAt",
  "checkedAt",
  "generatedAt",
  "startedAt",
  "endedAt",
  "claimedAt",
  "leaseExpiresAt",
  "lastHeartbeatAt",
  "at",
  "durationMs",
  "elapsedSeconds",
]);

function canonicalizeString(value: string, ctx: CanonicalizeContext): string {
  let out = normalizePwshPath(value);
  out = out.replace(ctx.runId, "<RUN_ID>");
  out = out.replace(ctx.tempRoot, "<TEMP>");
  out = out.replace(/\\/g, "/");
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(out)) out = out.toLowerCase();
  return out;
}

/** Recursively sorts object keys, drops `DROP_KEYS`, and canonicalises string values (§3.5). Array order is preserved. */
function canonicalize(value: unknown, ctx: CanonicalizeContext): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, ctx));
  if (typeof value === "string") return canonicalizeString(value, ctx);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key], ctx);
    }
    return out;
  }
  return value;
}

/**
 * `evidenceDetail` on the synthetic `HDO-VALIDATION-R<n>` finding (and only that
 * finding) is a JSON STRING - the compressed validation summary (Workflow.ps1:455;
 * plan §3.5 item 5 / §5 trap 6). Because it is a JSON DOCUMENT embedded as a STRING
 * VALUE inside a larger JSON document, its own path separators are double-escaped in
 * the outer file's bytes (one escaping layer for the inner JSON text, one more for
 * embedding that text as a JSON string) - so after `JSON.parse`-ing the OUTER
 * document exactly once, this string's in-memory content still literally contains
 * doubled backslash characters, which `canonicalizeString`'s single-backslash regexes
 * do not match. Parse it in place (wherever a `findings` array appears: `run.json`'s
 * `result`, `final/summary.json`, the printed stdout object, and every per-iteration
 * `review/result.json`) so `canonicalize` recurses into a real object, drops its
 * `completedAt`/`durationMs`, sorts its keys, and rewrites its `artifact` path like
 * any other validation result, instead of comparing two independently-serialized JSON
 * strings verbatim (whose key order/whitespace/escaping is not a parity contract). A
 * plain mock finding's `evidenceDetail` ("Deterministic mock finding.") is not JSON
 * and is left as text.
 */
function parseFindingsEvidenceDetails(container: unknown): void {
  if (!container || typeof container !== "object") return;
  const findings = (container as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) return;
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const record = finding as Record<string, unknown>;
    if (typeof record.evidenceDetail !== "string") continue;
    try {
      record.evidenceDetail = JSON.parse(record.evidenceDetail);
    } catch {
      // Not JSON - a plain mock finding message; leave it as text.
    }
  }
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed with exit ${String(result.status)}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
}

/**
 * Builds the throwaway fixture repository (phase-6 plan §3.2/§3.6): `git init`, fixed
 * local identity/gpgSign/autocrlf config, `.hdo/project.json` + `tools/gate-*.ps1`
 * copied in, `README.md`/`tracked.txt` written, one commit with a FIXED
 * `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` (`2026-01-01T00:00:00Z`) so that, combined
 * with byte-identical content and the shared empty Git config, `baseCommit` comes out
 * identical whichever implementation's repository this is (verified below in
 * `setupSide` for every scenario, not just assumed).
 */
function buildFixtureRepository(repoDir: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(repoDir, { recursive: true });
  runGit(["init", "-q"], repoDir, env);
  runGit(["config", "user.email", "hdo-tests@example.invalid"], repoDir, env);
  runGit(["config", "user.name", "HDO Tests"], repoDir, env);
  runGit(["config", "commit.gpgSign", "false"], repoDir, env);
  runGit(["config", "core.autocrlf", "false"], repoDir, env);
  mkdirSync(join(repoDir, ".hdo"), { recursive: true });
  mkdirSync(join(repoDir, "tools"), { recursive: true });
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "project.json"), join(repoDir, ".hdo", "project.json"));
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "tools", "gate-pass.ps1"), join(repoDir, "tools", "gate-pass.ps1"));
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "tools", "gate-fail.ps1"), join(repoDir, "tools", "gate-fail.ps1"));
  writeFileSync(join(repoDir, "README.md"), "fixture", "utf8");
  writeFileSync(join(repoDir, "tracked.txt"), "baseline", "utf8");
  runGit(["add", "-A"], repoDir, env);
  const commitEnv: NodeJS.ProcessEnv = { ...env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  runGit(["commit", "-q", "-m", "baseline"], repoDir, commitEnv);
}

function readRepositoryHead(repoDir: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD (cwd=${repoDir}) failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Per-scenario mock `gh` PATH directory (§3.2): a private copy of `tests/fixtures/
 * workflow/gh/*` plus a generated `issue-view.json` whose `## Validation Gate IDs`
 * section lists exactly the gate ids this scenario exercises (`gh.cmd`'s `%~dp0`
 * always resolves relative to this per-scenario copy, so two scenarios - or two
 * implementations of the same scenario - never share one `issue-view.json`).
 */
function buildMockGhDirectory(dir: string, gates: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "gh", "gh.cmd"), join(dir, "gh.cmd"));
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "gh", "issue-events.json"), join(dir, "issue-events.json"));
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "gh", "issue-comments.json"), join(dir, "issue-comments.json"));
  copyFileSync(join(WORKFLOW_FIXTURES_ROOT, "gh", "graphql-last-edited.json"), join(dir, "graphql-last-edited.json"));
  const template = readFileSync(join(WORKFLOW_FIXTURES_ROOT, "gh", "issue-view.template.json"), "utf8");
  // A literal, JSON-escaped `\n` between lines (NOT an actual newline byte) - the
  // placeholder lives inside a JSON string in the template, so the replacement must
  // stay valid JSON source text. Mirrors run-tests.ps1's PowerShell single-quoted
  // '\n' (also two literal characters, not an escape).
  const gateLines = gates.map((gate) => `- ${gate}`).join("\\n");
  writeFileSync(join(dir, "issue-view.json"), template.replace("__VALIDATION_GATES__", gateLines), "utf8");
}

interface OverlayOptions {
  scenarioFile: string;
  worktreeRoot: string;
  artifactRoot: string;
  onNoDiff?: string;
  onValidationFailure?: string;
  onMaxFixAttempts?: string;
  maxFixAttempts?: number;
  planCommandOverride?: string;
}

/** The `-Config` overlay (§3.2): mock plan/implement/review runners driven by `mock-workflow-agent.ps1`, addressed entirely through `{hdoRoot}` (ADR-0001 phase-6 plan §8 Q6 - no absolute path in the overlay at all). */
function buildOverlay(options: OverlayOptions): Record<string, unknown> {
  const mockRunnerArgs = [
    "-NoProfile",
    "-File",
    "{hdoRoot}/tests/fixtures/workflow/mock-workflow-agent.ps1",
    "-SchemaFile",
    "{schemaFile}",
    "-OutputFile",
    "{outputFile}",
    "-Scenario",
    `{hdoRoot}/tests/fixtures/workflow/scenarios/${options.scenarioFile}.json`,
  ];
  const runner = (sandbox: string, commandOverride?: string): Record<string, unknown> => ({
    type: "command",
    provider: "custom",
    command: commandOverride ?? "pwsh",
    sandbox,
    timeoutSeconds: 60,
    passEnvironment: [],
    extraArgs: mockRunnerArgs,
    promptTransport: "stdin",
  });
  return {
    activeProfile: "mock",
    profiles: { mock: { steps: { plan: "mock-plan", implement: "mock-implement", review: "mock-review", fix: "mock-implement" } } },
    runners: {
      "mock-plan": runner("read-only", options.planCommandOverride),
      "mock-implement": runner("workspace-write"),
      "mock-review": runner("read-only"),
    },
    github: { writeBack: "status", trustedActors: [], assignOnClaim: false },
    workflow: {
      maxFixAttempts: options.maxFixAttempts ?? 2,
      implicitFallback: false,
      onNoDiff: options.onNoDiff ?? "fail",
      onValidationFailure: options.onValidationFailure ?? "request-changes",
      onMaxFixAttempts: options.onMaxFixAttempts ?? "escalate",
    },
    paths: { worktreeRoot: options.worktreeRoot, artifactRoot: options.artifactRoot },
    projectContractPath: ".hdo/project.json",
  };
}

interface TransitionExpectation {
  from: string;
  to: string;
  reason: string;
  iteration: number;
}

function tr(from: string, to: string, reason: string, iteration: number): TransitionExpectation {
  return { from, to, reason, iteration };
}

/** Transition reason strings, verbatim (phase-6 plan §2.3). */
const REASON = {
  issueSelected: "GitHub Issue resolved and contract validated.",
  preflightStart: "Checking selected adapters and local environment.",
  worktreeReady: "Isolated Git worktree created.",
  planningStart: "Read-only planning step started.",
  implementInitial: "Initial implementation started.",
  implementFix: "Fix iteration started.",
  validatingStart: "Trusted project validation gates started.",
  reviewingStart: "Read-only structured review started.",
  reviewRequestChanges: "Reviewer returned actionable findings.",
  reviewFixLimit: "Reviewer requested changes at the fix limit.",
  reviewApproved: "Reviewer approved a diff with all required validation gates passing.",
  noDiffChangesRequested: "Implementation produced no diff.",
  validationChangesRequested: "Required validation did not pass.",
  noDiffEscalated: "No diff requires Human attention.",
  validationEscalated: "Validation policy requires Human attention.",
  maxFixEscalated: "Maximum fix attempts reached.",
  noDiffFailed: "Implementation step completed without any worktree changes.",
  maxFixFailed: "Maximum fix attempts reached with open findings.",
  reviewerEscalated: "Mock reviewer escalated.",
  implementExit3Failed: "Agent step 'implement' failed with exit code 3. mock implement failure",
  preflightFailed: "Preflight failed: runner:mock-plan: Runner command 'hdo-command-that-does-not-exist' was not found.",
} as const;

/** CREATED through the first `IMPLEMENTING -> VALIDATING` (iteration 1): common to every non-DryRun, non-PREFLIGHT_FAILED scenario. */
const PROLOGUE: TransitionExpectation[] = [
  tr("CREATED", "ISSUE_SELECTED", REASON.issueSelected, 0),
  tr("ISSUE_SELECTED", "PREFLIGHT", REASON.preflightStart, 0),
  tr("PREFLIGHT", "WORKTREE_READY", REASON.worktreeReady, 0),
  tr("WORKTREE_READY", "PLANNING", REASON.planningStart, 0),
  tr("PLANNING", "IMPLEMENTING", REASON.implementInitial, 1),
  tr("IMPLEMENTING", "VALIDATING", REASON.validatingStart, 1),
];

/** One fix round: `VALIDATING -> REVIEWING -> CHANGES_REQUESTED("actionable findings") -> IMPLEMENTING("fix started") -> VALIDATING`, for the NEXT iteration number. */
function fixRound(reviewedIteration: number, nextIteration: number): TransitionExpectation[] {
  return [
    tr("VALIDATING", "REVIEWING", REASON.reviewingStart, reviewedIteration),
    tr("REVIEWING", "CHANGES_REQUESTED", REASON.reviewRequestChanges, reviewedIteration),
    tr("CHANGES_REQUESTED", "IMPLEMENTING", REASON.implementFix, nextIteration),
    tr("IMPLEMENTING", "VALIDATING", REASON.validatingStart, nextIteration),
  ];
}

interface ScenarioCase {
  id: string;
  gates: readonly string[];
  scenarioFile: string;
  onNoDiff?: string;
  onValidationFailure?: string;
  onMaxFixAttempts?: string;
  dryRun?: boolean;
  planCommandOverride?: string;
  expectedExit: number;
  /** `null` for the DryRun scenario, which never writes a `run.json`. */
  expectedState: string | null;
  expectedTransitions: TransitionExpectation[];
}

const CASES: ScenarioCase[] = [
  {
    id: "a",
    gates: ["gate-pass"],
    scenarioFile: "a",
    expectedExit: 0,
    expectedState: "APPROVED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 1), tr("REVIEWING", "APPROVED", REASON.reviewApproved, 1)],
  },
  {
    id: "b",
    gates: ["gate-pass"],
    scenarioFile: "b",
    expectedExit: 0,
    expectedState: "APPROVED",
    expectedTransitions: [...PROLOGUE, ...fixRound(1, 2), tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 2), tr("REVIEWING", "APPROVED", REASON.reviewApproved, 2)],
  },
  {
    id: "c",
    gates: ["gate-pass"],
    scenarioFile: "c",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [
      ...PROLOGUE,
      ...fixRound(1, 2),
      ...fixRound(2, 3),
      tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 3),
      tr("REVIEWING", "CHANGES_REQUESTED", REASON.reviewFixLimit, 3),
      tr("CHANGES_REQUESTED", "ESCALATED", REASON.maxFixEscalated, 3),
    ],
  },
  {
    id: "c2",
    gates: ["gate-pass"],
    scenarioFile: "c2",
    onMaxFixAttempts: "fail",
    expectedExit: 5,
    expectedState: "FAILED",
    expectedTransitions: [
      ...PROLOGUE,
      ...fixRound(1, 2),
      ...fixRound(2, 3),
      tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 3),
      tr("REVIEWING", "FAILED", REASON.maxFixFailed, 3),
    ],
  },
  {
    id: "d",
    gates: ["gate-pass"],
    scenarioFile: "d",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 1), tr("REVIEWING", "ESCALATED", REASON.reviewerEscalated, 1)],
  },
  {
    id: "e",
    gates: ["gate-pass"],
    scenarioFile: "e",
    onNoDiff: "escalate",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "CHANGES_REQUESTED", REASON.noDiffChangesRequested, 1), tr("CHANGES_REQUESTED", "ESCALATED", REASON.noDiffEscalated, 1)],
  },
  {
    id: "e2",
    gates: ["gate-pass"],
    scenarioFile: "e2",
    expectedExit: 5,
    expectedState: "FAILED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "FAILED", REASON.noDiffFailed, 1)],
  },
  {
    id: "f",
    gates: ["gate-fail"],
    scenarioFile: "f",
    onValidationFailure: "escalate",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "CHANGES_REQUESTED", REASON.validationChangesRequested, 1), tr("CHANGES_REQUESTED", "ESCALATED", REASON.validationEscalated, 1)],
  },
  {
    id: "f2",
    gates: ["gate-fail"],
    scenarioFile: "f2",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [
      ...PROLOGUE,
      ...fixRound(1, 2),
      ...fixRound(2, 3),
      tr("VALIDATING", "REVIEWING", REASON.reviewingStart, 3),
      tr("REVIEWING", "CHANGES_REQUESTED", REASON.reviewFixLimit, 3),
      tr("CHANGES_REQUESTED", "ESCALATED", REASON.maxFixEscalated, 3),
    ],
  },
  {
    id: "g",
    gates: ["gate-setup", "gate-after"],
    scenarioFile: "g",
    onValidationFailure: "escalate",
    expectedExit: 6,
    expectedState: "ESCALATED",
    expectedTransitions: [...PROLOGUE, tr("VALIDATING", "CHANGES_REQUESTED", REASON.validationChangesRequested, 1), tr("CHANGES_REQUESTED", "ESCALATED", REASON.validationEscalated, 1)],
  },
  {
    id: "h",
    gates: ["gate-pass"],
    scenarioFile: "h",
    expectedExit: 5,
    expectedState: "FAILED",
    expectedTransitions: [
      tr("CREATED", "ISSUE_SELECTED", REASON.issueSelected, 0),
      tr("ISSUE_SELECTED", "PREFLIGHT", REASON.preflightStart, 0),
      tr("PREFLIGHT", "WORKTREE_READY", REASON.worktreeReady, 0),
      tr("WORKTREE_READY", "PLANNING", REASON.planningStart, 0),
      tr("PLANNING", "IMPLEMENTING", REASON.implementInitial, 1),
      tr("IMPLEMENTING", "FAILED", REASON.implementExit3Failed, 1),
    ],
  },
  {
    id: "i",
    gates: ["gate-pass"],
    scenarioFile: "a",
    dryRun: true,
    expectedExit: 0,
    expectedState: null,
    expectedTransitions: [],
  },
  {
    id: "j",
    gates: ["gate-pass"],
    scenarioFile: "a",
    planCommandOverride: "hdo-command-that-does-not-exist",
    expectedExit: 3,
    expectedState: "FAILED",
    expectedTransitions: [
      tr("CREATED", "ISSUE_SELECTED", REASON.issueSelected, 0),
      tr("ISSUE_SELECTED", "PREFLIGHT", REASON.preflightStart, 0),
      tr("PREFLIGHT", "FAILED", REASON.preflightFailed, 0),
    ],
  },
];

interface SideSetup {
  tempRoot: string;
  repoDir: string;
  ghDir: string;
  worktreeRoot: string;
  artifactRoot: string;
  overlayPath: string;
  env: NodeJS.ProcessEnv;
  baseCommit: string;
}

function setupSide(caseDef: ScenarioCase, label: string): SideSetup {
  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `hdo-run-parity-${caseDef.id}-${label}-`)));
  const repoDir = join(tempRoot, "repo");
  const ghDir = join(tempRoot, "gh");
  const worktreeRoot = join(tempRoot, "worktrees");
  const artifactRoot = join(tempRoot, "runs");
  const overlayPath = join(tempRoot, "overlay.json");

  const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG_PATH, GIT_CONFIG_NOSYSTEM: "1" };
  buildFixtureRepository(repoDir, gitEnv);
  const baseCommit = readRepositoryHead(repoDir, gitEnv);

  buildMockGhDirectory(ghDir, caseDef.gates);
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });

  const overlay = buildOverlay({
    scenarioFile: caseDef.scenarioFile,
    worktreeRoot,
    artifactRoot,
    onNoDiff: caseDef.onNoDiff,
    onValidationFailure: caseDef.onValidationFailure,
    onMaxFixAttempts: caseDef.onMaxFixAttempts,
    planCommandOverride: caseDef.planCommandOverride,
  });
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2), "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(tempRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempRoot, "AppData", "Local"),
    // The mock gh directory is FIRST on PATH for both children (plan §3.6 / §5 trap
    // 25): `Get-Command gh -CommandType Application` and `platform.resolveExecutable`
    // both then resolve `gh.cmd` ahead of any real `gh.exe` later on PATH.
    PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG_PATH,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  return { tempRoot, repoDir, ghDir, worktreeRoot, artifactRoot, overlayPath, env, baseCommit };
}

function buildRunArgs(caseDef: ScenarioCase, side: SideSetup): string[] {
  const args = ["run", "-Issue", "7", "-NoWriteBack", "-Json", "-Config", side.overlayPath, "-RepositoryPath", side.repoDir, "-Repository", "hdo-fixture/repo"];
  if (caseDef.dryRun) args.push("-DryRun");
  return args;
}

interface RunArtifacts {
  runId: string;
  artifactPath: string;
  runJson: Record<string, unknown>;
  events: Record<string, unknown>[];
}

function collectArtifacts(artifactRoot: string, scenarioId: string, implementationLabel: string): RunArtifacts {
  const entries = readdirSync(artifactRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(
    entries.length,
    1,
    `scenario ${scenarioId} (${implementationLabel}): expected exactly one run directory under ${artifactRoot}, found: [${entries.map((entry) => entry.name).join(", ")}]`,
  );
  const runId = entries[0]?.name ?? "";
  const artifactPath = join(artifactRoot, runId);
  const runJson = JSON.parse(readFileSync(join(artifactPath, "run.json"), "utf8")) as Record<string, unknown>;
  const eventsRaw = readFileSync(join(artifactPath, "events.jsonl"), "utf8");
  const events = eventsRaw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { runId, artifactPath, runJson, events };
}

function projectTransitions(events: Record<string, unknown>[]): TransitionExpectation[] {
  return events
    .filter((event) => event.type === "state.transition")
    .map((event) => ({
      from: String(event.from),
      to: String(event.to),
      reason: String(event.reason),
      iteration: Number(event.iteration),
    }));
}

function eventTypes(events: Record<string, unknown>[]): string[] {
  return events.map((event) => String(event.type));
}

const UNHANDLED_GH_MARKER = "mock gh: unhandled arguments";

for (const caseDef of CASES) {
  test(`run parity: ${caseDef.id}`, { skip: PARITY_SKIP_REASON, timeout: 240_000 }, () => {
    const psSide = setupSide(caseDef, "ps");
    const tsSide = setupSide(caseDef, "ts");
    try {
      // §3.6: two independent fixture repositories, byte-identical content and a
      // fixed commit date, so `baseCommit` must come out identical on both sides -
      // verify rather than assume.
      assert.equal(
        tsSide.baseCommit,
        psSide.baseCommit,
        `scenario ${caseDef.id}: the two fixture repositories' baseCommit differ even though content and commit dates are fixed (PS=${psSide.baseCommit}, TS=${tsSide.baseCommit}) - the harness's assumption that baseCommit can be compared verbatim does not hold on this machine; canonicalisation needs a <BASE_COMMIT> token.`,
      );

      const psArgs = buildRunArgs(caseDef, psSide);
      const tsArgs = buildRunArgs(caseDef, tsSide);
      const psStart = Date.now();
      const psResult = runPwsh(psArgs, psSide.env);
      const psWallMs = Date.now() - psStart;
      const tsStart = Date.now();
      const tsResult = runNode(tsArgs, tsSide.env);
      const tsWallMs = Date.now() - tsStart;
      console.log(`[runParity] ${caseDef.id}: PS wall=${psWallMs}ms TS wall=${tsWallMs}ms`);

      // 1. exit code.
      assert.equal(psResult.exitCode, caseDef.expectedExit, `scenario ${caseDef.id}: PS exit code.\nstdout: ${psResult.stdout}\nstderr: ${psResult.stderr}`);
      assert.equal(
        tsResult.exitCode,
        caseDef.expectedExit,
        `scenario ${caseDef.id}: TS exit code differs from the expected/oracle exit code.\nTS stdout: ${tsResult.stdout}\nTS stderr: ${tsResult.stderr}`,
      );
      assert.ok(!psResult.stderr.includes(UNHANDLED_GH_MARKER), `scenario ${caseDef.id}: PS hit the mock gh's unhandled-arguments branch.\nstderr: ${psResult.stderr}`);
      assert.ok(!tsResult.stderr.includes(UNHANDLED_GH_MARKER), `scenario ${caseDef.id}: TS hit the mock gh's unhandled-arguments branch.\nstderr: ${tsResult.stderr}`);

      if (caseDef.dryRun) {
        const ctxPs = makeContext(psSide.tempRoot, "");
        const ctxTs = makeContext(tsSide.tempRoot, "");
        const psStdout = JSON.parse(psResult.stdout) as Record<string, unknown>;
        const tsStdout = JSON.parse(tsResult.stdout) as unknown;
        // PS pinned against the plan table (formerly `run parity oracle: <id>`), not just against TS.
        assert.equal(psStdout.kind, "execution-plan", `scenario ${caseDef.id}: PS DryRun stdout.kind`);
        assert.equal(psStdout.dryRun, true, `scenario ${caseDef.id}: PS DryRun stdout.dryRun`);
        assert.deepStrictEqual(psStdout.mutations, [], `scenario ${caseDef.id}: PS DryRun stdout.mutations`);
        assert.ok(
          !existsSync(psSide.artifactRoot) || readdirSync(psSide.artifactRoot).length === 0,
          `scenario ${caseDef.id}: PS DryRun must write no run artifacts`,
        );
        assert.deepStrictEqual(
          canonicalize(tsStdout, ctxTs),
          canonicalize(psStdout, ctxPs),
          `scenario ${caseDef.id}: DryRun stdout JSON differs.\nPS: ${JSON.stringify(psStdout, null, 2)}\nTS: ${JSON.stringify(tsStdout, null, 2)}`,
        );
        return;
      }

      // 2. expected transitions (pins each side against the table) -> 3. PS-vs-TS transitions.
      const psArtifacts = collectArtifacts(psSide.artifactRoot, caseDef.id, "PS");
      const tsArtifacts = collectArtifacts(tsSide.artifactRoot, caseDef.id, "TS");
      // PS pinned against the plan table (formerly `run parity oracle: <id>`): terminal
      // state, first event, transitions, and the NoWriteBack github.claim invariant.
      assert.equal(
        psArtifacts.runJson.state,
        caseDef.expectedState,
        `scenario ${caseDef.id}: PS terminal state (error=${JSON.stringify(psArtifacts.runJson.error)})`,
      );
      assert.equal(psArtifacts.events[0]?.type, "run.created", `scenario ${caseDef.id}: PS events.jsonl must begin with run.created`);
      assert.equal(
        psArtifacts.runJson.github && (psArtifacts.runJson.github as Record<string, unknown>).claim,
        null,
        `scenario ${caseDef.id}: PS -NoWriteBack must leave github.claim null`,
      );
      const psTransitions = projectTransitions(psArtifacts.events);
      const tsTransitions = projectTransitions(tsArtifacts.events);
      assert.deepStrictEqual(psTransitions, caseDef.expectedTransitions, `scenario ${caseDef.id}: PS state.transition sequence does not match the plan §3.4 table.`);
      assert.deepStrictEqual(
        tsTransitions,
        caseDef.expectedTransitions,
        `scenario ${caseDef.id}: TS state.transition sequence differs from the expected/PS-pinned table.\ngot: ${JSON.stringify(tsTransitions, null, 2)}`,
      );
      assert.deepStrictEqual(
        eventTypes(tsArtifacts.events),
        eventTypes(psArtifacts.events),
        `scenario ${caseDef.id}: the ordered list of ALL events.jsonl event types differs between PS and TS.`,
      );

      const ctxPs = makeContext(psSide.tempRoot, psArtifacts.runId);
      const ctxTs = makeContext(tsSide.tempRoot, tsArtifacts.runId);
      parseFindingsEvidenceDetails(psArtifacts.runJson.result);
      parseFindingsEvidenceDetails(tsArtifacts.runJson.result);

      // 4. canonicalised run.json.
      assert.deepStrictEqual(
        canonicalize(tsArtifacts.runJson, ctxTs),
        canonicalize(psArtifacts.runJson, ctxPs),
        `scenario ${caseDef.id}: run.json differs.\nPS: ${JSON.stringify(psArtifacts.runJson, null, 2)}\nTS: ${JSON.stringify(tsArtifacts.runJson, null, 2)}`,
      );

      // 5. per-iteration diff.json / validation/result.json / review/result.json.
      const iterationCount = Number(psArtifacts.runJson.iteration ?? 0);
      for (let iteration = 1; iteration <= iterationCount; iteration++) {
        const name = String(iteration).padStart(3, "0");

        const diffPathPs = join(psArtifacts.artifactPath, "iterations", name, "diff.json");
        const diffPathTs = join(tsArtifacts.artifactPath, "iterations", name, "diff.json");
        if (existsSync(diffPathPs)) {
          assert.ok(existsSync(diffPathTs), `scenario ${caseDef.id} iteration ${name}: TS diff.json is missing while PS has one.`);
          const psDiff = JSON.parse(readFileSync(diffPathPs, "utf8")) as unknown;
          const tsDiff = JSON.parse(readFileSync(diffPathTs, "utf8")) as unknown;
          assert.deepStrictEqual(canonicalize(tsDiff, ctxTs), canonicalize(psDiff, ctxPs), `scenario ${caseDef.id} iteration ${name}: diff.json differs.`);
        }

        const validationPathPs = join(psArtifacts.artifactPath, "iterations", name, "validation", "result.json");
        const validationPathTs = join(tsArtifacts.artifactPath, "iterations", name, "validation", "result.json");
        if (existsSync(validationPathPs)) {
          assert.ok(existsSync(validationPathTs), `scenario ${caseDef.id} iteration ${name}: TS validation/result.json is missing while PS has one.`);
          const psValidation = JSON.parse(readFileSync(validationPathPs, "utf8")) as unknown;
          const tsValidation = JSON.parse(readFileSync(validationPathTs, "utf8")) as unknown;
          assert.deepStrictEqual(
            canonicalize(tsValidation, ctxTs),
            canonicalize(psValidation, ctxPs),
            `scenario ${caseDef.id} iteration ${name}: validation/result.json differs.\nPS: ${JSON.stringify(psValidation, null, 2)}\nTS: ${JSON.stringify(tsValidation, null, 2)}`,
          );
        }

        const reviewPathPs = join(psArtifacts.artifactPath, "iterations", name, "review", "result.json");
        const reviewPathTs = join(tsArtifacts.artifactPath, "iterations", name, "review", "result.json");
        if (existsSync(reviewPathPs)) {
          assert.ok(existsSync(reviewPathTs), `scenario ${caseDef.id} iteration ${name}: TS review/result.json is missing while PS has one.`);
          const psReview = JSON.parse(readFileSync(reviewPathPs, "utf8")) as Record<string, unknown>;
          const tsReview = JSON.parse(readFileSync(reviewPathTs, "utf8")) as Record<string, unknown>;
          parseFindingsEvidenceDetails(psReview);
          parseFindingsEvidenceDetails(tsReview);
          assert.deepStrictEqual(
            canonicalize(tsReview, ctxTs),
            canonicalize(psReview, ctxPs),
            `scenario ${caseDef.id} iteration ${name}: review/result.json differs.\nPS: ${JSON.stringify(psReview, null, 2)}\nTS: ${JSON.stringify(tsReview, null, 2)}`,
          );
        }
      }

      // 6. final/summary.json.
      const finalSummaryPs = join(psArtifacts.artifactPath, "final", "summary.json");
      const finalSummaryTs = join(tsArtifacts.artifactPath, "final", "summary.json");
      if (existsSync(finalSummaryPs)) {
        assert.ok(existsSync(finalSummaryTs), `scenario ${caseDef.id}: TS final/summary.json is missing while PS (the oracle) has one.`);
        const psFinal = JSON.parse(readFileSync(finalSummaryPs, "utf8")) as unknown;
        const tsFinal = JSON.parse(readFileSync(finalSummaryTs, "utf8")) as unknown;
        parseFindingsEvidenceDetails(psFinal);
        parseFindingsEvidenceDetails(tsFinal);
        assert.deepStrictEqual(
          canonicalize(tsFinal, ctxTs),
          canonicalize(psFinal, ctxPs),
          `scenario ${caseDef.id}: final/summary.json differs.\nPS: ${JSON.stringify(psFinal, null, 2)}\nTS: ${JSON.stringify(tsFinal, null, 2)}`,
        );
      } else {
        assert.ok(!existsSync(finalSummaryTs), `scenario ${caseDef.id}: TS wrote final/summary.json but PS (the oracle) did not (expected for a FAILED run).`);
      }

      // 7. stdout JSON (equal to canonicalised run.json minus updatedAt, which DROP_KEYS already strips).
      const psStdout = JSON.parse(psResult.stdout) as Record<string, unknown>;
      const tsStdout = JSON.parse(tsResult.stdout) as Record<string, unknown>;
      parseFindingsEvidenceDetails(psStdout.result);
      parseFindingsEvidenceDetails(tsStdout.result);
      assert.deepStrictEqual(
        canonicalize(tsStdout, ctxTs),
        canonicalize(psStdout, ctxPs),
        `scenario ${caseDef.id}: stdout JSON differs.\nPS: ${JSON.stringify(psStdout, null, 2)}\nTS: ${JSON.stringify(tsStdout, null, 2)}`,
      );
    } finally {
      rmSync(psSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
      rmSync(tsSide.tempRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
