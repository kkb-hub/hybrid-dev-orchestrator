// Tool dispatcher for the lean Ollama worker - port of `Invoke-WorkerTool`,
// `Limit-ToolResult`, and `$script:DefaultSearchResults` (workers/hdo-ollama-worker.ps1,
// roughly lines 176-598). Tool JSON schemas live in toolDefinitions.ts (see that file's
// header for why the two were split); this module holds only the dispatcher itself.
//
// `dispatchTool` is synchronous and throws on any tool error, exactly like
// `Invoke-WorkerTool`: main.ts is the one place that catches the throw and turns it into
// an `ERROR: ...` tool-result string the model can see and correct on its next turn
// (mirroring the PS runner's own try/catch around its call to `Invoke-WorkerTool`).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveWorkerPath } from "./workspaceGuard.ts";
import { DEFAULT_SEARCH_RESULTS } from "./toolDefinitions.ts";

/** Context a dispatch needs from the session - the subset of `WorkerSession`
 * (session.ts) that tool execution actually touches, passed explicitly rather than the
 * whole session so this module does not need to import `WorkerSession` just to read three
 * fields off it. */
export interface DispatchToolContext {
  workspace: string;
  readOnly: boolean;
  maxToolResultChars: number;
}

/** Result of one dispatch. `readWasWhole` replaces the PS oracle's
 * `$script:LastReadWasWhole` global: it is `true` only for a `read_file` call that
 * returned the file's entire content unwindowed and untruncated, and `false` for every
 * other tool and every partial read. See session.ts's long comment on why this port
 * returns the fact directly instead of threading a persistent flag. */
export interface DispatchToolResult {
  text: string;
  readWasWhole: boolean;
}

/**
 * Splits file text into lines the way .NET's `[IO.File]::ReadAllLines` does: normalizes
 * every line ending to `\n`, then - critically - drops one trailing `\n` before splitting,
 * so a file that ends with a newline (the overwhelmingly common case) does not produce a
 * spurious empty final line. `ReadAllLines` never emits that trailing empty entry either,
 * since it reads lines with `ReadLine`, which returns `null` (not `""`) once the stream is
 * exhausted right after a final newline.
 */
function readAllLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutTrailingNewline.split("\n");
}

/** Translates a PowerShell-style wildcard (`*`, `?`) into a case-insensitive RegExp
 * anchored to the whole filename, matching `Get-ChildItem -Filter`'s semantics for a
 * plain name pattern (case-insensitive on Windows). Does not reproduce NTFS's obscure
 * 8.3-short-name matching quirk, where `-Filter *.htm` can incidentally match a file
 * whose *short* name ends `.HTM` even though its long name doesn't - an edge case no
 * model-driven pattern is likely to hit. */
function wildcardToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Recursively lists every file under `root`, mirroring `Get-ChildItem -Recurse -File
 * -ErrorAction SilentlyContinue`: an unreadable directory is skipped rather than failing
 * the whole walk. Note this walks the ENTIRE workspace tree including `.git` - the PS
 * oracle's `list_files`/`search_files` never call `Resolve-WorkerPath` and so never apply
 * the git-metadata exclusion that single-file `read_file`/`write_file`/`edit_file` calls
 * go through. Reproducing that asymmetry here, rather than "fixing" it by filtering
 * `.git` out on our own initiative, is what makes this a faithful port instead of an
 * accidental behaviour change the parity test suite was never written to expect.
 *
 * A symlink/junction entry is resolved (via `statSync`, which follows it) to decide
 * whether it counts as a file or a directory to recurse into, matching how
 * `Get-ChildItem -File -Recurse` itself follows reparse points rather than treating them
 * as an opaque third entry type. A broken link is skipped, consistent with
 * `-ErrorAction SilentlyContinue`.
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = statSync(full);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) stack.push(full);
      else if (isFile) out.push(full);
    }
  }
  return out;
}

/**
 * Bounds a tool result to `maxToolResultChars` - port of `Limit-ToolResult`. Kept distinct
 * from `limitText` (text.ts) on purpose: that helper is used for small, fixed-size fields
 * (a recorded subject, an error detail) with its own generic "...[truncated]" marker,
 * while this one bounds the entire budget a tool result gets and carries HDO-specific
 * wording that tells the model to narrow its request instead of re-reading. The PS oracle
 * keeps these as two separate functions for the same reason.
 */
