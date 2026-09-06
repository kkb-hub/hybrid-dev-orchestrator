// Composition root for the `run` CLI subcommand: mirrors hdo.ps1's `'run'` case
// (hdo.ps1:99-131) - the `-Issue`/`-Pick` mutual-exclusion check, `-SetStep` parsing,
// the `HDO_PROGRESS` stderr sink, `runWorkflow` itself, and the DryRun/PREFLIGHT_FAILED/
// ESCALATED/FAILED exit-code mapping (hdo.ps1:133-136). `run`/`status` are wired ahead
// of phase 7 as direct oracles for the same reason `config`/`doctor` were (ADR-0001
// phase 6 plan §3.1): PowerShell's `hdo.ps1 run -Issue N -NoWriteBack -Json` is the
// oracle the parity harness (`src/cli/runParity.test.ts`, WP-H) drives against.
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import { asString } from "../core/runners/psSemantics.ts";
import { getValue } from "../core/config/value.ts";
import { GhClient } from "../github/client.ts";
import { GitClient } from "../git/index.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import type { DryRunResult, RunWorkflowOptions } from "../workflow/run.ts";
import { runWorkflow } from "../workflow/run.ts";
import type { RunRecord } from "../core/workflow/runRecord.ts";
import type { ParsedArgs } from "./args.ts";
import { parseSetStepOverrides, resolveCliConfig } from "./configCommand.ts";
import { REPO_ROOT, SCHEMAS_DIR } from "./paths.ts";

export interface RunRunCommandOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git`/`gh` on PATH via `NodeProcessRunner`. */
  git?: GitClient;
  gh?: GhClient;
  /** `HDO_PROGRESS` sink; defaults to writing to `process.stderr` (hdo.ps1:112-115). Overridable for tests. */
  activityCallback?: (event: JsonObject) => unknown;
  now?: () => string;
  newRunId?: (issueNumber: number) => string;
}

export interface RunRunCommandResult {
  result: RunRecord | DryRunResult;
  exitCode: number;
}

function isDryRunResult(value: RunRecord | DryRunResult): value is DryRunResult {
  return (value as DryRunResult).kind === "execution-plan";
}

// A closed parent stderr pipe (e.g. a piped-to process that exits early) surfaces as
// an asynchronous `'error'` event on the stream, not a synchronous throw from
// `.write()` - so `invokeProgress`'s try/catch (workflow/run.ts) cannot catch it. An
// unhandled `'error'` would crash the process after the run already produced
// artifacts. Registered once (module scope) to swallow it exactly like
// `Invoke-HdoProgressAction`'s "a closed parent stream must not fail the run".
let stderrErrorHandlerRegistered = false;
function ensureStderrErrorHandlerRegistered(): void {
  if (stderrErrorHandlerRegistered) return;
  stderrErrorHandlerRegistered = true;
  process.stderr.on("error", () => {});
}

/** Default `HDO_PROGRESS` sink (hdo.ps1:112-115): one compressed JSON line per event, to stderr. */
function defaultActivityCallback(event: JsonObject): void {
  ensureStderrErrorHandlerRegistered();
  process.stderr.write(`HDO_PROGRESS ${JSON.stringify(event)}\n`);
}

/**
 * Port of hdo.ps1's `'run'` case. Any failure before the run object exists (issue
 * selection, `-DryRun`'s own preflight) propagates unchanged to the caller - `main.ts`
 * catches it exactly like every other subcommand (stderr + exit 2, or 4 for a message
 * starting with "No eligible HDO Issue", hdo.ps1:155).
 */
export async function runRunCommand(options: RunRunCommandOptions): Promise<RunRunCommandResult> {
  const { parsed, platform, schemas } = options;

  // Oracle: hdo.ps1:99, "Specify either -Issue or -Pick, not both."
  if ((parsed.issue ?? 0) > 0 && parsed.pick) {
    throw new Error("Specify either -Issue or -Pick, not both.");
  }

  // Oracle: hdo.ps1:101-107.
  const stepOverrides = parseSetStepOverrides(parsed.setStep);

  const processRunner = new NodeProcessRunner({ platform });
  const git = options.git ?? new GitClient({ runner: processRunner, platform });
  const gh = options.gh ?? new GhClient({ runner: processRunner });

  // Oracle: Workflow.ps1:244, `Get-HdoRepositoryRoot` -> `Invoke-HdoGit ... -ThrowOnError`;
  // `run` must abort before any GitHub access when `-RepositoryPath` is not a git
  // repository (or `git` is unusable), unlike `config`/`doctor`/`status`.
  const config = await resolveCliConfig({ parsed, platform, schemas, git, stepOverrides, requireGitRepository: true });
  const reresolveConfig = (profile: string): Promise<JsonObject> =>
    resolveCliConfig({ parsed, platform, schemas, git, profile, stepOverrides, requireGitRepository: true });

  const runOptions: RunWorkflowOptions = {
    config,
    repositoryRoot: asString(getValue(config, "repositoryPath")),
    repository: parsed.repository,
    issueNumber: parsed.issue && parsed.issue > 0 ? parsed.issue : undefined,
    pick: parsed.pick,
    dryRun: parsed.dryRun,
    noWriteBack: parsed.noWriteBack,
    explicitProfile: parsed.profile,
    reresolveConfig,
    gh,
    git,
    processRunner,
    platform,
    schemas,
    hdoRoot: REPO_ROOT,
    schemasDir: SCHEMAS_DIR,
    activityCallback: options.activityCallback ?? defaultActivityCallback,
    now: options.now,
    newRunId: options.newRunId,
  };

  const result = await runWorkflow(runOptions);

  // Oracle: hdo.ps1:133-136.
  let exitCode = 0;
  if (isDryRunResult(result)) {
    exitCode = result.preflight.ok ? 0 : 3;
  } else if (result.error?.category === "PREFLIGHT_FAILED") {
    exitCode = 3;
  } else if (result.state === "ESCALATED") {
    exitCode = 6;
  } else if (result.state === "FAILED") {
    exitCode = 5;
  }

  return { result, exitCode };
}
