// Run state machine, copied from docs/architecture.md section 7:
//
//   CREATED -> ISSUE_SELECTED -> PREFLIGHT
//   PREFLIGHT -> ISSUE_CLAIMED -> WORKTREE_READY  (write-back)
//   PREFLIGHT -> WORKTREE_READY                   (NoWriteBack)
//   WORKTREE_READY -> PLANNING | IMPLEMENTING
//   PLANNING -> IMPLEMENTING -> VALIDATING -> REVIEWING | CHANGES_REQUESTED
//   REVIEWING -> APPROVED | ESCALATED | CHANGES_REQUESTED
//   CHANGES_REQUESTED -> IMPLEMENTING | ESCALATED
//   any non-terminal -> FAILED | CANCELLED
//
// APPROVED, ESCALATED, FAILED, CANCELLED are terminal (no outgoing transitions).

export type RunState =
  | "CREATED"
  | "ISSUE_SELECTED"
  | "PREFLIGHT"
  | "ISSUE_CLAIMED"
  | "WORKTREE_READY"
  | "PLANNING"
  | "IMPLEMENTING"
  | "VALIDATING"
  | "REVIEWING"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "ESCALATED"
  | "FAILED"
  | "CANCELLED";

export const RUN_STATES: readonly RunState[] = [
  "CREATED",
  "ISSUE_SELECTED",
  "PREFLIGHT",
  "ISSUE_CLAIMED",
  "WORKTREE_READY",
  "PLANNING",
  "IMPLEMENTING",
  "VALIDATING",
  "REVIEWING",
  "CHANGES_REQUESTED",
  "APPROVED",
  "ESCALATED",
  "FAILED",
  "CANCELLED",
];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["APPROVED", "ESCALATED", "FAILED", "CANCELLED"]);

/** Explicit successors, before the "any non-terminal -> FAILED | CANCELLED" rule is applied. */
const EXPLICIT_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CREATED: ["ISSUE_SELECTED"],
  ISSUE_SELECTED: ["PREFLIGHT"],
  PREFLIGHT: ["ISSUE_CLAIMED", "WORKTREE_READY"],
  ISSUE_CLAIMED: ["WORKTREE_READY"],
  WORKTREE_READY: ["PLANNING", "IMPLEMENTING"],
  PLANNING: ["IMPLEMENTING"],
  IMPLEMENTING: ["VALIDATING"],
  VALIDATING: ["REVIEWING", "CHANGES_REQUESTED"],
  REVIEWING: ["APPROVED", "ESCALATED", "CHANGES_REQUESTED"],
  CHANGES_REQUESTED: ["IMPLEMENTING", "ESCALATED"],
  APPROVED: [],
  ESCALATED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Every state reachable in one step from `from`, including the blanket FAILED/CANCELLED rule. */
export function allowedTransitions(from: RunState): RunState[] {
  if (isTerminalState(from)) return [];
  const unique = new Set<RunState>([...EXPLICIT_TRANSITIONS[from], "FAILED", "CANCELLED"]);
  return [...unique];
}

export class IllegalStateTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Illegal state transition: ${from} -> ${to}`);
    this.name = "IllegalStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to` if the transition is legal, otherwise throws IllegalStateTransitionError. */
export function transition(from: RunState, to: RunState): RunState {
  if (!allowedTransitions(from).includes(to)) {
    throw new IllegalStateTransitionError(from, to);
  }
  return to;
}
