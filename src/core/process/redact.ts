// Secret redaction, ported rule-for-rule from `Protect-HdoText`/`Protect-HdoObject`
// (Common.ps1:637-687). Pure string/value transforms; safe to unit test in isolation
// from process execution, and verified against the PowerShell oracle in
// `redact.test.ts` (pwsh parity test).
//
// Each PowerShell `(?i)` pattern is translated to a JS RegExp with the case
// -insensitive `i` flag (plus `g`, since `Protect-HdoText` replaces every match, not
// just the first). PowerShell's doubled single-quote escaping (`''[^'']*''`, inside a
// single-quoted PS string literal) becomes a literal `'[^']*'` here. Patterns 2-4 each
// have exactly one capturing group (the "key/prefix" text that must be preserved); a
// regex with zero capturing groups (pattern 1) never supplies a string for that
// position, so the `typeof group1 === "string"` check below correctly falls through
// to the "no prefix to preserve" branch. Do not "improve" pattern 2's character class
// to `\S+` (a plausible-looking simplification) or pattern 4's to `\S+`: PowerShell's
// `[^\s"']+` (pattern 2) and `[^\s,}]+` (pattern 4) intentionally exclude characters
// that a naive `\S+` would swallow (a following quote, comma, or closing brace),
// which changes whether a match occurs at all for near-miss inputs such as
// `Authorization: Bearer "quoted"` - see the pwsh parity corpus in redact.test.ts.
//
// S-9: two more .NET-vs-JS regex semantic gaps, confirmed to leak secrets past this
// module (`{"token":"ab\<CR>cd"}` and `{"token":"ab\<U+2028>cd"}` were left UNCHANGED
// by the un-fixed patterns below; `token="ab\<CR>cd"` partially leaked):
//
// - JS `.` (no `s`/dotAll flag) excludes `\n`, `\r`, U+2028 and U+2029; .NET `.` (no
//   RegexOptions.Singleline) excludes only `\n`. Every `\\.` below (PowerShell's "an
//   escaped character" inside a quoted-string body) is therefore `\\[^\n]`, not a
//   bare `.`, so it agrees with .NET on `\r`/U+2028/U+2029 immediately after a
//   backslash.
// - JS `\s` includes U+FEFF (BOM) and excludes U+0085 (NEL); .NET `\s` is exactly
//   `[\t\n\v\f\r\x85\p{Z}]` (the Unicode "space separator" category plus NEL). Every
//   `\s` below (positive and negated) is replaced by that class spelled out
//   explicitly - enumerating `\p{Z}`'s codepoints one by one since these patterns
//   deliberately carry no `u` flag (see the `i`/`g`-only note above; every character
//   here is within the BMP, so none is needed).
//
// Case-folding of U+212A (Kelvin sign) and U+017F (long s) differs between .NET's
// and JS's `/i` flag - left as a documented divergence (docs/architecture.md 16.4)
// rather than fixed, since it cannot be closed without either flag affecting every
// OTHER character's case-folding too or hand-rolling a full CaseFolding.txt table.
const SECRET_PATTERNS: RegExp[] = [
  /(?:ghp_|github_pat_|sk-ant-|sk-proj-|xox[baprs]-)[-A-Za-z0-9_]{12,}/gi,
  /(authorization[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*:[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*(?:bearer|token)[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)[^\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"']+/gi,
  /("[^"\r\n]*(?:api[_-]?key|token|password|secret|credential)[^"\r\n]*"[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*:[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*)"(?:\\[^\n]|[^"\\])*"/gi,
  /((?:api[_-]?key|token|password|secret|credential)[\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*[=:][\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*)(?:"(?:\\[^\n]|[^"\\])*"|'[^']*'|[^\t\n\v\f\r\x85 \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000,}]+)/gi,
];

/** Mirrors `Protect-HdoText`: `$null` in, `$null` out; otherwise every pattern above is applied in order. */
export function protectText(text: string): string;
export function protectText(text: null): null;
export function protectText(text: string | null): string | null {
  if (text === null) return null;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string, group1?: unknown) => {
      if (typeof group1 === "string") {
        return match.trimEnd().endsWith('"') ? `${group1}"[REDACTED]"` : `${group1}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

// Copied verbatim (case-insensitive) from Common.ps1:668.
const SECRET_KEY_PATTERN = /(?:token|secret|password|credential|api[_-]?key)/i;

/**
 * Recursively redacts values whose object key looks like a credential, mirroring
 * `Protect-HdoObject`. Arrays are mapped element-wise; string values (that are not
 * themselves keyed by a secret-looking name) go through `protectText`; key
 * enumeration order is preserved (`Object.entries` on a plain object iterates own
 * string keys in insertion order, matching PowerShell's `[ordered]` hashtable).
 */
export function protectObject(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => protectObject(item));
  if (typeof value === "string") return protectText(value);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : protectObject(entryValue);
    }
    return result;
  }
  return value;
}
