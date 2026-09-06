import { strict as assert } from "node:assert";
import { test } from "node:test";
import { allowedTransitions, RUN_STATES } from "./index.ts";
import { toMermaid } from "./mermaid.ts";

/** Parses `stateDiagram-v2` output back into a `from -> Set<to>` map (test-only). */
function parseEdges(mermaid: string): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const line of mermaid.split("\n").slice(1)) {
    const match = /^\s*(\S+) --> (\S+)$/.exec(line);
    assert.ok(match, `unparseable line: ${JSON.stringify(line)}`);
    const [, from, to] = match as unknown as [string, string, string];
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  }
  return edges;
}

test("toMermaid starts with the stateDiagram-v2 header and has no trailing newline", () => {
  const mermaid = toMermaid();
  assert.ok(mermaid.startsWith("stateDiagram-v2\n"));
  assert.ok(!mermaid.endsWith("\n"));
});

test("every emitted edge round-trips through allowedTransitions(from), and vice versa", () => {
  const edges = parseEdges(toMermaid());
  for (const state of RUN_STATES) {
    const expected = new Set(allowedTransitions(state));
    const actual = edges.get(state) ?? new Set<string>();
    assert.deepEqual([...actual].sort(), [...expected].sort(), `mismatch for ${state}`);
  }
});

// Snapshot: WP-G pastes this exact block into docs/architecture.md section 7. This
// test only pins the text so a future change to EXPLICIT_TRANSITIONS is caught here
// (and in the doc, once WP-G re-pastes) rather than silently drifting.
test("toMermaid matches the pinned snapshot", () => {
  assert.equal(
    toMermaid(),
    [
      "stateDiagram-v2",
      "    CREATED --> ISSUE_SELECTED",
      "    CREATED --> FAILED",
      "    CREATED --> CANCELLED",
      "    ISSUE_SELECTED --> PREFLIGHT",
      "    ISSUE_SELECTED --> FAILED",
      "    ISSUE_SELECTED --> CANCELLED",
      "    PREFLIGHT --> ISSUE_CLAIMED",
      "    PREFLIGHT --> WORKTREE_READY",
      "    PREFLIGHT --> FAILED",
      "    PREFLIGHT --> CANCELLED",
      "    ISSUE_CLAIMED --> WORKTREE_READY",
      "    ISSUE_CLAIMED --> FAILED",
      "    ISSUE_CLAIMED --> CANCELLED",
      "    WORKTREE_READY --> PLANNING",
      "    WORKTREE_READY --> IMPLEMENTING",
      "    WORKTREE_READY --> FAILED",
      "    WORKTREE_READY --> CANCELLED",
      "    PLANNING --> IMPLEMENTING",
      "    PLANNING --> FAILED",
      "    PLANNING --> CANCELLED",
      "    IMPLEMENTING --> VALIDATING",
      "    IMPLEMENTING --> FAILED",
      "    IMPLEMENTING --> CANCELLED",
      "    VALIDATING --> REVIEWING",
      "    VALIDATING --> CHANGES_REQUESTED",
      "    VALIDATING --> FAILED",
      "    VALIDATING --> CANCELLED",
      "    REVIEWING --> APPROVED",
      "    REVIEWING --> ESCALATED",
      "    REVIEWING --> CHANGES_REQUESTED",
      "    REVIEWING --> FAILED",
      "    REVIEWING --> CANCELLED",
      "    CHANGES_REQUESTED --> IMPLEMENTING",
      "    CHANGES_REQUESTED --> ESCALATED",
      "    CHANGES_REQUESTED --> FAILED",
      "    CHANGES_REQUESTED --> CANCELLED",
    ].join("\n"),
  );
});
