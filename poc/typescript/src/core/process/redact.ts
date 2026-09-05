// Secret redaction patterns, ported from `Protect-HdoText` in Common.ps1. Pure
// string -> string transform; safe to unit test in isolation from process execution.

const SECRET_PATTERNS: RegExp[] = [
  /(?:ghp_|github_pat_|sk-ant-|sk-proj-|xox[baprs]-)[-A-Za-z0-9_]{12,}/gi,
  /(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi,
  /("[^"\r\n]*(?:api[_-]?key|token|password|secret|credential)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
  /((?:api[_-]?key|token|password|secret|credential)\s*[=:]\s*)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi,
];

export function redactSecrets(text: string): string;
export function redactSecrets(text: null): null;
export function redactSecrets(text: string | null): string | null {
  if (text === null) return null;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, group1?: string) => {
      if (typeof group1 === "string") {
        return match.trimEnd().endsWith('"') ? `${group1}"[REDACTED]"` : `${group1}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

const SECRET_KEY_PATTERN = /(?:token|secret|password|credential|api[_-]?key)/i;

/** Recursively redacts values whose object key looks like a credential, mirroring Protect-HdoObject. */
export function redactObject(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactObject(entryValue);
    }
    return result;
  }
  return value;
}
