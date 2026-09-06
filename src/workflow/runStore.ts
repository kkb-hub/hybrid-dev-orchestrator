// Port of `State.ps1` (whole file): `Save-HdoRun` (:33-40), `Add-HdoRunEvent`
// (:43-52), `Set-HdoRunState` (:54-76), `Get-HdoRun` (:78-95). This is a
// `src/workflow/**` host module (ADR-0001 phase 5/6 plan boundary): it touches
// `node:fs` directly for `events.jsonl` appends and reuses the shared
// `writeJsonFile`/`isRegularFile` helpers from `src/runners/artifacts.ts` for
// `run.json`, exactly like the PowerShell original reaches into `Common.ps1`'s
// `Write-HdoJsonFile`/`Read-HdoJsonFile`.
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import { protectText } from "../core/process/redact.ts";
import type { RunState } from "../core/state/index.ts";
import type { RunRecord } from "../core/workflow/runRecord.ts";
import { transition } from "../core/state/index.ts";
import { isRegularFile, writeJsonFile } from "../runners/artifacts.ts";

export interface RunStoreOptions {
  artifactPath: string;
  /** Overridable for tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Port of `Read-HdoJsonFile` (Common.ps1:453-465), reduced to exactly the two error
 * texts `Get-HdoRun` can surface. `src/workflow/**` must not import `src/cli/**`
 * (plan §4 dependency direction), so this intentionally duplicates
 * `src/cli/configCommand.ts`'s `readJsonFile` rather than importing it.
 */
function readJsonObjectFile(path: string): JsonObject {
  if (!isRegularFile(path)) throw new Error(`JSON file was not found: ${path}`);
  let parsed: unknown;
  try {
    // `Get-Content -Raw` strips a leading UTF-8 BOM before PowerShell parses it;
    // Node's utf8 decoding does not, so it is stripped explicitly here to match.
    const raw = readFileSync(path, "utf8");
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in '${path}': ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in '${path}': expected a JSON object`);
  }
  return parsed as JsonObject;
}

/**
 * Port of `Save-HdoRun`/`Add-HdoRunEvent`/`Set-HdoRunState` (State.ps1:33-76).
 * Holds only `artifactPath` and a `now()` clock; every method takes the live run
 * object as an argument (mirrors the PS cmdlets, which all take `$Run`/
 * `$ArtifactPath` as parameters rather than storing them).
 */
export class RunStore {
  private readonly artifactPath: string;
  private readonly now: () => string;

  constructor(options: RunStoreOptions) {
    this.artifactPath = options.artifactPath;
    this.now = options.now ?? ((): string => new Date().toISOString());
  }

  /** Oracle: State.ps1:33-40 - `$Run.updatedAt = Get-HdoUtcTimestamp` then `Write-HdoJsonFile`. */
  save(run: RunRecord): void {
    run.updatedAt = this.now();
    writeJsonFile(join(this.artifactPath, "run.json"), run as unknown as JsonValue);
  }

  /**
   * Oracle: State.ps1:43-52 - `$Event['at'] = Get-HdoUtcTimestamp` appends a NEW key
   * at the end of the ordered dictionary the first time (never pre-populated by any
   * caller in this codebase), so building a fresh object via spread-then-`at`
   * reproduces the same key order; `Protect-HdoText` runs on the compressed JSON
   * text, then `Add-Content` appends the line. PS's `Add-Content` writes a
   * CRLF line terminator on Windows; this writes a single `\n` instead
   * (documented divergence, plan §2.2 - readers must split on `\r?\n`).
   */
  addEvent(event: JsonObject): void {
    const withAt: JsonObject = { ...event, at: this.now() };
    const line = protectText(JSON.stringify(withAt));
    appendFileSync(join(this.artifactPath, "events.jsonl"), `${line}\n`, "utf8");
  }

  /**
   * Oracle: State.ps1:54-76 - transition check, THEN `run.state = to`, THEN
   * `Add-HdoRunEvent`, THEN `Save-HdoRun` (in that order). `transition()` throws
   * `IllegalStateTransitionError` (message identical to PS's `"Invalid HDO state
   * transition: $from -> $to"`, State.ps1:65) before any mutation or write happens,
   * exactly like the PS `throw` at :65 happens before `$Run.state = $to` (:67).
   */
  setState(run: RunRecord, to: RunState, reason: string): void {
    const from = run.state;
    transition(from, to);
    run.state = to;
    this.addEvent({ type: "state.transition", from, to, reason, iteration: run.iteration });
    this.save(run);
  }
}

/**
 * Port of `Get-HdoRun` (State.ps1:78-95), minus the config-resolution fallback for a
 * missing `$ArtifactRoot` (the plan's WP-C scope: callers always pass a resolved
 * artifact root). `[System.IO.Path]::GetFullPath($ArtifactRoot)` is mirrored with
 * `path.resolve`.
 */
export function readRun(artifactRoot: string, runId: string): JsonObject {
  const runPath = join(resolvePath(artifactRoot), runId, "run.json");
  return readJsonObjectFile(runPath);
}
