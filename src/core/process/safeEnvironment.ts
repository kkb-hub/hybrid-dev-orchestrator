// Pure port of `Get-HdoSafeEnvironment` (Common.ps1:710-728): a deny-list that filters
// a caller's environment down to variables that are safe to pass through to a child
// process by default, unless explicitly allow-listed via `passEnvironment`. This is a
// core-only function - nothing in `cli/`, `process/`, or `git/` wires it in yet
// (parity with the PowerShell side: `Invoke-HdoGit` does not call
// `Get-HdoSafeEnvironment` itself either - callers of `Invoke-HdoProcess` opt in
// explicitly).
const BLOCKED_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NPM_TOKEN",
  "PYPI_TOKEN",
]);

// Copied verbatim (case-insensitive suffix match) from Common.ps1:724 (issue #63:
// added `_KEY` so any `..._KEY` name - not only `..._API_KEY` - is blocked by default;
// a suffix without a preceding underscore, e.g. `MONKEY`/`KEYBOARD`, still passes).
const BLOCKED_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)$/i;

function isBlockedName(name: string): boolean {
  const upper = name.toUpperCase();
  return BLOCKED_NAMES.has(upper) || BLOCKED_NAME_PATTERN.test(name);
}

/**
 * Returns a copy of `environment` with any blocked-by-default variable removed,
 * unless its name (case-insensitively - PowerShell `-contains`/`HashSet` with
 * `OrdinalIgnoreCase` are both case-insensitive) appears in `passEnvironment`.
 * Enumeration order of `environment` is preserved in the result.
 */
export function getSafeEnvironment(
  environment: Record<string, string | undefined>,
  passEnvironment: string[] = [],
): Record<string, string> {
  const allowed = new Set(passEnvironment.map((name) => name.toUpperCase()));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (isBlockedName(name) && !allowed.has(name.toUpperCase())) continue;
    result[name] = value;
  }
  return result;
}
