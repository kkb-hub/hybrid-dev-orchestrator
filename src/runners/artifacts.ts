// Host file helpers mirroring `Common.ps1`'s artifact-directory primitives
// (`Read-HdoBoundedTextFile`:549-559, `Write-HdoJsonFile`:505-521,
// `Protect-HdoLogFile`:523-547), plus a plain UTF-8-no-BOM text writer used for the
// prompt.md/final.json/schema copies runner steps drop into an artifact directory.
// All synchronous, like their PowerShell counterparts (`Set-Content`/`[IO.File]`/
// `Test-Path` all block); this is a `src/runners/**` host module, so `node:fs`/
// `node:crypto` are allowed (ADR-0001 phase 5 plan §2 boundary) - only process
// execution is restricted to the injected `ProcessRunner` contract, and none of these
// functions spawn anything.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "../core/contracts/types.ts";
import { protectText } from "../core/process/redact.ts";

const DEFAULT_MAXIMUM_BYTES = 33554432;

/** True for a regular file, matching `Test-Path -LiteralPath ... -PathType Leaf` (a directory is not a "leaf"). */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Port of `Read-HdoBoundedTextFile` (Common.ps1:549-559): throws `File was not found:
 * <path>` when `path` is missing or not a regular file, throws `File exceeds the HDO
 * output limit of <maximumBytes> bytes: <path>` when its on-disk byte length exceeds
 * `maximumBytes` (checked BEFORE reading the full content, exactly like PS's
 * `(Get-Item $Path).Length` check), and otherwise reads it as UTF-8 text.
 *
 * `[IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))` strips a leading
 * UTF-8 BOM; Node's `readFileSync(path, 'utf8')` does NOT (ADR-0001 phase 5 plan §7
 * risk 10), so the BOM (`﻿`) is stripped explicitly here to match, the same
 * pattern `src/cli/configCommand.ts`'s `readJsonFile` already uses.
 */
export function readBoundedTextFile(path: string, maximumBytes: number = DEFAULT_MAXIMUM_BYTES): string {
  if (!isRegularFile(path)) throw new Error(`File was not found: ${path}`);
  const length = statSync(path).size;
  if (length > maximumBytes) throw new Error(`File exceeds the HDO output limit of ${maximumBytes} bytes: ${path}`);
  const raw = readFileSync(path, "utf8");
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Best-effort delete, swallowing every error - mirrors the `finally { if (Test-Path
 * ...) { Remove-Item -Force } }` cleanup pattern both `Write-HdoJsonFile` and
 * `Protect-HdoLogFile` use around their temp file.
 */
function removeQuietly(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: the rename below already succeeded, or another process won a
    // race to delete/replace it first - neither is this function's problem.
  }
}

/**
 * `renameSync` with a short bounded retry. On Windows, replacing a file that another
 * process (or a just-closed handle, or an on-access virus scanner) still holds open
 * fails with EPERM/EBUSY/EACCES for a few milliseconds; .NET's `File.Move`/
 * `Set-Content` in the PowerShell implementation hits the same window but the CI
 * run of `agentStep.integration.test.ts` showed it for the TS port (rename of
 * `stdout.log` right after the child exited). Retries up to ~1 second total, then
 * rethrows the last error. Non-sharing errors (ENOENT, EISDIR, ...) are not retried.
 */
function renameWithRetry(from: string, to: string): void {
  const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!retryable.has(code) || attempt >= 20) throw error;
      Atomics.wait(sleep, 0, 0, 50);
    }
  }
}

/**
 * Port of `Write-HdoJsonFile` (Common.ps1:505-521): creates `path`'s parent directory
 * if needed, then writes `value` to a sibling temp file and atomically renames it
 * over `path` (so a reader never observes a partially-written file).
 *
 * Documented divergence (ADR-0001 phase 5 plan §6, phase 6 compares parsed JSON, not
 * raw bytes): PS pretty-prints via `ConvertTo-Json -Depth 100` then `Set-Content
 * -Encoding utf8NoBOM`, which joins with CRLF line breaks on Windows; this writes
 * `JSON.stringify(value, null, 2) + '\n'` with LF line breaks instead.
 */
export function writeJsonFile(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID().replace(/-/g, "")}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameWithRetry(temporaryPath, path);
  } finally {
    removeQuietly(temporaryPath);
  }
}

/**
 * Truncates `text` to at most `maximumBytes` UTF-8 bytes, cutting on a UTF-16
 * character boundary that never splits a surrogate pair (a lone trailing high
 * surrogate is backed off by one more character rather than kept dangling). Mirrors
 * `Protect-HdoLogFile`'s binary-search-ish shrink loop (Common.ps1:534-539) closely
 * enough to converge on the same byte budget, but is expressed as "never split a
 * surrogate pair" directly (ADR-0001 phase 5 plan §WP-E1) rather than porting PS's
 * `UTF8Encoding` lone-surrogate replacement-character fallback behavior verbatim.
 */
function truncateToUtf8ByteLimit(text: string, maximumBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  let characterCount = Math.min(text.length, maximumBytes);
  while (characterCount > 0 && Buffer.byteLength(text.slice(0, characterCount), "utf8") > maximumBytes) {
    const overBy = Buffer.byteLength(text.slice(0, characterCount), "utf8") - maximumBytes;
    characterCount -= Math.max(1, Math.ceil(overBy / 4));
  }
  characterCount = Math.max(0, characterCount);
  if (characterCount > 0 && characterCount < text.length) {
    const lastCode = text.charCodeAt(characterCount - 1);
    // 0xD800-0xDBFF: a high surrogate - only ever meaningful when paired with a
    // following low surrogate, which this cut point is about to separate it from.
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) characterCount -= 1;
  }
  return text.slice(0, Math.max(0, characterCount));
}

/**
 * Port of `Protect-HdoLogFile` (Common.ps1:523-547): a no-op when `path` does not
 * exist (or is not a regular file); otherwise reads it (bounded by `maximumBytes`,
 * same as `readBoundedTextFile`), redacts secrets via `protectText`, truncates the
 * redacted text to `maximumBytes` UTF-8 bytes if needed (never splitting a surrogate
 * pair), and atomically overwrites `path` with the result via a sibling temp file +
 * rename.
 */
export function protectLogFile(path: string, maximumBytes: number = DEFAULT_MAXIMUM_BYTES): void {
  if (!isRegularFile(path)) return;
  const original = readBoundedTextFile(path, maximumBytes);
  const redacted = truncateToUtf8ByteLimit(protectText(original), maximumBytes);
  const temporaryPath = `${path}.${randomUUID().replace(/-/g, "")}.redacted`;
  try {
    writeFileSync(temporaryPath, redacted, "utf8");
    renameWithRetry(temporaryPath, path);
  } finally {
    removeQuietly(temporaryPath);
  }
}

/**
 * Plain UTF-8-no-BOM text writer used for artifact copies that are not JSON and do not
 * need atomic-replace semantics (prompt.md, final.json's raw text sibling, schema
 * copies) - mirrors the many direct `Set-Content -Encoding utf8NoBOM` call sites in
 * `Runner.ps1` (e.g. :558, :582) that write straight to the target path with no temp
 * file. Does NOT create `path`'s parent directory (neither does `Set-Content`): the
 * artifact directory is expected to already exist by the time this is called.
 */
export function writeTextFile(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}
