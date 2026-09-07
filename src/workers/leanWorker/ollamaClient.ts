// Ollama /api/chat client - port of `Invoke-OllamaChat` and `ConvertTo-RequestToolCall`
// (workers/hdo-ollama-worker.ps1:386-441), rebuilt on native `fetch` instead of
// `Invoke-RestMethod`.
//
// `Get-OptionalProperty` (PS lines 84-100) is NOT ported: it exists solely to work around
// `Set-StrictMode -Version 3.0` turning a missing property access into a terminating
// error, which matters there because Ollama marks several response fields `omitempty`
// (a fully cached prompt comes back with no `prompt_eval_count`). Plain JS property
// access on a parsed JSON object already returns `undefined` for an absent field without
// throwing, so every call site here just uses `?? default` / optional chaining directly -
// a deliberate simplification, not a divergence in behaviour.
import type { ChatMessage, ToolDefinition } from "./session.ts";

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: unknown;
  };
  /** Response-only fields such as `id`/`function.index` are typed loosely here and
   * dropped by `convertToRequestToolCall` before being echoed into the next request. */
  [key: string]: unknown;
}

export interface OllamaResponseMessage {
  role?: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaChatResponse {
  message?: OllamaResponseMessage;
  /** Omitted by Ollama for a fully cached prompt - see the header comment above. */
  prompt_eval_count?: number;
  [key: string]: unknown;
}

export interface InvokeOllamaChatOptions {
  uri: string;
  model: string;
  messages: ChatMessage[];
  /** Omit (undefined) to match PS's `-Tools $null`, which leaves `tools` out of the
   * request body entirely rather than sending `tools: []`. */
  tools?: ToolDefinition[];
  /** Omit to leave `format` out of the request body, matching `-Format $null`. */
  format?: unknown;
  /** Omit (not merely `false`) to leave `think` out of the request body entirely,
   * matching PS's `if ($null -ne $Think)` - the ordinary turn loop never passes this,
   * so `think` never appears in those requests; the summarization and final-report calls
   * pass `think: false` explicitly. */
  think?: boolean;
  contextTokens: number;
  requestTimeoutSeconds: number;
}

/** Reduces a response `tool_call` to the minimal shape the request format defines - port
 * of `ConvertTo-RequestToolCall`. Echoing Ollama's own response objects back into the next
 * request carries response-only fields (`id`, `function.index`) into a request body that
 * does not define them, which is a needless way to perturb chat-template rendering. */
export function convertToRequestToolCall(call: OllamaToolCall): { function: { name: string; arguments: unknown } } {
  return { function: { name: String(call.function.name), arguments: call.function.arguments } };
}

/**
 * Calls Ollama's native `/api/chat`. Bounds the request with `AbortSignal.timeout`
 * (`requestTimeoutSeconds`), matching `-TimeoutSec` on the PS `Invoke-RestMethod` call.
 *
 * On a non-2xx response, reads the body and folds it into the thrown message as
 * `Ollama request failed: <status detail> - <body>` (body bounded to 1000 characters +
 * `...[truncated]`), matching the PS oracle's own message shape (Runner script lines
 * 406-421: `$detail` there comes from `$_.ErrorDetails.Message`, populated by
 * `Invoke-RestMethod` from the response body on a non-success status).
 *
 * Deliberate improvement over the oracle (documented per the phase 8 task, Issue #51):
 * `Invoke-RestMethod` mis-decodes a non-ASCII error body under Windows PowerShell's
 * default error-detail handling (observed mojibake on Japanese Ollama error text). Node's
 * `fetch` + `response.text()` decodes the body as UTF-8 correctly, so this is a real
 * behavioural fix, not a divergence to paper over - the message *format* is kept
 * identical so the parity suite's substring assertions on the prefix still hold.
 *
 * The exact wording of `<status detail>` is NOT part of the contract: in the PS oracle it
 * is whatever text .NET's HTTP stack happens to put in `$_.Exception.Message` for that
 * status code, which was never a string HDO controls or should pin byte-for-byte. Only
 * the surrounding "Ollama request failed: ... - <body>" shape and the body content itself
 * are contractual (phase 8 task, item 9).
 */
export async function invokeOllamaChat(options: InvokeOllamaChatOptions): Promise<OllamaChatResponse> {
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: false,
    // The native API honours num_ctx per request, so unlike the Anthropic-compatible
    // endpoint this route needs no 'ollama create' derived model to raise the window.
    options: { num_ctx: options.contextTokens },
  };
  if (options.tools) payload.tools = options.tools;
  if (options.format) payload.format = options.format;
  if (options.think !== undefined) payload.think = options.think;

  let response: Response;
  try {
    response = await fetch(options.uri, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.requestTimeoutSeconds * 1000),
    });
  } catch (error) {
    // A connection failure (server not running, DNS failure, or the AbortSignal firing on
    // timeout) never reaches an HTTP response at all, so there is no body to report -
    // mirrors the PS oracle's own no-detail branch (`$detail` empty -> no " - detail" suffix).
    throw new Error(`Ollama request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).trim();
    } catch {
      body = "";
    }
    // Bounded: an overlong body would otherwise bury the status line it exists to explain.
    if (body.length > 1000) body = `${body.slice(0, 1000)}...[truncated]`;
    const statusDetail = `${response.status} ${response.statusText}`.trim();
    if (body) throw new Error(`Ollama request failed: ${statusDetail} - ${body}`);
    throw new Error(`Ollama request failed: ${statusDetail}`);
  }

  return (await response.json()) as OllamaChatResponse;
}