function limitToolResult(text: string, maxToolResultChars: number): string {
  if (text.length <= maxToolResultChars) return text;
  return (
    `${text.slice(0, maxToolResultChars)}\n` +
    `...[truncated by HDO after ${maxToolResultChars} characters; narrow the request instead of re-reading]`
  );
}

/** Port of `Get-Argument` (non-optional branch): a required argument that is missing or
 * `null` is exactly the model's mistake to fix on its next turn, so it throws rather than
 * substituting a default. Coerces to `string` the same way `[string]$Arguments[$Key]`
 * does, so a model that (unusually) sends a required argument as a JSON number still
 * works. */
function requireArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined || value === null) {
    throw new Error(`missing required argument '${key}'`);
  }
  return String(value);
}

/** Port of `Get-Argument -Optional`: returns `''` for a missing/`null` argument, and the
 * string form of the value otherwise. Callers then test the result for truthiness exactly
 * as the PS source does (`if ($requestedStart) { ... }`), which in PowerShell means "any
 * non-empty string" - so an explicit `0` (stringifies to `"0"`) still counts as provided,
 * and only an actually-missing or empty-string argument is treated as absent. */
function optionalArgumentText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Strictly parses a numeric tool argument (`start_line`, `max_lines`, `max_results`) as a
 * base-10 integer, throwing on anything else.
 *
 * The destroyed version of this file used `parseInt(...)`, which silently returns `NaN`
 * for a non-numeric value instead of failing. `NaN` then propagates through every
 * arithmetic comparison as `false` (`NaN > x` and `NaN < x` are both false), which
 * silently defeats whatever guard the caller thought it was applying:
 *   - `read_file` with a bad `start_line` made `Math.max(1, NaN)` evaluate to `NaN`, so
 *     `NaN > lines.length` was false and `lines.slice(NaN - 1, ...)` behaved like
 *     `slice(0, ...)` - the model silently got the whole file back as if it had asked for
 *     it, instead of an error it could correct.
 *   - `read_file` with a bad `max_lines` let the `maxLines < 1` guard pass (comparing
 *     against `NaN` is always false), then produced a `NaN` `endIndex` and an empty body.
 *   - `search_files` with a bad `max_results` made `hits.length > NaN` false, silently
 *     disabling the result cap and returning every match unbounded.
 *
 * The PS oracle avoids all three by using `[int]"..."`, which is a *throwing* cast: a bad
 * value becomes an `ERROR: ...` tool result the model sees and retries, the same way any
 * other tool misuse does. This helper reproduces that "throw on anything not cleanly
 * parseable" behaviour rather than PowerShell's exact cast semantics: `[int]"10.7"` rounds
 * to `11` in PowerShell, and this deliberately does NOT reproduce that rounding - it
 * rejects "10.7" outright. Rejecting a non-integer is strictly safer than silently
 * rounding it, and a well-behaved model never sends a fractional line count or match
 * limit in the first place, so the difference is not observable in practice.
 */
function parseStrictInt(text: string, argName: string): number {
  if (!/^-?\d+$/.test(text.trim())) {
    throw new Error(`${argName} must be an integer`);
  }
  return Number.parseInt(text.trim(), 10);
}

