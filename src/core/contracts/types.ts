// Hand-written TypeScript subsets of the canonical JSON Schemas under `schemas/`.
// These types exist for editor ergonomics only. Runtime correctness is always
// enforced by validating against the real schema files with Ajv (see validate.ts);
// nothing here is a substitute for that validation. Adapted from poc/typescript.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RunnerConfig {
  type: "codex" | "claude" | "command";
  provider: "cloud" | "ollama" | "lmstudio" | "custom";
  command: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  contextTokens?: number;
  sandbox: "read-only" | "workspace-write";
  timeoutSeconds: number;
  passEnvironment: string[];
  extraArgs: string[];
  promptTransport?: "stdin" | "file";
  allowedTools?: string[];
}

export interface StepReference {
  enabled: boolean;
  runner?: string;
}

export type StepValue = string | StepReference;

export interface ProfileConfig {
  steps: {
    plan?: StepValue;
    implement: StepValue;
    review: StepValue;
    fix: StepValue;
  };
}

export interface GithubLabels {
  ready: string;
  skip: string;
  statusPrefix: string;
  claimed: string;
  implementing: string;
  review: string;
  changesRequested: string;
  approved: string;
  escalated: string;
  failed: string;
  cancelled: string;
}

export interface GithubConfig {
  repository?: string | null;
  labels: GithubLabels;
  priorityOrder: string[];
  writeBack: "none" | "status";
  candidateLimit: number;
  assignOnClaim: boolean;
  trustedActors?: string[];
  claimLeaseHours?: number;
}

export interface WorkflowConfig {
  maxFixAttempts: number;
  implicitFallback: false;
  onNoDiff: "fail" | "escalate";
  onValidationFailure: "request-changes" | "escalate" | "fail";
  onMaxFixAttempts: "escalate" | "fail";
}

export interface PathsConfig {
  worktreeRoot: string;
  artifactRoot: string;
}

/** Raw configuration shape as read from a single JSON source (before merge). */
export interface HdoConfigSource {
  $schema?: string;
  schemaVersion: 1;
  activeProfile?: string;
  profiles?: Record<string, ProfileConfig>;
  runners?: Record<string, RunnerConfig>;
  github?: GithubConfig;
  workflow?: WorkflowConfig;
  paths?: PathsConfig;
  projectContractPath?: string;
}

/**
 * Fully merged and resolved configuration, ready for schema validation. This is a
 * plain descriptive interface (no index signature): callers move between this and
 * the generic `JsonObject` shape used by `deepMergeConfig`/`validateAgainstSchema`
 * with an explicit `as unknown as` cast at the boundary, since editor ergonomics and
 * "is structurally a JsonObject" are different concerns (see the file banner above).
 */
export interface ResolvedHdoConfig {
  $schema?: string;
  schemaVersion: 1;
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
  runners: Record<string, RunnerConfig>;
  github: GithubConfig;
  workflow: WorkflowConfig;
  paths: PathsConfig;
  projectContractPath: string;
  steps?: Record<string, StepValue>;
  resolvedProfile?: string;
  repositoryPath?: string;
  configSources?: string[];
  repositoryConfig?: JsonObject;
  configurationWarnings?: string[];
}

export interface ValidationGate {
  id: string;
  description?: string;
  command: string;
  args: string[];
  workingDirectory?: string;
  required: boolean;
  timeoutSeconds: number;
  exitCodes: {
    passed: number[];
    failed: number[];
    indeterminate: number[];
  };
  continueAfterFailure: boolean;
}

export interface ProjectContract {
  schemaVersion: 1;
  instructions: {
    files: string[];
    specificationPaths: string[];
  };
  validationGates: ValidationGate[];
  workerPolicy: {
    networkAccess: "denied" | "allowed";
    oneWriterPerWorktree: true;
    allowCommit: false;
    allowPush: false;
    forbiddenCommands: string[];
    protectedPaths: string[];
  };
  reviewPolicy: {
    defaultViewpoints: string[];
    highRiskPaths: string[];
    largeChangeLines: number;
    onMissingViewpoint: "escalate";
    stableFindingIds: true;
    mutation: {
      enabled: boolean;
      oneWriterWindow: true;
      indeterminateIsSuccess: false;
    };
  };
}

export type FindingSeverity = "blocker" | "should" | "nit";
export type FindingStatus = "open" | "resolved" | "waived" | "refuted" | "indeterminate";

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  category: "product_bug" | "test_detection" | "docs" | "spec_decision" | "process" | "minor";
  evidence: "measured" | "read";
  evidenceDetail: string;
  status: FindingStatus;
  actionable: boolean;
  path: string;
  line: number | null;
  message: string;
  requiredAction: string | null;
}

export interface ReviewResult {
  schemaVersion: 1;
  runId: string;
  baseCommit: string;
  diffHash: string;
  reviewRound: number;
  decision: "approve" | "request_changes" | "escalate";
  summary: string;
  missingViewpoints: string[];
  findings: ReviewFinding[];
  escalationReason: string | null;
}

