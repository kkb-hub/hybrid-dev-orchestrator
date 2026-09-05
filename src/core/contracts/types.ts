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
