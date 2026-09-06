// Pure run-object builders for `Invoke-HdoRun` (Workflow.ps1:216-549). This module
// owns the `run.json` shape (the initial object plus the terminal `result`/`error`
// variants), the verbatim transition-reason/summary strings, and the two small pure
// helpers (`New-HdoRunId`, `New-HdoSyntheticTaskContract`, `Test-HdoWriteBackEnabled`)
// that have no host dependency. The dispatch loop itself (`drive()`), `RunStore`, and
// everything that touches the filesystem/git/gh live in `src/workflow/**` (host).
//
// `ReadyLabelAuthorizationResult`, `DependencyValidationResult`, and `ClaimResult`
// already live in `../contracts/types.ts` (not under `src/github/` as an earlier
// draft of the phase-6 plan assumed - verified against the checked-out tree on
// 2026-09-06), so `RunGithub` below imports them directly instead of re-declaring
// structural equivalents or falling back to `JsonObject`.
import type {
  ClaimResult,
  DependencyValidationResult,
  IssueContract,
  IssueContractIssue,
  JsonObject,
  JsonValue,
  ReadyLabelAuthorizationResult,
} from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import type { RunState } from "../state/index.ts";
import { asNumber, asString, hdoArrayItems, inIgnoreCase } from "../runners/psSemantics.ts";

/** `$run.result` (Workflow.ps1:401-403, 417-418, 465-466, 470-471, 479-480). */
export interface RunResult {
  decision: "approve" | "escalate";
  summary: string;
  reason?: string;
  findings?: JsonValue[];
  diffHash: string;
  validation?: JsonObject;
  completedAt: string;
}

/** `$run.error` (Workflow.ps1:524-526). */
export interface RunError {
  category: "PREFLIGHT_FAILED" | "RUN_FAILED";
  message: string;
  at: string;
}

/** `$run.worktree` (Git.ps1:117-123). */
export interface RunWorktree {
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
}

/** `$run.github` (Workflow.ps1:299). */
export interface RunGithub {
  writeBack: boolean;
  readyAuthorization: ReadyLabelAuthorizationResult;
  dependencyValidation: DependencyValidationResult;
  claim: ClaimResult | null;
}

/** `$run` (Workflow.ps1:280-299, key order preserved; then mutated by the dispatch loop). */
export interface RunRecord {
  schemaVersion: 1;
  id: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  repositoryPath: string;
  artifactPath: string;
  profile: JsonValue;
  iteration: number;
  fixAttempts: number;
  maxFixAttempts: number;
  issue: IssueContractIssue;
  execution: JsonObject;
  worktree: RunWorktree | null;
  github: RunGithub;
  result: RunResult | null;
  error: RunError | null;
  warnings: string[];
  // Present only after the first `Invoke-HdoAgentStep` call (Runner.ps1:618, 677) -
  // absent (never `undefined` explicitly assigned) until then, `null` once a step has
  // finished. `createRunRecord` never sets this key; the host's `onActivity` hook does.
  activity?: JsonObject | null;
}

/**
 * `[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')` (Common.ps1:703). Both `T`
 * and the trailing `Z` are literals in the .NET custom format string, not format
 * specifiers - built here from the UTC field accessors rather than string-sliced out
 * of `toISOString()` (which would carry milliseconds instead).
 */
