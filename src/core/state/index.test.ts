import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowedTransitions, IllegalStateTransitionError, isTerminalState, isValidTransition, transition } from "./index.ts";

test("the documented happy path is legal", () => {
  const path = [
    "CREATED",
    "ISSUE_SELECTED",
    "PREFLIGHT",
    "ISSUE_CLAIMED",
    "WORKTREE_READY",
    "PLANNING",
    "IMPLEMENTING",
    "VALIDATING",
    "REVIEWING",
    "APPROVED",
  ] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(transition(path[i], path[i + 1]), path[i + 1]);
  }
});

test("PREFLIGHT can skip ISSUE_CLAIMED directly to WORKTREE_READY (NoWriteBack)", () => {
  assert.equal(transition("PREFLIGHT", "WORKTREE_READY"), "WORKTREE_READY");
});

test("CHANGES_REQUESTED can loop back to IMPLEMENTING or escalate", () => {
  assert.equal(transition("CHANGES_REQUESTED", "IMPLEMENTING"), "IMPLEMENTING");
  assert.equal(transition("CHANGES_REQUESTED", "ESCALATED"), "ESCALATED");
});

test("any non-terminal state can move to FAILED or CANCELLED", () => {
  for (const state of ["CREATED", "PLANNING", "VALIDATING", "REVIEWING"] as const) {
    assert.equal(transition(state, "FAILED"), "FAILED");
    assert.equal(transition(state, "CANCELLED"), "CANCELLED");
  }
});

test("illegal transitions throw IllegalStateTransitionError", () => {
  assert.throws(() => transition("CREATED", "APPROVED"), IllegalStateTransitionError);
  assert.throws(() => transition("WORKTREE_READY", "REVIEWING"), IllegalStateTransitionError);
});

test("IllegalStateTransitionError message matches Set-HdoRunState's throw text (State.ps1:65)", () => {
  assert.throws(
    () => transition("CREATED", "APPROVED"),
    (error: unknown) => error instanceof Error && error.message === "Invalid HDO state transition: CREATED -> APPROVED",
  );
});

test("terminal states have no outgoing transitions", () => {
  for (const state of ["APPROVED", "ESCALATED", "FAILED", "CANCELLED"] as const) {
    assert.ok(isTerminalState(state));
    assert.deepEqual(allowedTransitions(state), []);
    assert.throws(() => transition(state, "FAILED"));
  }
});

// isValidTransition mirrors Test-HdoStateTransition (State.ps1) exactly.

test("isValidTransition agrees with transition()/allowedTransitions() for legal moves", () => {
  assert.equal(isValidTransition("CREATED", "ISSUE_SELECTED"), true);
  assert.equal(isValidTransition("PREFLIGHT", "WORKTREE_READY"), true);
  assert.equal(isValidTransition("CHANGES_REQUESTED", "ESCALATED"), true);
});

test("isValidTransition rejects illegal moves", () => {
  assert.equal(isValidTransition("CREATED", "APPROVED"), false);
  assert.equal(isValidTransition("WORKTREE_READY", "REVIEWING"), false);
});

test("isValidTransition allows FAILED/CANCELLED from any non-terminal state", () => {
  for (const state of ["CREATED", "PLANNING", "VALIDATING", "REVIEWING"]) {
    assert.equal(isValidTransition(state, "FAILED"), true);
    assert.equal(isValidTransition(state, "CANCELLED"), true);
  }
});

test("isValidTransition rejects FAILED/CANCELLED from a terminal state", () => {
  for (const state of ["APPROVED", "ESCALATED", "FAILED", "CANCELLED"]) {
    assert.equal(isValidTransition(state, "FAILED"), false);
    assert.equal(isValidTransition(state, "CANCELLED"), false);
  }
});

test("isValidTransition is case-insensitive on both sides", () => {
  assert.equal(isValidTransition("created", "issue_selected"), true);
  assert.equal(isValidTransition("Preflight", "Worktree_Ready"), true);
  assert.equal(isValidTransition("changes_requested", "ESCALATED"), true);
  assert.equal(isValidTransition("failed", "cancelled"), false);
});

test("isValidTransition returns false for an unknown 'from' state", () => {
  assert.equal(isValidTransition("NOT_A_STATE", "CREATED"), false);
  assert.equal(isValidTransition("", "CREATED"), false);
});

test("isValidTransition returns false for an unknown 'to' state that is not FAILED/CANCELLED", () => {
  assert.equal(isValidTransition("CREATED", "NOT_A_STATE"), false);
});
