// Port of `Invoke-HdoRun` (Workflow.ps1:228-561): the bounded plan -> implement ->
// validate -> review -> fix loop. ADR-0003 D1 ("hand-rolled dispatch loop over
// `transition()`, no XState"): `STEP_HANDLERS` is an exhaustive
// `Record<NonTerminalRunState, StepHandler>`; each handler does the PS work that
// happens AFTER the previous `Set-HdoRunState` call and BEFORE the next one, then
// returns the next `{ to, reason }`; `drive()` guards every handler's answer with
// `transition()` before `RunStore.setState` writes the `state.transition` event, and
// ONE try/catch around `drive()` (plus the write-back finalize) mirrors
// `Invoke-HdoRun`'s own single catch block (:522-548).
//
// `src/workflow/**` is a host module (ADR-0001 phase 5/6 plan §2 boundary): every
// pure decision lives in `src/core/workflow/{runRecord,decisions}.ts`; this file only
// orchestrates the injected `GitClient`/`GhClient`/`ProcessRunner`/`PlatformAdapter`,
// drives `RunStore`, and writes the per-run artifacts `Invoke-HdoRun` writes directly.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  DependencyValidationResult,
  IssueContract,
  IssueContractValidationResult,
  JsonObject,
  JsonValue,
  ProjectContract,
  ReadyLabelAuthorizationResult,
  ResolvedHdoConfig,
  ReviewResult,
} from "../core/contracts/types.ts";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { getValue } from "../core/config/value.ts";
import { getExecutionPlan } from "../core/config/executionPlan.ts";
import { isTerminalState, transition } from "../core/state/index.ts";
import type { NonTerminalRunState, RunState } from "../core/state/index.ts";
import { toMermaid as stateDiagramMermaid } from "../core/state/mermaid.ts";
import {
  REASONS,
  approveResult,
  classifyRunFailure,
  createRunRecord,
  isWriteBackEnabled,
  maxFixEscalateResult,
  newRunId,
  noDiffEscalateResult,
  reviewEscalateResult,
  syntheticTaskContract,
  validationEscalateResult,
} from "../core/workflow/runRecord.ts";
import type { RunRecord, RunResult } from "../core/workflow/runRecord.ts";
import { applyValidationBlocker, decideNoDiff, decideReview, decideValidation } from "../core/workflow/decisions.ts";
import type { ValidationSummary } from "../core/workflow/gates.ts";
import { asString, equalsIgnoreCase, hdoArrayItems } from "../core/runners/psSemantics.ts";
import { getStepBinding } from "../core/runners/stepBinding.ts";
import { buildFixPrompt, buildImplementationPrompt, buildPlanPrompt, buildReviewPrompt } from "../core/runners/prompts.ts";
import { testReviewResult } from "../core/runners/reviewResult.ts";
import { protectObject, protectText } from "../core/process/redact.ts";
import type { ProcessRunner } from "../core/process/types.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { GitClient, sha256Hex } from "../git/index.ts";
import type { GitDiffResult } from "../git/index.ts";
import { GhClient } from "../github/client.ts";
import { claimIssue, completeClaim, setManagedStatusLabel } from "../github/claim.ts";
import { runAgentStep } from "../runners/agentStep.ts";
import { writeJsonFile, writeTextFile } from "../runners/artifacts.ts";
import { runPreflight } from "./preflight.ts";
import type { PreflightResult } from "./preflight.ts";
import { selectIssue } from "./selectIssue.ts";
import type { SelectedIssue } from "./selectIssue.ts";
import { assertRepositoryConfigSnapshot, assertWorktreeIntegrity, createWorktree, getWorktreeProjectContract } from "./worktree.ts";
import type { WorktreeInfo } from "./worktree.ts";
import { runValidation } from "./validation.ts";
import { RunStore } from "./runStore.ts";

export { stateDiagramMermaid };

export interface RunWorkflowOptions {
  config: JsonObject;
  repositoryRoot: string;
  repository?: string;
  issueNumber?: number;
  pick: boolean;
  dryRun: boolean;
  noWriteBack: boolean;
  explicitProfile?: string;
  /** Re-resolves config for the Issue's route hint (Workflow.ps1:246), or for an unrelated `-Profile`. */
  reresolveConfig: (profile: string) => Promise<JsonObject>;
  gh: GhClient;
  git: GitClient;
  processRunner: ProcessRunner;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  hdoRoot: string;
  schemasDir: string;
  /** `HDO_PROGRESS` sink; redacted and swallowed exactly like `Invoke-HdoProgressAction` (Common.ps1:730-742). */
  activityCallback?: (event: JsonObject) => unknown;
  now?: () => string;
  /** Overridable for tests; defaults to `newRunId(issueNumber, new Date(), randomUUID().replace(/-/g, "").slice(0, 8))`. */
  newRunId?: (issueNumber: number) => string;
  ambientEnvironment?: Record<string, string | undefined>;
}