/** Counts non-overlapping occurrences of `needle` in `haystack` as a plain substring
 * search - port of `([regex]::Matches($original, [regex]::Escape($oldText))).Count`. Done
 * with `indexOf` rather than a RegExp so `old_text` is never interpreted as a pattern:
 * `[regex]::Escape` exists in the oracle for exactly that reason. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    count++;
    from = found + needle.length;
  }
  return count;
}

/** Replaces the (assumed single) occurrence of `needle` with `replacement` - port of
 * `.Replace()`, safe here specifically because every call site first proves there is
 * exactly one occurrence. */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function dispatchReadFile(ctx: DispatchToolContext, args: Record<string, unknown>): DispatchToolResult {
  const relative = requireArgument(args, "path");
  const target = resolveWorkerPath(ctx.workspace, relative);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`file not found: ${relative}`);
  }
  const lines = readAllLines(readFileSync(target, "utf8"));

  let startLine = 1;
  const requestedStart = optionalArgumentText(args, "start_line");
  if (requestedStart) startLine = Math.max(1, parseStrictInt(requestedStart, "start_line"));

  if (startLine > lines.length) {
    // Neither a window nor the file's content: nothing was actually read.
    return { text: `start_line ${startLine} is past the end of ${relative} (${lines.length} lines)`, readWasWhole: false };
  }

  // max_lines lets the model ask for the window it actually needs. Without it the only
  // bound is maxToolResultChars, which is a whole-context-sized bite.
  let endIndex = lines.length - 1;
  const requestedMax = optionalArgumentText(args, "max_lines");
  if (requestedMax) {
    const maxLines = parseStrictInt(requestedMax, "max_lines");
    if (maxLines < 1) throw new Error("max_lines must be at least 1");
    endIndex = Math.min(endIndex, startLine - 1 + maxLines - 1);
  }

  const body = lines.slice(startLine - 1, endIndex + 1).join("\n");
  const windowed = startLine > 1 || endIndex < lines.length - 1;
  if (body.length <= ctx.maxToolResultChars) {
    // Set from the same facts this branch is already choosing on, not by matching the
    // returned text for a truncation marker: this file's own source contains those marker
    // phrases, so a whole read of it would otherwise misclassify itself as partial.
    const readWasWhole = !windowed;
    if (!windowed) return { text: body, readWasWhole };
    const header = `[${relative} lines ${startLine}-${endIndex + 1} of ${lines.length}]`;
    if (endIndex < lines.length - 1) {
      return {
        text: `${header}\n${body}\n...[stopped at max_lines; call read_file with start_line=${endIndex + 2} to continue]`,
        readWasWhole,
      };
    }
    return { text: `${header}\n${body}`, readWasWhole };
  }

  // Report the line the model should resume from, so the tail of a long file stays
  // reachable instead of being permanently cut off by the size bound.
  const kept = body.slice(0, ctx.maxToolResultChars);
  const nextLine = startLine + (kept.match(/\n/g)?.length ?? 0);
  return {
    text: `${kept}\n...[truncated after ${ctx.maxToolResultChars} characters; call read_file again with start_line=${nextLine} to continue]`,
    readWasWhole: false,
  };
}

function dispatchListFiles(ctx: DispatchToolContext, args: Record<string, unknown>): string {
  const pattern = requireArgument(args, "pattern");
  const regex = wildcardToRegExp(pattern);
  const matched = walkFiles(ctx.workspace)
    .filter((full) => regex.test(basename(full)))
    .map((full) => full.slice(ctx.workspace.length + 1));
  if (matched.length === 0) return "no files matched";
  return limitToolResult(matched.join("\n"), ctx.maxToolResultChars);
}