// ADR-0001 phase 4 (github): types backing `src/github/**`, a port of
// `src/HybridDevOrchestrator/Private/GitHub.ps1`.

/**
 * A normalized GitHub Issue as returned by `GhClient.getIssue`/`gh issue list`
 * (GitHub.ps1: `Get-HdoIssue`, `Get-HdoIssueCandidate`). `labels` is always already
 * normalized to plain names (`Get-HdoLabelNames`); every other GitHub API field the
 * CLI's `--json` selection can return is passed through untyped, since callers only
 * ever read a handful of them by name and the rest exist solely to be handed back to
 * `gh issue edit`/stored on a run record.
 */
export interface GithubIssue {
  repository: string;
  number: number;
  url: string;
  updatedAt: string;
  title: string;
  state: string;
  labels: string[];
  body: string;
  assignees?: JsonValue;
  author?: JsonValue;
  createdAt?: JsonValue;
  milestone?: JsonValue;
  comments?: JsonValue;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export interface IssueDependency {
  repository: string;
  number: number;
}

/** The `issue` sub-object of an `IssueContract` (`schemas/issue-contract.schema.json#/$defs/issue`). */
export interface IssueContractIssue {
  repository: string;
  number: number;
  url: string;
  updatedAt: string;
  title: string;
  state: string;
  labels: string[];
  bodyHash: string;
}

/** Mirrors `schemas/issue-contract.schema.json` / `ConvertTo-HdoIssueContract` (GitHub.ps1). */
export interface IssueContract {
  schemaVersion: 1;
  issue: IssueContractIssue;
  goal: string;
  context: string;
  scope: { include: string[]; exclude: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  validationGates: string[];
  constraints: string[];
  dependencies: IssueDependency[];
  affectedAreas: string[];
  additionalContext: string;
  priority: string;
  risk: string;
  preferredExecution: string;
  capturedAt: string;
}

export interface IssueContractValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Mirrors `Test-HdoReadyContentFreshness`'s `[ordered]@{ fresh; reason }` (GitHub.ps1). */
export interface ReadyContentFreshnessResult {
  fresh: boolean;
  reason: string;
}

/**
 * Mirrors `Test-HdoReadyLabelAuthorization`'s return shape (GitHub.ps1). `readyAt`/
 * `actor` are `null` only in the "no label event was found" branch; `lastEditedAt` is
 * absent in that same branch (PowerShell's `[ordered]@{}` simply never adds the key).
 */
export interface ReadyLabelAuthorizationResult {
  authorized: boolean;
  enforced: boolean;
  actor: string | null;
  readyAt: string | null;
  lastEditedAt?: string;
  reason: string;
}

/** A `GithubIssue` annotated with its resolved pickup-order rank (`Get-HdoIssueCandidate`, GitHub.ps1). */
export type IssueCandidate = GithubIssue & { priorityRank: number };

export interface DependencyCheck {
  repository: string;
  number: number;
  state: string;
  resolved: boolean;
  error: string | null;
}

export interface DependencyValidationResult {
  resolved: boolean;
  checks: DependencyCheck[];
  unresolved: DependencyCheck[];
}

/** The `<!-- hdo:claim:v1 {...} -->` marker embedded in a claim comment body (GitHub.ps1). */
export interface ClaimMarker {
  version: number;
  kind: string;
  runId: string;
  issueKey: string;
  claimedBy: string;
  claimedAt: string;
  leaseExpiresAt: string;
  state: "active" | "released";
}

/** A parsed, validated claim comment (`Get-HdoClaimComments`, GitHub.ps1). */
export interface ClaimComment {
  runId: string;
  status: string;
  id: number;
  createdAt: string;
  author: string;
  marker: ClaimMarker;
  body: string;
}

export interface ClaimResult {
  commentId: number;
  marker: ClaimMarker;
  claimedAt: string;
  warning: string | null;
}

export interface LabelSyncChange {
  name: string;
  missing: boolean;
  applied: boolean;
}

export interface LabelSyncResult {
  repository: string;
  apply: boolean;
  labels: LabelSyncChange[];
}

/** One entry of `config/labels.json`'s `staticLabels`. */
export interface LabelCatalogEntry {
  name: string;
  group?: string;
  value?: string;
  color: string;
  description: string;
}

/** One entry of `config/labels.json`'s `dynamicLabels`. */
export interface LabelCatalogDynamic {
  prefix: string;
  group?: string;
  valuePattern?: string;
  color: string;
  descriptionTemplate: string;
  examples?: string[];
}

/** Shape of the parsed `config/labels.json` document, as read by the composition root (see `syncLabels`). */
export interface LabelCatalog {
  catalogVersion?: string;
  namespace?: string;
  ownership?: JsonObject;
  groupRules?: JsonObject;
  staticLabels: LabelCatalogEntry[];
  dynamicLabels: LabelCatalogDynamic[];
}