/** Oracle: Workflow.ps1:278-291 - `Invoke-HdoRun`'s `-DryRun` branch. */
export interface DryRunResult {
  kind: "execution-plan";
  dryRun: true;
  issue: IssueContract;
  contractValidation: IssueContractValidationResult;
  readyAuthorization: ReadyLabelAuthorizationResult;
  dependencyValidation: DependencyValidationResult;
  execution: JsonObject;
  preflight: PreflightResult;
  mutations: [];
}

type DiffWithBase = GitDiffResult & { baseCommit: string };

/**
 * Everything a `StepHandler` needs, threaded through the dispatch loop by reference
 * (handlers mutate `run` and the scratch fields directly, exactly like `Invoke-HdoRun`
 * mutates its local variables across loop iterations).
 */
interface RunContext {
  run: RunRecord;
  store: RunStore;
  selected: SelectedIssue;
  writeBack: boolean;
  worktree: WorktreeInfo | null;
  projectContract: JsonObject | null;
  taskContract: JsonValue | null;
  previousReview: JsonObject | null;
  previousValidation: ValidationSummary | null;
  finalDiff: DiffWithBase | null;
  pendingTerminal: PendingTerminalOutcome | null;
  iterationPath: string;
  preValidationDiff: GitDiffResult | null;
  diff: DiffWithBase | null;
  validation: ValidationSummary | null;
  git: GitClient;
  gh: GhClient;
  processRunner: ProcessRunner;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  hdoRoot: string;
  schemasDir: string;
  activityCallback?: (event: JsonObject) => unknown;
  now: () => string;
  ambientEnvironment?: Record<string, string | undefined>;
  artifactPath: string;
}

export interface StepOutcome {
  to: RunState;
  reason: string;
}

/**
 * A terminal outcome deferred across the `CHANGES_REQUESTED` transition (the
 * no-diff/validation-escalate/fix-limit paths, Workflow.ps1:417-418, :431-432,
 * :503-504): PS assigns `$run.result` AFTER the `-> CHANGES_REQUESTED`
 * `Set-HdoRunState` call, so the `run.json` saved at that transition still has
 * `result: null`. `result`/`finalDiff` are carried here and only written onto
 * `ctx.run`/`ctx.finalDiff` at the start of `changesRequestedHandler`, just
 * before it returns the terminal outcome for the NEXT transition.
 */
interface PendingTerminalOutcome extends StepOutcome {
  result: RunResult;
  /**
   * Omitted for the fix-limit path: PS assigns `$finalDiff = $diff`
   * unconditionally BEFORE the review-decision fan-out (Workflow.ps1:484), so
   * `ctx.finalDiff` is already correct by the time that branch runs; only the
   * no-diff/validation-escalate paths defer `$finalDiff` itself (Workflow.ps1:419, :433).
   */
  finalDiff?: DiffWithBase;
}

export type StepHandler = (ctx: RunContext) => Promise<StepOutcome>;

/** `[Console]::Error.WriteLine`-style progress sink (Common.ps1:730-742): redacted, and any throw/return value swallowed. */
function invokeProgress(callback: ((event: JsonObject) => unknown) | undefined, event: JsonObject): void {
  if (!callback) return;
  try {
    callback(protectObject(event) as JsonObject);
  } catch {
    // Progress is an observability channel; a closed parent stream must not turn a
    // still-running (or already-finished) HDO run into a failure.
  }
}

/** Oracle: Workflow.ps1:167-184 (`Set-HdoIssuePhaseBestEffort`). */
async function setIssuePhaseBestEffort(ctx: RunContext, labelKey: string, fallback: string): Promise<void> {
  try {
    const label = asString(getValue(ctx.selected.config, labelKey, fallback), fallback);
    await setManagedStatusLabel(
      ctx.gh,
      ctx.selected.config as unknown as ResolvedHdoConfig,
      ctx.git,
      ctx.run.issue.repository,
      ctx.run.issue.number,
      label,
      asString(ctx.selected.config.repositoryPath),
    );
    ctx.store.addEvent({ type: "github.status.updated", label, issue: ctx.run.issue.number });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.run.warnings.push(`GitHub status update failed: ${message}`);
    ctx.store.addEvent({ type: "github.status.failed", labelKey, message: protectText(message) });
    ctx.store.save(ctx.run);
  }
}

