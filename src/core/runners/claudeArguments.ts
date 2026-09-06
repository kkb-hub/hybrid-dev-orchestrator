// Pure port of `Get-HdoClaudeArguments` and `Get-HdoClaudeInputText` (Runner.ps1:274-332):
// builds the Claude CLI argv and (for the Ollama route) the stdin prompt text. Neither
// function spawns anything or reads the schema file itself - `schemaJson` is handed in
// already rendered (see ADR-0001 phase 5 plan §2: `claudeSchema.ts`, owned by a
// concurrent package, produces that string; this module stays independent of it and
// takes the string as a plain parameter).
import type { JsonObject } from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import { asString, equalsIgnoreCase, hdoArrayCount, hdoArrayItems, isTruthy } from "./psSemantics.ts";

export function getClaudeArguments(runner: JsonObject, schemaJson: string, modelOverride?: string | null): string[] {
  // Oracle: Runner.ps1:283-286, fixed prefix plus `--permission-mode` mapped from
  // sandbox: `$Runner.sandbox -eq 'read-only'` is a direct property read (not
  // `Get-HdoValue`), so a missing `sandbox` compares against `$null` and falls through
  // to `acceptEdits`; `-eq` is case-insensitive (§7 risk 1) -> `equalsIgnoreCase`.
  const sandbox = asString(runner.sandbox);
  const args: string[] = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--safe-mode",
    "--permission-mode",
    equalsIgnoreCase(sandbox, "read-only") ? "plan" : "acceptEdits",
  ];

  // Oracle: Runner.ps1:287, `[string](Get-HdoValue $Runner 'provider' 'cloud')`.
  const provider = asString(getValue(runner, "provider", "cloud"), "cloud");
  // Oracle: Runner.ps1:291, `$provider -ne 'ollama'` (case-insensitive, §7 risk 1).
  const isOllama = equalsIgnoreCase(provider, "ollama");
  if (!isOllama) {
    args.push("--json-schema", schemaJson);
  } else {
    // Oracle: Runner.ps1:297, read-only ollama runners get file-reading tools only;
    // any other sandbox value gets file-editing tools too.
    const localTools = equalsIgnoreCase(sandbox, "read-only")
      ? ["Read", "Glob", "Grep"]
      : ["Read", "Write", "Edit", "Glob", "Grep"];
    args.push("--tools", localTools.join(","));
  }

  // Oracle: Runner.ps1:303-304, `$ModelOverride` truthy (PS empty-string is falsy) wins
  // over the configured model; the resulting value is pushed only when non-empty.
  const model = modelOverride ? modelOverride : asString(getValue(runner, "model", ""));
  if (model) args.push("--model", model);

  // Oracle: Runner.ps1:307-309, `--effort` is only sent for non-Ollama providers, and
  // only when `reasoningEffort` is truthy; the CLI matches `--effort` case-sensitively
  // so the value is lower-cased regardless of config casing.
  if (!isOllama && isTruthy(getValue(runner, "reasoningEffort", ""))) {
    args.push("--effort", asString(runner.reasoningEffort).toLowerCase());
  }

  // Oracle: Runner.ps1:310-311, `@(Get-HdoValue $Runner 'allowedTools' @()).Count -gt 0`.
  const allowedToolsValue = getValue(runner, "allowedTools", []);
  if (hdoArrayCount(allowedToolsValue) > 0) {
    args.push("--allowedTools", hdoArrayItems(allowedToolsValue).map((tool) => asString(tool)).join(","));
  }

  // Oracle: Runner.ps1:312-314, `extraArgs` is NEVER forwarded - the Claude adapter owns
  // its whole argument surface so `--safe-mode`/the structured-output contract cannot be
  // bypassed per run (`Test-HdoConfiguration` rejects claude runners that declare it).
  return args;
}

export function getClaudeInputText(runner: JsonObject, prompt: string, schemaJson: string): string {
  // Oracle: Runner.ps1:325, `[string](Get-HdoValue $Runner 'provider' 'cloud') -ne 'ollama'`
  // returns the prompt unchanged for every non-Ollama provider (case-insensitive, §7 risk 1).
  if (!equalsIgnoreCase(asString(getValue(runner, "provider", "cloud"), "cloud"), "ollama")) {
    return prompt;
  }
  // Oracle: Runner.ps1:326-331, exact English text of the local-worker constraints
  // (PS backtick-n is LF) plus the schema-embedding instruction, appended after two
  // blank lines following the prompt and after the constraints block.
  const localConstraints = [
    "Local Ollama worker constraints:",
    "- Do not use a shell or attempt git, npm, build, or validation commands. HDO runs trusted validation gates after this step.",
    "- Use only the available file-reading and file-editing tools, make the requested repository changes directly, and stop when they are complete.",
  ].join("\n");
  return `${prompt}\n\n${localConstraints}\n\nReturn only one JSON object matching this JSON Schema. Do not wrap it in markdown fences or add prose:\n${schemaJson}`;
}
