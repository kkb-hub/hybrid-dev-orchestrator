// Mermaid rendering of the run state machine (ADR-0003 D1: "図 = 表" - the diagram IS
// the table, never a hand-maintained duplicate). `toMermaid()` derives every edge from
// `EXPLICIT_TRANSITIONS` plus the one blanket rule ("any non-terminal -> FAILED |
// CANCELLED", see `allowedTransitions` in ./index.ts) - there is no third source of
// truth for the state machine's shape. WP-G pastes this function's output verbatim
// into docs/architecture.md section 7; mermaid.test.ts pins that exact text.
import { EXPLICIT_TRANSITIONS, isTerminalState, RUN_STATES } from "./index.ts";

/**
 * Renders the run state machine as a Mermaid `stateDiagram-v2` block.
 *
 * Order is fully deterministic: states are visited in `RUN_STATES` order; for each
 * non-terminal state, its explicit successors are emitted in `EXPLICIT_TRANSITIONS`
 * table order, followed by the two blanket-rule edges (`-> FAILED`, then
 * `-> CANCELLED`). Terminal states (APPROVED, ESCALATED, FAILED, CANCELLED) have no
 * outgoing transitions and contribute no lines. The result carries no trailing
 * newline (repo convention for `[...].join("\n")`-built text, see
 * src/core/runners/prompts.ts).
 */
export function toMermaid(): string {
  const lines: string[] = ["stateDiagram-v2"];
  for (const state of RUN_STATES) {
    if (isTerminalState(state)) continue;
    for (const target of EXPLICIT_TRANSITIONS[state]) {
      lines.push(`    ${state} --> ${target}`);
    }
    lines.push(`    ${state} --> FAILED`);
    lines.push(`    ${state} --> CANCELLED`);
  }
  return lines.join("\n");
}