/** Oracle: Workflow.ps1:376, `iteration -eq 1 ? 'Initial implementation started.' : 'Fix iteration started.'`. */
function implementationReason(iteration: number): string {
  return iteration === 1 ? REASONS.initialImplementation : REASONS.fixIterationStarted;
}

/** Oracle: Workflow.ps1:383-387 - iteration increment, `iterations/<NNN>` directory, `Save-HdoRun` (BEFORE the `IMPLEMENTING` transition, ADR-0001 phase 6 plan §5 trap 2). */
function beginIteration(ctx: RunContext): void {
  ctx.run.iteration = ctx.run.iteration + 1;
  const iterationName = String(ctx.run.iteration).padStart(3, "0");
  ctx.iterationPath = join(ctx.artifactPath, "iterations", iterationName);
  mkdirSync(ctx.iterationPath, { recursive: true });
  ctx.store.save(ctx.run);
}

/** Oracle: Workflow.ps1:515-518 - written BEFORE the terminal `Set-HdoRunState` call. */
function writeFinalArtifacts(ctx: RunContext): void {
  const finalPath = join(ctx.artifactPath, "final");
  mkdirSync(finalPath, { recursive: true });
  if (ctx.finalDiff) writeTextFile(join(finalPath, "diff.patch"), ctx.finalDiff.patch);
  // Oracle: Workflow.ps1:514, "Workflow ended without a terminal decision." - unreachable
  // on any PS-mirrored path (every producer of a terminal `StepOutcome` sets `run.result`
  // first); kept as the same defensive throw.
  if (!ctx.run.result) throw new Error("Workflow ended without a terminal decision.");
  writeJsonFile(join(finalPath, "summary.json"), ctx.run.result as unknown as JsonValue);
}

// --- Step handlers (Workflow.ps1:331-512), one per non-terminal RunState ------------

async function createdHandler(): Promise<StepOutcome> {
  // Oracle: Workflow.ps1:332.
  return { to: "ISSUE_SELECTED", reason: REASONS.issueSelected };
}

async function issueSelectedHandler(): Promise<StepOutcome> {
  // Oracle: Workflow.ps1:333.
  return { to: "PREFLIGHT", reason: REASONS.preflightChecking };
}

/** Oracle: Workflow.ps1:334-352 (preflight, then either claim or worktree creation). */
async function preflightHandler(ctx: RunContext): Promise<StepOutcome> {
  const preflight = await runPreflight({
    config: ctx.selected.config,
    readOnly: false,
    platform: ctx.platform,
    processRunner: ctx.processRunner,
    git: ctx.git,
    gh: ctx.gh,
    schemas: ctx.schemas,
    now: ctx.now,
  });
  writeJsonFile(join(ctx.artifactPath, "environment.json"), preflight as unknown as JsonValue);
  if (!preflight.ok) {
    // Oracle: Workflow.ps1:337-338.
    const messages = preflight.checks
      .filter((check) => check.required && check.status === "fail")
      .map((check) => `${check.name}: ${check.message}`);
    throw new Error(`Preflight failed: ${messages.join("; ")}`);
  }

  if (ctx.writeBack) {
    // Oracle: Workflow.ps1:341-345.
    const claim = await claimIssue(
      ctx.gh,
      ctx.git,
      ctx.selected.config as unknown as ResolvedHdoConfig,
      ctx.selected.issue,
      ctx.run.id,
      asString(ctx.selected.config.repositoryPath),
    );
    ctx.run.github.claim = claim;
    if (claim.warning) ctx.run.warnings.push(claim.warning);
    ctx.store.save(ctx.run);
    return { to: "ISSUE_CLAIMED", reason: REASONS.issueClaimed };
  }

  const worktree = await createWorktree(ctx.git, ctx.platform, ctx.selected.config, ctx.run.id, ctx.selected.issueNumber, ctx.now);
  ctx.worktree = worktree;
  ctx.run.worktree = worktree;
  writeJsonFile(join(ctx.artifactPath, "worktree.json"), worktree as unknown as JsonValue);
  ctx.store.save(ctx.run);
  return { to: "WORKTREE_READY", reason: REASONS.worktreeReady };
}

/** Oracle: Workflow.ps1:348-352 (worktree creation shared by the write-back path). */
async function issueClaimedHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = await createWorktree(ctx.git, ctx.platform, ctx.selected.config, ctx.run.id, ctx.selected.issueNumber, ctx.now);
  ctx.worktree = worktree;
  ctx.run.worktree = worktree;
  writeJsonFile(join(ctx.artifactPath, "worktree.json"), worktree as unknown as JsonValue);
  ctx.store.save(ctx.run);
  return { to: "WORKTREE_READY", reason: REASONS.worktreeReady };
}

