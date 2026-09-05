import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowedTransitions, IllegalStateTransitionError, isTerminalState, transition } from "./index.ts";

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

test("terminal states have no outgoing transitions", () => {
  for (const state of ["APPROVED", "ESCALATED", "FAILED", "CANCELLED"] as const) {
    assert.ok(isTerminalState(state));
    assert.deepEqual(allowedTransitions(state), []);
    assert.throws(() => transition(state, "FAILED"));
  }
});
