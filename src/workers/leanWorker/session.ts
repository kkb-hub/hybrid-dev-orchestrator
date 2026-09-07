// Mutable session state for the lean Ollama worker (ADR-0001 Migration strategy phase 8,
// port of workers/hdo-ollama-worker.ps1). PowerShell keeps this as a pile of `$script:`
// globals (Messages, FilesRead, FileChanges, Searches, ToolErrors, RecentActions,
// CompactionCount, LastSummaryBlock, LastCompactionTurn) because a top-level .ps1 script
// IS its own module scope, so a `$script:` variable is already effectively "this run's
// state" and never leaks across runs (`pwsh -File` starts a fresh process every time).
// Node has no equivalent free lunch: a module-level `let` is process-wide, so a future
// caller that runs this worker in-process (a test harness, or a batching host) would have
// every run silently share and corrupt the same counters. Threading an explicit
// `WorkerSession` object through every function keeps each run's state isolated no matter
// how the module is invoked, and happens to make the compaction functions in
// compaction.ts trivially unit-testable (construct a session, call the pure function,
// inspect the result) without a `pwsh` process in the loop.
//
// One deliberate omission from the PS globals: `$script:LastReadWasWhole`. In PowerShell
// it exists only because `Invoke-WorkerTool` (the tool dispatcher) and `Register-ToolOutcome`
// (the outcome recorder) are two separate functions with no shared return channel other
// than a script-scoped flag that the caller resets before every dispatch. In this port,
// `dispatchTool` (tools.ts) returns the "was this a whole read" fact directly as part of
// its result, and the turn loop (main.ts) passes it straight into `registerToolOutcome` -
// so there is nothing left for a persistent flag to do, and reproducing it here would just
// be a global for something that is only ever produced and consumed within one iteration.
import { psInt } from "./psInt.ts";

/** One message in the Ollama `/api/chat` conversation. Field order matters: it is
 * serialized with plain `JSON.stringify`, and `measureMessageTokens` (compaction.ts)
 * depends on that serialization matching what `ConvertTo-Json -Compress` produces from
 * the PowerShell worker's `[ordered]@{ role = ...; content = ...; ... }` hashtables for
 * the token-estimate parity requirement (ADR-0001 phase 8 contract item 5). Always build
 * these object literals with keys in the order declared here (role first, then content,
 * then the optional fields) rather than assigning fields out of order after construction. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant messages only; present only when the turn actually made tool calls
   * (mirrors PS only ever setting `$assistant['tool_calls']` inside an `if`). */
  tool_calls?: RequestToolCall[];
  /** Tool-result messages only. */
  tool_name?: string;
}

/** The reduced tool-call shape echoed back into a request, per `ConvertTo-RequestToolCall`:
 * response-only fields (`id`, `function.index`) are dropped before the call is replayed
 * into the next request's message history. */
export interface RequestToolCall {
  function: {
    name: string;
    /** Left as whatever JSON value Ollama returned (usually an object) - never
     * re-stringified, so the request replays the model's own argument shape. */
    arguments: unknown;
  };
}

/** Per-path write/edit counters, keyed by workspace-relative path - mirrors
 * `$script:FileChanges`'s `[ordered]@{ write = 0; edit = 0 }` entries. */
export interface FileChangeCounts {
  write: number;
  edit: number;
}

/** JSON Schema tool definition, shaped exactly like the PowerShell worker's
 * `$script:ReadTools`/`$script:WriteTools` entries (see tools.ts). */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      additionalProperties: false;
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

/** The first two messages (system prompt, operator's task) that compaction never touches -
 * `$script:ProtectedMessageCount` in the PS source. Every rebuilt history still starts
 * from the same instructions and the same goal the orchestrator asked for. */
export const PROTECTED_MESSAGE_COUNT = 2;

/** Immutable run configuration, derived once from the parsed CLI arguments and never
 * changed for the life of the run. Split out from the mutable fields below purely for
 * readability - both live on the same `WorkerSession` object. */
export interface WorkerSessionConfig {
  workspace: string;
  readOnly: boolean;
  model: string;
  contextTokens: number;
  maxTurns: number;
  maxToolResultChars: number;
  compactAtPercent: number;
  keepRecentMessages: number;
  requestTimeoutSeconds: number;
  ollamaUri: string;
  tools: ToolDefinition[];
}

export interface WorkerSession extends WorkerSessionConfig {
  // --- derived budgets, computed once from config (see createSession) ------------------
  /** Bounds the digest handed to the summarization call - roughly a third of the context
   * window, matching `$script:SummaryInputTokens`. */
  summaryInputTokens: number;
  /** Bounds the message that replaces dropped turns - matches `$script:MaxBlockTokens`. */
  maxBlockTokens: number;
  /** Half of `maxBlockTokens`, one half each for the verified-state text and the model's
   * own summary - matches `$script:MaxBlockHalfTokens`. */
  maxBlockHalfTokens: number;

  // --- mutable state, updated as the run proceeds ---------------------------------------
  messages: ChatMessage[];
  /** One entry per path read, sticky `true` once any read of it was whole (see the long
   * rationale on `Register-ToolOutcome` in the PS source, ported verbatim to
   * `registerToolOutcome` in verifiedState.ts). A `Map` is used specifically for its
   * insertion-order iteration and O(1) "oldest key" eviction, mirroring PS's
   * `[ordered]@{}` hashtable. */
  filesRead: Map<string, boolean>;
  fileChanges: Map<string, FileChangeCounts>;
  searches: string[];
  toolErrors: string[];
  recentActions: string[];
  compactionCount: number;
  lastSummaryBlock: string;
  lastCompactionTurn: number;
}

export function createSession(config: WorkerSessionConfig): WorkerSession {
  // Ported from the module-level PS comments at Runner script lines ~698-716: a fraction
  // of the compaction *threshold*, not of the raw context window, because the same figure
  // is reserved as headroom when Resolve-RetentionBoundary decides how much history to
  // keep - taking it from the window instead would claim well over half the usable budget
  // at a low CompactAtPercent, leaving nothing for the recent turns it exists alongside.
  //
  // Each `[int](...)` below is the oracle's round-half-to-even cast, not truncation - see
  // psInt.ts. At the default config (32768 tokens, 65%) this is observable: the oracle's
  // maxBlockTokens is `[int]7454.72` = 7455, and maxBlockHalfTokens is `[int]3727.5` = 3728;
  // plain truncation would give 7454 and 3727.
  const summaryInputTokens = Math.max(500, Math.min(10000, psInt(config.contextTokens * 0.35)));
  const maxBlockTokens = Math.max(400, psInt(((config.contextTokens * config.compactAtPercent) / 100) * 0.35));
  const maxBlockHalfTokens = psInt(maxBlockTokens / 2);

  return {
    ...config,
    summaryInputTokens,
    maxBlockTokens,
    maxBlockHalfTokens,
    messages: [],
    filesRead: new Map(),
    fileChanges: new Map(),
    searches: [],
    toolErrors: [],
    recentActions: [],
    compactionCount: 0,
    lastSummaryBlock: "",
    lastCompactionTurn: 0,
  };
}