/** Oracle: Workflow.ps1:353-375 (repository-config guard, worktree project contract, plan-vs-synthetic fork). */
async function worktreeReadyHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = ctx.worktree;
  if (!worktree) throw new Error("Workflow ended without a terminal decision.");
  await assertRepositoryConfigSnapshot(ctx.git, ctx.schemas, ctx.selected.config, worktree.path);
  const projectContract = getWorktreeProjectContract(ctx.selected.config, worktree.path, ctx.schemas);
  const worktreeProjectContractHash = sha256Hex(JSON.stringify(projectContract));
  if (worktreeProjectContractHash !== ctx.selected.projectContractHash) {
    // Oracle: Workflow.ps1:356-358.
    throw new Error(
      "The project contract in the fixed base commit differs from the contract validated before worktree creation. Commit or revert the contract change and retry.",
    );
  }
  ctx.projectContract = projectContract;
  writeJsonFile(join(ctx.artifactPath, "project-contract.json"), projectContract as unknown as JsonValue);

  const planBinding = getStepBinding(ctx.selected.config, "plan");
  if (planBinding.enabled) {
    // Oracle: Workflow.ps1:362-363.
    return { to: "PLANNING", reason: REASONS.planningStarted };
  }
  // Oracle: Workflow.ps1:372-375.
  ctx.taskContract = syntheticTaskContract(ctx.selected.issueContract);
  writeJsonFile(join(ctx.artifactPath, "task-contract.json"), ctx.taskContract);
  beginIteration(ctx);
  return { to: "IMPLEMENTING", reason: implementationReason(ctx.run.iteration) };
}

/** Oracle: Workflow.ps1:363-371 (read-only planning step). */
async function planningHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = ctx.worktree;
  const projectContract = ctx.projectContract;
  if (!worktree || !projectContract) throw new Error("Workflow ended without a terminal decision.");
  const planStep = await runAgentStep({
    config: ctx.selected.config,
    run: ctx.run,
    step: "plan",
    iteration: 0,
    workingDirectory: worktree.path,
    prompt: buildPlanPrompt(ctx.selected.issueContract, projectContract as unknown as ProjectContract),
    artifactDirectory: join(ctx.artifactPath, "plan"),
    outputSchema: "task-contract",
    schemas: ctx.schemas,
    schemasDir: ctx.schemasDir,
    hdoRoot: ctx.hdoRoot,
    platform: ctx.platform,
    processRunner: ctx.processRunner,
    ambientEnvironment: ctx.ambientEnvironment,
    activityCallback: ctx.activityCallback,
    onActivity: (activity) => {
      ctx.run.activity = activity;
      ctx.store.save(ctx.run);
    },
  });
  ctx.taskContract = planStep.output;
  await assertWorktreeIntegrity(ctx.git, ctx.platform, worktree.path, worktree.baseCommit);
  const planningDiff = await ctx.git.diff(worktree.path, worktree.baseCommit);
  if (planningDiff.hasChanges) {
    // Oracle: Workflow.ps1:369, "Read-only planning step modified the worktree."
    throw new Error("Read-only planning step modified the worktree.");
  }
  writeJsonFile(join(ctx.artifactPath, "task-contract.json"), ctx.taskContract);
  beginIteration(ctx);
  return { to: "IMPLEMENTING", reason: implementationReason(ctx.run.iteration) };
}

/** Oracle: Workflow.ps1:388-401 (implement/fix agent step, then the pre-validation diff snapshot). */
async function implementingHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = ctx.worktree;
  const projectContract = ctx.projectContract;
  if (!worktree || !projectContract) throw new Error("Workflow ended without a terminal decision.");
  if (ctx.writeBack) {
    await setIssuePhaseBestEffort(ctx, "github.labels.implementing", "hdo:status/implementing");
  }

  const iteration = ctx.run.iteration;
  const stepName = iteration === 1 ? "implement" : "fix";
  const prompt =
    iteration === 1
      ? buildImplementationPrompt(ctx.selected.issueContract, ctx.taskContract, projectContract as unknown as ProjectContract, iteration)
      : buildFixPrompt(
          ctx.selected.issueContract,
          ctx.taskContract,
          projectContract as unknown as ProjectContract,
          ctx.previousReview as unknown as ReviewResult,
          ctx.previousValidation as unknown as JsonValue,
          iteration,
        );
  await runAgentStep({
    config: ctx.selected.config,
    run: ctx.run,
    step: stepName,
    iteration,
    workingDirectory: worktree.path,
    prompt,
    artifactDirectory: join(ctx.iterationPath, stepName),
    outputSchema: "worker-result",
    schemas: ctx.schemas,
    schemasDir: ctx.schemasDir,
    hdoRoot: ctx.hdoRoot,
    platform: ctx.platform,
    processRunner: ctx.processRunner,
    ambientEnvironment: ctx.ambientEnvironment,
    activityCallback: ctx.activityCallback,
    onActivity: (activity) => {
      ctx.run.activity = activity;
      ctx.store.save(ctx.run);
    },
  });
  await assertWorktreeIntegrity(ctx.git, ctx.platform, worktree.path, worktree.baseCommit);
  ctx.preValidationDiff = await ctx.git.diff(worktree.path, worktree.baseCommit);
  return { to: "VALIDATING", reason: REASONS.validatingStarted };
}

