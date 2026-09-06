// Pure port of `Get-HdoCodexArguments` (Runner.ps1:190-219): builds the Codex CLI argv.
// `--ignore-user-config`/`--ignore-rules` keep a personal `config.toml`/execpolicy from
// overriding the provider, sandbox, or approval behavior HDO supplies for an unattended
// run (Codex still loads its built-in and repository instructions).
import type { JsonObject } from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import { asNumber, asString, hdoArrayItems, inIgnoreCase, isTruthy } from "./psSemantics.ts";

export function getCodexArguments(
  runner: JsonObject,
  workingDirectory: string,
  schemaPath: string,
  finalPath: string,
): string[] {
  // Oracle: Runner.ps1:201-205, fixed prefix; `[string]$Runner.sandbox` is a direct
  // property read (no `Get-HdoValue` default).
  const args: string[] = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--color",
    "never",
    "--sandbox",
    asString(runner.sandbox),
    "--cd",
    workingDirectory,
  ];

  // Oracle: Runner.ps1:206-207, `[string](Get-HdoValue $Runner 'provider' 'cloud')`;
  // `-in @('ollama','lmstudio')` is case-insensitive membership (§7 risk 1).
  const provider = asString(getValue(runner, "provider", "cloud"), "cloud");
  if (inIgnoreCase(provider, ["ollama", "lmstudio"])) {
    args.push("--oss", "--local-provider", provider);
  }

  // Oracle: Runner.ps1:208, `if (Get-HdoValue $Runner 'model' '') { ... [string]$Runner.model }`.
  if (isTruthy(getValue(runner, "model", ""))) {
    args.push("--model", asString(runner.model));
  }

  // Oracle: Runner.ps1:209-211, the reasoning effort value is embedded with literal
  // double quotes inside one argv element (Codex `--config key="value"` syntax).
  if (isTruthy(getValue(runner, "reasoningEffort", ""))) {
    args.push("--config", `model_reasoning_effort="${asString(runner.reasoningEffort)}"`);
  }

  // Oracle: Runner.ps1:212-214, `if (Get-HdoValue $Runner 'contextTokens') { ... [int]$Runner.contextTokens }`
  // - no default passed to `Get-HdoValue`, so a missing key is `$null` (falsy); `[int]`
  // cast -> `Math.trunc` over `asNumber` (§7 risk 14).
  if (isTruthy(getValue(runner, "contextTokens"))) {
    args.push("--config", `model_context_window=${Math.trunc(asNumber(runner.contextTokens, 0))}`);
  }

  // Oracle: Runner.ps1:215.
  args.push("--output-schema", schemaPath, "--output-last-message", finalPath);

  // Oracle: Runner.ps1:216, `foreach ($extraArgument in @(Get-HdoValue $Runner 'extraArgs' @())) { $arguments += [string]$extraArgument }`.
  for (const extraArgument of hdoArrayItems(getValue(runner, "extraArgs", []))) {
    args.push(asString(extraArgument));
  }

  // Oracle: Runner.ps1:217, the trailing `-` (read prompt from stdin) always comes last.
  args.push("-");
  return args;
}
