// Ports `Get-HdoCodexFailureDetail`/`Get-HdoClaudeFailureDetail` (Runner.ps1:232-272,
// 489-528), including the shared Ollama context-overflow diagnosis both draw on
// (Runner.ps1:221-230). Pure string/JSON parsing; no process access.
import { getValue } from "../config/value.ts";
import { protectText } from "../process/redact.ts";
import { asString, equalsIgnoreCase, hdoArrayItems } from "./psSemantics.ts";
import type { JsonValue } from "../contracts/types.ts";

// Ollama raises this from its chat-template renderer once front-truncation to fit
// num_ctx has dropped the last real user turn, so it always means "the conversation
// outgrew the model context window" - never anything about the prompt HDO sent.
// Neither the context window nor Ollama is named upstream. The error comes from the
// Ollama server, so every adapter routed through it can surface it, not just Claude.
// PS `-match` is case-insensitive; `/i` mirrors that (Runner.ps1:227).
export const OLLAMA_CONTEXT_OVERFLOW_PATTERN = /no user query found in messages/i;

// Oracle: Runner.ps1:228-230, the exact three-piece hint string (starts with a space).
export const OLLAMA_CONTEXT_OVERFLOW_HINT =
  " | HDO diagnosis: the conversation outgrew the local model context window." +
  " Ollama truncates the oldest messages to fit num_ctx and reports the resulting" +
  " user-turn-less prompt as this error. Raise the runner contextTokens, or split the task.";

const CODEX_UNSUPPORTED_CALL_PATTERN = /\berror=unsupported call:\s*(.+?)\s*$/i;

function nonBlankLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * Matches the overflow marker before truncation and appends the hint after it: a run
 * long enough to exhaust the context window is also the one whose detail is long
 * enough to lose the marker (Runner.ps1:266-270, 521-526).
 */
function applyLengthCapAndContextDiagnosis(detail: string): string {
  const outgrewContextWindow = OLLAMA_CONTEXT_OVERFLOW_PATTERN.test(detail);
  let result = detail;
  if (result.length > 4096) result = result.slice(0, 4096) + "...[truncated]";
  if (outgrewContextWindow) result += OLLAMA_CONTEXT_OVERFLOW_HINT;
  return result;
}

/** Port of `Get-HdoCodexFailureDetail` (Runner.ps1:232-272). */
export function getCodexFailureDetail(stdout: string, stderr: string): string {
  const details: string[] = [];

  for (const line of nonBlankLines(stderr)) {
    const match = CODEX_UNSUPPORTED_CALL_PATTERN.exec(line);
    if (!match) continue;
    let message = `Codex tool router rejected an unsupported call: ${match[1]}`;
    message = protectText(message).trim();
    if (message && !details.includes(message)) details.push(message);
  }

  for (const line of nonBlankLines(stdout)) {
    let event: JsonValue;
    try {
      event = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    const type = asString(getValue(event, "type", ""));
    let message: string;
    if (equalsIgnoreCase(type, "turn.failed")) {
      message = asString(getValue(event, "error.message", ""));
    } else if (equalsIgnoreCase(type, "error")) {
      message = asString(getValue(event, "message", ""));
    } else {
      message = "";
    }
    if (!message) continue;
    try {
      const nested = JSON.parse(message) as JsonValue;
      const nestedMessage = asString(getValue(nested, "error.message", ""));
      if (nestedMessage) message = nestedMessage;
    } catch {
      // swallowed: a non-JSON message is used as-is, matching PS's empty `catch { }`.
    }
    message = protectText(message).trim();
    if (message && !details.includes(message)) details.push(message);
  }

  const detail = details.length > 0 ? details.join(" | ") : protectText(stderr).trim();
  return applyLengthCapAndContextDiagnosis(detail);
}

/** Port of `Get-HdoClaudeFailureDetail` (Runner.ps1:489-528). */
export function getClaudeFailureDetail(stdout: string, stderr: string): string {
  const details: string[] = [];

  if (stdout.trim()) {
    try {
      const envelope = JSON.parse(stdout) as JsonValue;
      const resultValue = getValue(envelope, "result");
      if (resultValue !== undefined && resultValue !== null) {
        const resultText = typeof resultValue === "string" ? resultValue : JSON.stringify(resultValue);
        const redactedResultText = protectText(resultText).trim();
        if (redactedResultText) details.push(redactedResultText);
      }
      const terminalReason = asString(getValue(envelope, "terminal_reason", ""));
      if (terminalReason) details.push(`terminal_reason: ${protectText(terminalReason).trim()}`);

      const denialItems = hdoArrayItems(getValue(envelope, "permission_denials", []));
      if (denialItems.length > 0) {
        const deniedTools: string[] = [];
        for (const denial of denialItems) {
          const toolName = asString(getValue(denial, "tool_name", ""));
          // PS `Select-Object -Unique` is case-sensitive (ADR-0001 phase 5 plan §7 risk 1).
          if (toolName && !deniedTools.includes(toolName)) deniedTools.push(toolName);
        }
        let denialDetail = `${denialItems.length} permission denial(s)`;
        if (deniedTools.length > 0) denialDetail += `: ${deniedTools.join(", ")}`;
        details.push(denialDetail);
      }
    } catch {
      // swallowed: malformed/non-object stdout contributes no envelope-derived detail,
      // matching PS's empty `catch { }` around the whole envelope-parsing block.
    }
  }

  const stderrDetail = protectText(stderr).trim();
  if (stderrDetail) details.push(`stderr: ${stderrDetail}`);

  const detail = details.length > 0 ? details.join(" | ") : "Claude returned no failure detail.";
  return applyLengthCapAndContextDiagnosis(detail);
}