/** Oracle: Workflow.ps1:403-424 (validation gates, worktree-observational guard, no-diff/validation-failure policies). */
async function validatingHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = ctx.worktree;
  const projectContract = ctx.projectContract;
  const preValidationDiff = ctx.preValidationDiff;
  if (!worktree || !projectContract || !preValidationDiff) throw new Error("Workflow ended without a terminal decision.");

  const validation = await runValidation({
    issueContract: ctx.selected.issueContract as unknown as JsonObject,
    projectContract,
    worktreePath: worktree.path,
    artifactDirectory: join(ctx.iterationPath, "validation"),
    processRunner: ctx.processRunner,
    platform: ctx.platform,
    ambientEnvironment: ctx.ambientEnvironment,
    now: ctx.now,
  });
  await assertWorktreeIntegrity(ctx.git, ctx.platform, worktree.path, worktree.baseCommit);
  const diff = await ctx.git.diff(worktree.path, worktree.baseCommit);
  if (diff.hash !== preValidationDiff.hash || JSON.stringify(diff.status) !== JSON.stringify(preValidationDiff.status)) {
    // Oracle: Workflow.ps1:408, "A validation gate modified the worktree; validation gates must be observational."
    throw new Error("A validation gate modified the worktree; validation gates must be observational.");
  }
  // Oracle: Workflow.ps1:410, `$diff['baseCommit'] = $worktree.baseCommit` - appended LAST.
  const diffWithBase: DiffWithBase = { ...diff, baseCommit: worktree.baseCommit };
  writeTextFile(join(ctx.iterationPath, "diff.patch"), diffWithBase.patch);
  const { patch: _patch, ...diffMetadata } = diffWithBase;
  writeJsonFile(join(ctx.iterationPath, "diff.json"), diffMetadata as unknown as JsonValue);
  ctx.diff = diffWithBase;

  const noDiffDecision = decideNoDiff(diffWithBase.hasChanges, ctx.selected.config);
  if (noDiffDecision.kind === "fail") throw new Error(noDiffDecision.message);
  if (noDiffDecision.kind === "escalate") {
    // Oracle: Workflow.ps1:417-418 - `$run.result` is assigned AFTER the
    // `-> CHANGES_REQUESTED` transition, not here; see `PendingTerminalOutcome`.
    ctx.pendingTerminal = {
      to: "ESCALATED",
      reason: REASONS.noDiffEscalated,
      result: noDiffEscalateResult(diffWithBase.hash, ctx.now()),
      finalDiff: diffWithBase,
    };
    return { to: "CHANGES_REQUESTED", reason: REASONS.noDiff };
  }

  const validationDecision = decideValidation(validation.allRequiredPassed, ctx.selected.config);
  if (validationDecision.kind === "fail") throw new Error(validationDecision.message);
  if (validationDecision.kind === "escalate") {
    // Oracle: Workflow.ps1:431-432 - deferred exactly like the no-diff case above.
    ctx.pendingTerminal = {
      to: "ESCALATED",
      reason: REASONS.validationEscalated,
      result: validationEscalateResult(diffWithBase.hash, validation as unknown as JsonObject, ctx.now()),
      finalDiff: diffWithBase,
    };
    return { to: "CHANGES_REQUESTED", reason: REASONS.validationFailed };
  }

  ctx.validation = validation;
  return { to: "REVIEWING", reason: REASONS.reviewingStarted };
}

