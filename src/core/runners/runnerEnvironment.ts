// Pure port of `Get-HdoRunnerEnvironment` (Runner.ps1:334-371): derives the child
// process environment for a runner invocation from an ambient snapshot the caller
// supplies (so this stays pure - no `process.env` read here, unlike PS which reads the
// live environment; ADR-0001 phase 5 plan §7 risk 12 - the pure result is unaffected by
// libuv's fixed Windows injection list, which the host adds afterward when it actually
// spawns).
import type { JsonObject } from "../contracts/types.ts";
import { getValue } from "../config/value.ts";
import { getSafeEnvironment } from "../process/safeEnvironment.ts";
import { asNumber, asString, equalsIgnoreCase, hdoArrayItems, removeKeyIgnoreCase } from "./psSemantics.ts";

export function getRunnerEnvironment(
  runner: JsonObject,
  ambient: Record<string, string | undefined>,
): Record<string, string> {
  // Oracle: Runner.ps1:337, `Get-HdoSafeEnvironment @(Get-HdoValue $Runner 'passEnvironment' @())`.
  const passEnvironment = hdoArrayItems(getValue(runner, "passEnvironment", [])).map((entry) => asString(entry));
  const environment = getSafeEnvironment(ambient, passEnvironment);

  // Oracle: Runner.ps1:338-340, `$type -eq 'claude' -and $provider -eq 'ollama'`
  // (case-insensitive, §7 risk 1).
  const type = asString(getValue(runner, "type", ""));
  const provider = asString(getValue(runner, "provider", "cloud"), "cloud");
  if (equalsIgnoreCase(type, "claude") && equalsIgnoreCase(provider, "ollama")) {
    // Oracle: Runner.ps1:344-347, hard-coded loopback routing and a non-secret token so
    // repository configuration can never select an arbitrary endpoint or leak an
    // Anthropic credential to a local model.
    environment.ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";
    environment.ANTHROPIC_AUTH_TOKEN = "ollama";
    environment.ANTHROPIC_API_KEY = "";
    environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

    // Oracle: Runner.ps1:364-368, an inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is
    // always dropped first (env var names are case-insensitive on Windows -> §7 risk
    // 12), then re-set from `contextTokens` only when positive (`[int]` cast -> `asNumber`
    // + `Math.trunc`, §7 risk 14); the window is HDO's to decide on this route, never the
    // operator's shell.
    removeKeyIgnoreCase(environment, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    const contextTokens = asNumber(getValue(runner, "contextTokens", 0), 0);
    if (contextTokens > 0) {
      environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.trunc(contextTokens));
    }
  }

  return environment;
}