export function formatRunIdStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hours = pad(now.getUTCHours());
  const minutes = pad(now.getUTCMinutes());
  const seconds = pad(now.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Oracle: Common.ps1:701-708 (`New-HdoRunId`). `$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)`
 * is injected as `hex8` (core may not touch `node:crypto`); the `IssueNumber <= 0` ->
 * `run-<stamp>-<hex>` branch is unreachable from `Invoke-HdoRun` (every caller passes a
 * resolved positive issue number) but is kept faithfully since `New-HdoRunId` itself is
 * a general-purpose helper in PS.
 */
export function newRunId(issueNumber: number, now: Date, hex8: string): string {
  const stamp = formatRunIdStamp(now);
  const suffix = hex8.toLowerCase();
  return issueNumber > 0 ? `issue-${issueNumber}-${stamp}-${suffix}` : `run-${stamp}-${suffix}`;
}

/**
 * Oracle: Workflow.ps1:156-165 (`Test-HdoWriteBackEnabled`). `-NoWriteBack` always
 * wins; a real JSON boolean is returned as-is (a bool `false` must not fall into the
 * string-comparison branch below it); otherwise the setting is stringified and
 * compared case-insensitively against the "off" spellings (`[string]$null` is `''`,
 * which is one of them).
 */
export function isWriteBackEnabled(config: JsonObject, noWriteBack: boolean): boolean {
  if (noWriteBack) return false;
  const setting = getValue(config, "github.writeBack", "status");
  if (typeof setting === "boolean") return setting;
  return !inIgnoreCase(asString(setting), ["", "none", "false", "off"]);
}

/** Every transition reason string, verbatim (Workflow.ps1, §2.3 of the phase-6 plan). */
export const REASONS = {
  // Oracle: Workflow.ps1:316 (CREATED -> ISSUE_SELECTED)
  issueSelected: "GitHub Issue resolved and contract validated.",
  // Oracle: Workflow.ps1:317 (ISSUE_SELECTED -> PREFLIGHT)
  preflightChecking: "Checking selected adapters and local environment.",
  // Oracle: Workflow.ps1:333 (PREFLIGHT -> ISSUE_CLAIMED)
  issueClaimed: "GitHub claim marker won the best-effort lock.",
  // Oracle: Workflow.ps1:340 (PREFLIGHT/ISSUE_CLAIMED -> WORKTREE_READY)
  worktreeReady: "Isolated Git worktree created.",
  // Oracle: Workflow.ps1:351 (WORKTREE_READY -> PLANNING)
  planningStarted: "Read-only planning step started.",
  // Oracle: Workflow.ps1:376, iteration === 1 (-> IMPLEMENTING)
  initialImplementation: "Initial implementation started.",
  // Oracle: Workflow.ps1:376, iteration > 1 (-> IMPLEMENTING)
  fixIterationStarted: "Fix iteration started.",
  // Oracle: Workflow.ps1:390 (IMPLEMENTING -> VALIDATING)
  validatingStarted: "Trusted project validation gates started.",
  // Oracle: Workflow.ps1:402 (VALIDATING -> CHANGES_REQUESTED, onNoDiff=escalate)
  noDiff: "Implementation produced no diff.",
  // Oracle: Workflow.ps1:417 (VALIDATING -> CHANGES_REQUESTED, onValidationFailure=escalate)
  validationFailed: "Required validation did not pass.",
  // Oracle: Workflow.ps1:426 (VALIDATING -> REVIEWING)
  reviewingStarted: "Read-only structured review started.",
  // Oracle: Workflow.ps1:478 (REVIEWING -> CHANGES_REQUESTED, fixAttempts >= max)
  fixLimitReached: "Reviewer requested changes at the fix limit.",
  // Oracle: Workflow.ps1:485 (REVIEWING -> CHANGES_REQUESTED, otherwise)
  actionableFindings: "Reviewer returned actionable findings.",
  // Oracle: Workflow.ps1:467 (REVIEWING -> APPROVED)
  approved: "Reviewer approved a diff with all required validation gates passing.",
  // Oracle: Workflow.ps1:406 (CHANGES_REQUESTED -> ESCALATED, from no-diff escalate)
  noDiffEscalated: "No diff requires Human attention.",
  // Oracle: Workflow.ps1:421 (CHANGES_REQUESTED -> ESCALATED, from validation escalate)
  validationEscalated: "Validation policy requires Human attention.",
  // Oracle: Workflow.ps1:481 (CHANGES_REQUESTED -> ESCALATED, fix limit)
  maxFixReached: "Maximum fix attempts reached.",
  // Oracle: Workflow.ps1:474, REVIEWING -> ESCALATED uses `[string]$review.escalationReason`
  // (dynamic - not a constant, see `decideReview`'s `escalate` variant), and any -> FAILED
  // uses the redacted failure message itself (:526-528, also dynamic) - neither belongs here.
} as const;

/** `$run.result.summary` literals that are not transition reasons (Workflow.ps1 §2.4). */
export const SUMMARIES = {
  // Oracle: Workflow.ps1:403
  noDiff: "Implementation produced no diff.",
  // Oracle: Workflow.ps1:418
  validation: "Required validation did not pass.",
  // Oracle: Workflow.ps1:480
  maxFix: "Maximum fix attempts reached with open findings.",
} as const;

/** Oracle: Workflow.ps1:525 (`$run.state -eq 'PREFLIGHT'` at catch time). */
export function classifyRunFailure(state: RunState): RunError["category"] {
  return state === "PREFLIGHT" ? "PREFLIGHT_FAILED" : "RUN_FAILED";
}

/**
 * Oracle: Workflow.ps1:280-299. Builds the initial `run.json` object with the exact
 * key order PS produces (`[ordered]@{...}`); `now` is the single formatted timestamp
 * string the host computed once and reuses for both `createdAt` and `updatedAt` (the
 * two `Get-HdoUtcTimestamp` calls at :285-286 differ by microseconds in PS, but that
 * divergence is not observable through any parity comparison - §3.5 strips both
 * fields). `activity` is intentionally never set here (see the `RunRecord.activity`
 * doc comment above).
 */
export function createRunRecord(input: {
  id: string;
  now: string;
  repositoryPath: string;
  artifactPath: string;
  config: JsonObject;
  issueContract: IssueContract;
  executionPlan: JsonObject;
  readyAuthorization: ReadyLabelAuthorizationResult;
  dependencyValidation: DependencyValidationResult;
  contractWarnings: string[];
  writeBack: boolean;
}): RunRecord {
  const maxFixAttempts = Math.trunc(asNumber(getValue(input.config, "workflow.maxFixAttempts"), 0));
  const configurationWarnings = hdoArrayItems(getValue(input.config, "configurationWarnings")).map((warning) =>
    asString(warning),
  );
  return {
    schemaVersion: 1,
    id: input.id,
    state: "CREATED",
    createdAt: input.now,
    updatedAt: input.now,
    repositoryPath: input.repositoryPath,
    artifactPath: input.artifactPath,
    profile: (getValue(input.config, "resolvedProfile") ?? null) as JsonValue,
    iteration: 0,
    fixAttempts: 0,
    maxFixAttempts,
    issue: input.issueContract.issue,
    execution: input.executionPlan,
    worktree: null,
    github: {
      writeBack: input.writeBack,
      readyAuthorization: input.readyAuthorization,
      dependencyValidation: input.dependencyValidation,
      claim: null,
    },
    result: null,
    error: null,
    warnings: [...input.contractWarnings, ...configurationWarnings],
  };
}

/**
 * Oracle: Workflow.ps1:199-211 (`New-HdoSyntheticTaskContract`), used when the `plan`
 * step is disabled.
 */
export function syntheticTaskContract(issueContract: IssueContract): JsonObject {
  return {
    schemaVersion: 1,
    objective: issueContract.goal,
    approach: ["Implement the normalized GitHub Issue contract directly."],
    acceptanceCriteria: issueContract.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.text}`),
    expectedFiles: [],
    risks: [],
    assumptions: [],
  };
}

/** Oracle: Workflow.ps1:466 - key order `decision, summary, diffHash, validation, completedAt`. */
export function approveResult(review: JsonObject, diffHash: string, validation: JsonObject, now: string): RunResult {
  return {
    decision: "approve",
    summary: asString(review.summary),
    diffHash,
    validation,
    completedAt: now,
  };
}

/** Oracle: Workflow.ps1:471 - key order `decision, summary, reason, diffHash, completedAt`. */
export function reviewEscalateResult(review: JsonObject, diffHash: string, now: string): RunResult {
  return {
    decision: "escalate",
    summary: asString(review.summary),
    reason: asString(review.escalationReason),
    diffHash,
    completedAt: now,
  };
}

/** Oracle: Workflow.ps1:403 - key order `decision, summary, diffHash, completedAt` (no `reason`). */
export function noDiffEscalateResult(diffHash: string, now: string): RunResult {
  return {
    decision: "escalate",
    summary: SUMMARIES.noDiff,
    diffHash,
    completedAt: now,
  };
}

/** Oracle: Workflow.ps1:418 - key order `decision, summary, diffHash, validation, completedAt`. */
export function validationEscalateResult(diffHash: string, validation: JsonObject, now: string): RunResult {
  return {
    decision: "escalate",
    summary: SUMMARIES.validation,
    diffHash,
    validation,
    completedAt: now,
  };
}

/** Oracle: Workflow.ps1:480 - key order `decision, summary, findings, diffHash, completedAt`. */
export function maxFixEscalateResult(findings: JsonValue[], diffHash: string, now: string): RunResult {
  return {
    decision: "escalate",
    summary: SUMMARIES.maxFix,
    findings,
    diffHash,
    completedAt: now,
  };
}