/** Oracle: Workflow.ps1:426-511 (structured review, synthetic validation blocker, decision fan-out). */
async function reviewingHandler(ctx: RunContext): Promise<StepOutcome> {
  const worktree = ctx.worktree;
  const projectContract = ctx.projectContract;
  const validation = ctx.validation;
  const diff = ctx.diff;
  if (!worktree || !projectContract || !validation || !diff) throw new Error("Workflow ended without a terminal decision.");

  if (ctx.writeBack) {
    await setIssuePhaseBestEffort(ctx, "github.labels.review", "hdo:status/review");
  }

  const reviewStep = await runAgentStep({
    config: ctx.selected.config,
    run: ctx.run,
    step: "review",
    iteration: ctx.run.iteration,
    workingDirectory: worktree.path,
    prompt: buildReviewPrompt(
      ctx.selected.issueContract,
      ctx.taskContract,
      projectContract as unknown as ProjectContract,
      validation as unknown as JsonValue,
      { baseCommit: diff.baseCommit, hash: diff.hash, patch: diff.patch },
      ctx.previousReview as unknown as ReviewResult | undefined,
      ctx.run.iteration,
      ctx.run.id,
    ),
    artifactDirectory: join(ctx.iterationPath, "review"),
    outputSchema: "review-result",
    schemas: ctx.schemas,
    schemasDir: ctx.schemasDir,
    hdoRoot: ctx.hdoRoot,
    platform: ctx.platform,
    processRunner: ctx.processRunner,
    ambientEnvironment: ctx.ambientEnvironment,
    activityCallback: ctx.activityCallback,
    onActivity: (activity) => {
      ctx.run.activity = activity;
      ctx.store.save(ctx.run);
    },
  });
  let review = reviewStep.output as JsonObject;
  await assertWorktreeIntegrity(ctx.git, ctx.platform, worktree.path, worktree.baseCommit);
  const postReviewDiff = await ctx.git.diff(worktree.path, worktree.baseCommit);
  if (postReviewDiff.hash !== diff.hash || JSON.stringify(postReviewDiff.status) !== JSON.stringify(diff.status)) {
    // Oracle: Workflow.ps1:448, "Read-only review step modified the reviewed worktree; its decision is stale and was rejected."
    throw new Error("Read-only review step modified the reviewed worktree; its decision is stale and was rejected.");
  }

  const reviewCheck = testReviewResult(review, ctx.previousReview ?? undefined, ctx.run.iteration, ctx.run.id, worktree.baseCommit, diff.hash);
  if (!reviewCheck.valid) {
    // Oracle: Workflow.ps1:451, "Review result is invalid: <errors joined by '; '>"
    throw new Error(`Review result is invalid: ${reviewCheck.errors.join("; ")}`);
  }

  if (equalsIgnoreCase(asString(review.decision), "approve") && !validation.allRequiredPassed) {
    // Oracle: Workflow.ps1:453-479 (#16-driven synthetic validation blocker).
    review = applyValidationBlocker(review, validation as unknown as JsonObject, ctx.run.iteration, (value) => JSON.stringify(value));
    const transformedSchemaValidation = ctx.schemas.get("review-result")(review);
    if (!transformedSchemaValidation.valid) {
      throw new Error(`HDO produced an invalid validation blocker review: ${transformedSchemaValidation.errors.join("; ")}`);
    }
    const transformedReviewValidation = testReviewResult(
      review,
      ctx.previousReview ?? undefined,
      ctx.run.iteration,
      ctx.run.id,
      worktree.baseCommit,
      diff.hash,
    );
    if (!transformedReviewValidation.valid) {
      throw new Error(`HDO produced an invalid validation blocker review: ${transformedReviewValidation.errors.join("; ")}`);
    }
  }
  writeJsonFile(join(ctx.iterationPath, "review", "result.json"), review);
  ctx.previousReview = review;
  ctx.previousValidation = validation;
  ctx.finalDiff = diff;

  const decision = decideReview(review, ctx.run.fixAttempts, ctx.run.maxFixAttempts, ctx.selected.config);
  if (decision.kind === "fail") throw new Error(decision.message);
  if (decision.kind === "approve") {
    ctx.run.result = approveResult(review, diff.hash, validation as unknown as JsonObject, ctx.now());
    return { to: "APPROVED", reason: REASONS.approved };
  }
  if (decision.kind === "escalate") {
    ctx.run.result = reviewEscalateResult(review, diff.hash, ctx.now());
    return { to: "ESCALATED", reason: decision.reason };
  }
  if (decision.kind === "fix-limit") {
    // Oracle: Workflow.ps1:503-504 - `$run.result` is assigned AFTER the
    // `-> CHANGES_REQUESTED` transition; `finalDiff` is already correct (set
    // unconditionally above, matching Workflow.ps1:484), so it is not deferred here.
    ctx.pendingTerminal = {
      to: "ESCALATED",
      reason: REASONS.maxFixReached,
      result: maxFixEscalateResult(hdoArrayItems(review.findings), diff.hash, ctx.now()),
    };
    return { to: "CHANGES_REQUESTED", reason: REASONS.fixLimitReached };
  }
  // decision.kind === "request-changes"
  ctx.run.fixAttempts += 1;
  return { to: "CHANGES_REQUESTED", reason: REASONS.actionableFindings };
}

