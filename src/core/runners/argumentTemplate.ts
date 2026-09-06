// Pure port of `Expand-HdoArgumentTemplate` (Runner.ps1:26-35): substitutes `{token}`
// placeholders in a command-runner argument template (see `config/examples/*.json`
// command runners) with resolved values, before the expanded argv element is handed to
// the process launcher.
export function expandArgumentTemplate(value: string, tokens: Record<string, unknown>): string {
  let expanded = value;
  // Oracle: Runner.ps1:33, `foreach ($key in $Tokens.Keys) { $expanded =
  // $expanded.Replace("{$key}", [string]$Tokens[$key]) }` - iterates tokens in
  // insertion order (PS `[ordered]` dictionary, mirrored by a plain object's own
  // string-keyed insertion order here) and replaces EVERY literal occurrence of
  // `{key}` each pass (`String.Replace` is a literal, all-occurrences replace, not a
  // single substitution) - `split(needle).join(replacement)` reproduces that without
  // treating `needle` as a regular expression.
  for (const key of Object.keys(tokens)) {
    const rawValue = tokens[key];
    // Oracle: Runner.ps1:33, `[string]$Tokens[$key]` - PowerShell's `[string]` cast of
    // `$null` is the empty string.
    const replacement = rawValue === null || rawValue === undefined ? "" : String(rawValue);
    expanded = expanded.split(`{${key}}`).join(replacement);
  }
  return expanded;
}