function dispatchSearchFiles(ctx: DispatchToolContext, args: Record<string, unknown>): string {
  const patternStr = requireArgument(args, "pattern");
  // Select-String is case-insensitive by default, so the regex is built the same way here.
  const regex = new RegExp(patternStr, "i");

  const include = optionalArgumentText(args, "include");
  const includeRegex = include ? wildcardToRegExp(include) : null;
  const files = walkFiles(ctx.workspace).filter((full) => includeRegex === null || includeRegex.test(basename(full)));

  let limit = DEFAULT_SEARCH_RESULTS;
  const requestedResults = optionalArgumentText(args, "max_results");
  if (requestedResults) {
    limit = parseStrictInt(requestedResults, "max_results");
    if (limit < 1) throw new Error("max_results must be at least 1");
  }

  const hits: string[] = [];
  for (const full of files) {
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      // Unreadable file (permissions, a device file, etc.) - skip it, matching
      // Select-String's own -ErrorAction SilentlyContinue.
      continue;
    }
    const relative = full.slice(ctx.workspace.length + 1);
    const lines = content.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length; index++) {
      if (regex.test(lines[index])) {
        hits.push(`${relative}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }

  if (hits.length === 0) return "no matches";
  if (hits.length > limit) {
    // Bound the hits first and append the notice afterwards: run the other way round, the
    // character limit cuts off the very sentence that says results were dropped, and the
    // model reads a partial list as a complete one.
    const shown = limitToolResult(hits.slice(0, limit).join("\n"), ctx.maxToolResultChars);
    return `${shown}\n...[showing ${limit} of ${hits.length} matches; narrow the pattern or raise max_results]`;
  }
  return limitToolResult(hits.join("\n"), ctx.maxToolResultChars);
}

function dispatchWriteFile(ctx: DispatchToolContext, args: Record<string, unknown>): string {
  const relative = requireArgument(args, "path");
  const target = resolveWorkerPath(ctx.workspace, relative);
  const parent = dirname(target);
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const content = requireArgument(args, "content");
  // Node's utf8 file writes never emit a BOM, matching [Text.UTF8Encoding]::new($false).
  writeFileSync(target, content, "utf8");
  return `wrote ${relative}`;
}

function dispatchEditFile(ctx: DispatchToolContext, args: Record<string, unknown>): string {
  const relative = requireArgument(args, "path");
  const target = resolveWorkerPath(ctx.workspace, relative);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`file not found: ${relative}`);
  }
  const original = readFileSync(target, "utf8");
  const oldText = requireArgument(args, "old_text");
  const newText = requireArgument(args, "new_text");
  if (oldText === "") throw new Error("old_text must not be empty");

  const occurrences = countOccurrences(original, oldText);
  if (occurrences === 0) {
    // A model reproduces multi-line text with LF even when the file on disk is CRLF, so a
    // byte-exact requirement would reject correct edits and push it toward rewriting whole
    // files. Retry once against normalized newlines and write the result back in the
    // file's own convention.
    const usesCrLf = original.includes("\r\n");
    const normalizedOriginal = original.replace(/\r\n/g, "\n");
    const normalizedOld = oldText.replace(/\r\n/g, "\n");
    const normalizedOccurrences = countOccurrences(normalizedOriginal, normalizedOld);
    if (normalizedOccurrences === 0) throw new Error(`old_text was not found in ${relative}`);
    if (normalizedOccurrences > 1) {
      throw new Error(
        `old_text occurs ${normalizedOccurrences} times in ${relative}; include more surrounding context to make it unique`,
      );
    }
    let updated = replaceOnce(normalizedOriginal, normalizedOld, newText.replace(/\r\n/g, "\n"));
    if (usesCrLf) updated = updated.replace(/\n/g, "\r\n");
    writeFileSync(target, updated, "utf8");
    return `edited ${relative}`;
  }
  if (occurrences > 1) {
    throw new Error(`old_text occurs ${occurrences} times in ${relative}; include more surrounding context to make it unique`);
  }
  const updated = replaceOnce(original, oldText, newText);
  writeFileSync(target, updated, "utf8");
  return `edited ${relative}`;
}

/**
 * Dispatches one model tool call - port of `Invoke-WorkerTool`. Synchronous and throws on
 * any tool error; the caller (main.ts) is the only place that turns that throw into an
 * `ERROR: ...` tool-result string, exactly mirroring the PS runner's own try/catch around
 * its call to `Invoke-WorkerTool`.
 */
export function dispatchTool(ctx: DispatchToolContext, name: string, args: Record<string, unknown>): DispatchToolResult {
  // Omitting the editing tools from the advertised list (toolDefinitions.ts's `getTools`)
  // is a hint, not a boundary: a model can name a tool it was never offered. The
  // read-only contract is enforced here, at the only place that can actually touch the
  // file system, mirroring the oracle's own repeated check inside `Invoke-WorkerTool`
  // right before its switch (ADR-0003 D3).
  if (ctx.readOnly && (name === "write_file" || name === "edit_file")) {
    throw new Error(`tool '${name}' is not available to a read-only runner`);
  }

  switch (name) {
    case "read_file":
      return dispatchReadFile(ctx, args);
    case "list_files":
      return { text: dispatchListFiles(ctx, args), readWasWhole: false };
    case "search_files":
      return { text: dispatchSearchFiles(ctx, args), readWasWhole: false };
    case "write_file":
      return { text: dispatchWriteFile(ctx, args), readWasWhole: false };
    case "edit_file":
      return { text: dispatchEditFile(ctx, args), readWasWhole: false };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