/** Oracle: Workflow.ps1:503-512 (either the fix-limit/no-diff/validation pending terminal, or another fix iteration). */
async function changesRequestedHandler(ctx: RunContext): Promise<StepOutcome> {
  if (ctx.pendingTerminal) {
    const outcome = ctx.pendingTerminal;
    ctx.pendingTerminal = null;
    // Oracle: Workflow.ps1:417-418/:431-432/:503-504 - `$run.result` (and, for the
    // no-diff/validation-escalate paths, `$finalDiff`) is assigned here, AFTER the
    // `-> CHANGES_REQUESTED` transition already saved `run.json` with `result: null`,
    // and BEFORE returning the deferred terminal outcome for the next transition.
    ctx.run.result = outcome.result;
    if (outcome.finalDiff) ctx.finalDiff = outcome.finalDiff;
    return { to: outcome.to, reason: outcome.reason };
  }
  if (ctx.writeBack) {
    await setIssuePhaseBestEffort(ctx, "github.labels.changesRequested", "hdo:status/changes-requested");
  }
  beginIteration(ctx);
  return { to: "IMPLEMENTING", reason: implementationReason(ctx.run.iteration) };
}

/** Exhaustive over `NonTerminalRunState` (ADR-0003 D1); `run.test.ts` pins the key set. */
export const STEP_HANDLERS: Record<NonTerminalRunState, StepHandler> = {
  CREATED: createdHandler,
  ISSUE_SELECTED: issueSelectedHandler,
  PREFLIGHT: preflightHandler,
  ISSUE_CLAIMED: issueClaimedHandler,
  WORKTREE_READY: worktreeReadyHandler,
  PLANNING: planningHandler,
  IMPLEMENTING: implementingHandler,
  VALIDATING: validatingHandler,
  REVIEWING: reviewingHandler,
  CHANGES_REQUESTED: changesRequestedHandler,
};

/**
 * The dispatch loop itself (ADR-0003 D1): repeatedly invokes the handler for the
 * current state, validates its answer with `transition()` (defensive - every
 * PS-mirrored handler only ever returns a legal `to`; this only matters for an
 * intentionally-broken handler, as in `run.test.ts`'s illegal-transition unit test),
 * writes the terminal artifacts BEFORE a terminal transition (Workflow.ps1:493-498,
 * mirrored for the `CHANGES_REQUESTED` pending-terminal path too), then lets
 * `RunStore.setState` perform the actual mutation + `state.transition` event.
 */
async function drive(ctx: RunContext): Promise<void> {
  while (!isTerminalState(ctx.run.state)) {
    const handler = STEP_HANDLERS[ctx.run.state as NonTerminalRunState];
    const outcome = await handler(ctx);
    transition(ctx.run.state, outcome.to);
    if (isTerminalState(outcome.to)) {
      writeFinalArtifacts(ctx);
    }
    ctx.store.setState(ctx.run, outcome.to, outcome.reason);
  }
}

