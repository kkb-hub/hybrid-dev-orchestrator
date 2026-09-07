// Worker-verified state - port of `Register-ToolOutcome` and `Get-VerifiedStateBlock`
// (workers/hdo-ollama-worker.ps1:238-384).
//
// Everything recorded here is captured as tools actually run, so it survives a
// compaction without depending on the model correctly recalling its own history. It is
// presented to the model separately from the model's own summary for exactly that
// reason (see compaction.ts's `newHistoryBlock`).
import { limitText } from "./text.ts";
import type { WorkerSession } from "./session.ts";

/** Appends to a rolling log that is allowed to forget its oldest entries - port of
 * `Add-BoundedEntry`. */
function addBoundedEntry(list: string[], value: string, max: number): void {
  list.push(value);
  while (list.length > max) list.shift();
}

/**
 * Records the facts a compaction must not lose: what was read, what changed, what
 * failed - port of `Register-ToolOutcome`.
 *
 * `readWasWhole` replaces PS's `$script:LastReadWasWhole`: the caller (main.ts) gets it
 * directly as part of `dispatchTool`'s return value for a successful `read_file` call,
 * rather than through a script-scoped flag reset before every dispatch (see the rationale
 * on `WorkerSession` in session.ts).
 */
export function registerToolOutcome(
  session: WorkerSession,
  turn: number,
  name: string,
  args: Record<string, unknown>,
  result: string,
  failed: boolean,
  readWasWhole: boolean,
): void {
  let subject = "";
  for (const key of ["path", "pattern"]) {
    const value = args[key];
    if (value !== undefined && value !== null) {
      subject = limitText(String(value), 120);
      break;
    }
  }

  if (!failed && subject) {
    if (name === "read_file") {
      // A windowed or size-truncated read is recorded as partial. One entry per path, not
      // one per (path, whole/partial) pair: without that, the same file read once
      // windowed and once whole would record as two distinct strings and show both,
      // contradictorily, in the same block. Sticky true once whole, since a read that
      // happened is a fact regardless of what is read afterwards.
      if (!session.filesRead.has(subject)) {
        if (session.filesRead.size >= 30) {
          // Oldest entry, by insertion order, as with every other bounded collection here.
          const oldestKey = session.filesRead.keys().next().value;
          if (oldestKey !== undefined) session.filesRead.delete(oldestKey);
        }
        session.filesRead.set(subject, false);
      }
      if (readWasWhole) session.filesRead.set(subject, true);
    } else if (name === "search_files") {
      if (!session.searches.includes(subject)) addBoundedEntry(session.searches, subject, 12);
    } else if (name === "write_file" || name === "edit_file") {
      if (!session.fileChanges.has(subject)) session.fileChanges.set(subject, { write: 0, edit: 0 });
      const counts = session.fileChanges.get(subject)!;
      const operation = name === "write_file" ? "write" : "edit";
      counts[operation] += 1;
    }
  }

  if (failed) {
    addBoundedEntry(session.toolErrors, `turn ${turn}: ${name}(${subject}): ${limitText(result, 200)}`, 8);
  }
  const outcome = failed ? "ERROR" : "ok";
  addBoundedEntry(session.recentActions, `turn ${turn}: ${name}(${subject}) -> ${outcome}`, 12);
}

/**
 * Renders the worker's own record of the session as plain text for re-injection - port of
 * `Get-VerifiedStateBlock`.
 *
 * Ordered most operationally important first, not chronologically: `newHistoryBlock`
 * (compaction.ts) caps this text from the end when the budget is tight, so whatever is
 * listed last is what gets cut first. Files changed and recent actions are what a
 * continuing worker most needs; turn/compaction counters are the least essential and go
 * last.
 */
export function getVerifiedStateBlock(session: WorkerSession, turn: number): string {
  const lines: string[] = [];

  if (session.fileChanges.size === 0) {
    lines.push("Files changed: (none yet)");
  } else {
    // Bounded like the other collections. This one grows with the work rather than with a
    // rolling window, and the block is truncated from the end, so an unbounded list here
    // would push the tool errors and recent actions out of a small window.
    const changed: string[] = [];
    for (const [path, counts] of session.fileChanges) {
      const parts: string[] = [];
      if (counts.edit > 0) parts.push(`${counts.edit} edit(s)`);
      if (counts.write > 0) parts.push(`${counts.write} write(s)`);
      changed.push(`${path} (${parts.join(", ")})`);
    }
    const shown = changed.slice(-20);
    const suffix = changed.length > shown.length ? ` (and ${changed.length - shown.length} earlier file(s))` : "";
    lines.push(`Files changed: ${shown.join(", ")}${suffix}`);
  }

  if (session.recentActions.length > 0) {
    lines.push("Recent actions (most recent last):");
    for (const entry of session.recentActions) lines.push(`  - ${entry}`);
  }

  if (session.toolErrors.length === 0) {
    lines.push("Tool errors: (none)");
  } else {
    lines.push("Tool errors (most recent last):");
    for (const entry of session.toolErrors) lines.push(`  - ${entry}`);
  }

  const read =
    session.filesRead.size === 0
      ? "(none)"
      : Array.from(session.filesRead.entries())
          .map(([path, whole]) => (whole ? path : `${path} (partial)`))
          .join(", ");
  lines.push(`Files read: ${read}`);

  if (session.searches.length > 0) lines.push(`Searches run: ${session.searches.join(" | ")}`);

  lines.push(`Turns used: ${turn} of ${session.maxTurns}. Compactions so far: ${session.compactionCount}.`);

  return lines.join("\n");
}