/**
 * Port of `Invoke-HdoRun` (Workflow.ps1:228-561). The issue-selection prologue and
 * (for `-DryRun`) the read-only preflight run entirely OUTSIDE any try/catch here,
 * exactly like Workflow.ps1:244-291 sits before its own `try {` at :331 - a throw from
 * either propagates unchanged to the caller (mirrors hdo.ps1's own top-level catch,
 * exit 2, or exit 4 for "No eligible HDO Issue*").
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunRecord | DryRunResult> {
  const now = options.now ?? ((): string => new Date().toISOString());

  const selected = await selectIssue({
    config: options.config,
    repository: options.repository,
    issueNumber: options.issueNumber,
    pick: options.pick,
    gh: options.gh,
    git: options.git,
    schemas: options.schemas,
    reresolveConfig: options.reresolveConfig,
    explicitProfile: options.explicitProfile,
    now,
  });
  const executionPlan = getExecutionPlan(selected.config, now());

  if (options.dryRun) {
    // Oracle: Workflow.ps1:278-291.
    const preflight = await runPreflight({
      config: selected.config,
      readOnly: true,
      platform: options.platform,
      processRunner: options.processRunner,
      git: options.git,
      gh: options.gh,
      schemas: options.schemas,
      now,
    });
    return {
      kind: "execution-plan",
      dryRun: true,
      issue: selected.issueContract,
      contractValidation: selected.contractValidation,
      readyAuthorization: selected.readyAuthorization,
      dependencyValidation: selected.dependencyValidation,
      execution: executionPlan as unknown as JsonObject,
      preflight,
      mutations: [],
    };
  }

  // Oracle: Workflow.ps1:293-296.
  const runId = options.newRunId
    ? options.newRunId(selected.issueNumber)
    : newRunId(selected.issueNumber, new Date(), randomUUID().replace(/-/g, "").slice(0, 8));
  const artifactRoot = asString(getValue(selected.config, "paths.artifactRoot"));
  const artifactPath = join(artifactRoot, runId);
  mkdirSync(artifactPath, { recursive: true });
  const writeBack = isWriteBackEnabled(selected.config, options.noWriteBack);

  // Oracle: Workflow.ps1:297-316.
  const createdAt = now();
  const run = createRunRecord({
    id: runId,
    now: createdAt,
    repositoryPath: options.repositoryRoot,
    artifactPath,
    config: selected.config,
    issueContract: selected.issueContract,
    executionPlan: executionPlan as unknown as JsonObject,
    readyAuthorization: selected.readyAuthorization,
    dependencyValidation: selected.dependencyValidation,
    contractWarnings: selected.contractValidation.warnings,
    writeBack,
  });
  const store = new RunStore({ artifactPath, now });

  // Oracle: Workflow.ps1:317-329 - OUTSIDE the try; a throw here propagates unchanged.
  store.save(run);
  store.addEvent({ type: "run.created", runId });
  invokeProgress(options.activityCallback, {
    type: "run.created",
    at: now(),
    runId,
    state: run.state,
    artifactPath,
  });
  writeJsonFile(join(artifactPath, "issue.raw.json"), selected.issue as unknown as JsonValue);
  writeJsonFile(join(artifactPath, "issue.contract.json"), selected.issueContract as unknown as JsonValue);
  writeJsonFile(join(artifactPath, "execution-plan.json"), executionPlan as unknown as JsonValue);
  writeJsonFile(join(artifactPath, "effective-config.redacted.json"), protectObject(selected.config) as JsonValue);

  const ctx: RunContext = {
    run,
    store,
    selected,
    writeBack,
    worktree: null,
    projectContract: null,
    taskContract: null,
    previousReview: null,
    previousValidation: null,
    finalDiff: null,
    pendingTerminal: null,
    iterationPath: "",
    preValidationDiff: null,
    diff: null,
    validation: null,
    git: options.git,
    gh: options.gh,
    processRunner: options.processRunner,
    platform: options.platform,
    schemas: options.schemas,
    hdoRoot: options.hdoRoot,
    schemasDir: options.schemasDir,
    activityCallback: options.activityCallback,
    now,
    ambientEnvironment: options.ambientEnvironment,
    artifactPath,
  };

  try {
    // Oracle: Workflow.ps1:331-512 (the dispatch loop lives in `drive()`; see its doc comment).
    await drive(ctx);

    // Oracle: Workflow.ps1:519-535.
    invokeProgress(options.activityCallback, {
      type: "run.completed",
      at: now(),
      runId,
      state: run.state,
      artifactPath,
    });
    if (writeBack) {
      try {
        await completeClaim(
          options.gh,
          selected.config as unknown as ResolvedHdoConfig,
          options.git,
          run,
          run.state,
          asString(run.result?.summary ?? ""),
          asString(selected.config.repositoryPath),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.warnings.push(`Final GitHub writeback failed: ${message}`);
        store.addEvent({ type: "github.finalize.failed", message: protectText(message) });
        store.save(run);
      }
    }
    return run;
  } catch (error) {
    // Oracle: Workflow.ps1:537-559.
    const message = protectText(error instanceof Error ? error.message : String(error));
    run.error = { category: classifyRunFailure(run.state), message, at: now() };
    if (!isTerminalState(run.state)) {
      try {
        store.setState(run, "FAILED", message);
      } catch {
        run.state = "FAILED";
        store.save(run);
      }
    } else {
      store.save(run);
    }
    if (writeBack && run.github.claim?.commentId) {
      try {
        await completeClaim(
          options.gh,
          selected.config as unknown as ResolvedHdoConfig,
          options.git,
          run,
          "FAILED",
          message,
          asString(selected.config.repositoryPath),
        );
      } catch (innerError) {
        const innerMessage = innerError instanceof Error ? innerError.message : String(innerError);
        run.warnings.push(`Failure writeback also failed: ${innerMessage}`);
        store.save(run);
      }
    }
    invokeProgress(options.activityCallback, {
      type: "run.completed",
      at: now(),
      runId,
      state: run.state,
      artifactPath,
    });
    return run;
  }
}
