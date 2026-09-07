// Tool JSON schemas - port of `$script:ReadTools`/`$script:WriteTools`/`$script:Tools`
// (workers/hdo-ollama-worker.ps1:189-236). Split from tools.ts (which now holds only the
// dispatcher, `Invoke-WorkerTool`) purely to keep each file under a readable size; the
// two are still one conceptual unit and are meant to be read together.
//
// Every description and property-description string below is reproduced verbatim from
// the PS source: the model sees this text as part of its own tool definitions, and the
// parity test suite treats worker behaviour (not just tool-result text) as contractual,
// so a paraphrase here would be an observable, if subtle, behaviour change.
import type { ToolDefinition } from "./session.ts";

// Default cap on how many matching lines a single search returns - `$script:DefaultSearchResults`.
// Exported because tools.ts's `search_files` dispatch needs the same number as its default.
export const DEFAULT_SEARCH_RESULTS = 100;

const READ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Prefer a narrow window: pass start_line with max_lines instead of reading a whole large file. Long results are truncated; use start_line to read the rest.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "integer", description: "Optional 1-based line to start reading from." },
          max_lines: {
            type: "integer",
            description: "Optional maximum number of lines to return, counted from start_line.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files matching a wildcard pattern such as *.ps1.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string", description: "Wildcard file name pattern." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: `Search workspace file contents with a regular expression and return matching lines. Returns at most ${DEFAULT_SEARCH_RESULTS} matches unless max_results says otherwise.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          include: { type: "string", description: "Optional wildcard file name filter." },
          max_results: {
            type: "integer",
            description: `Optional maximum number of matching lines to return (default ${DEFAULT_SEARCH_RESULTS}).`,
          },
        },
        required: ["pattern"],
      },
    },
  },
];

const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new UTF-8 text file in the workspace, or overwrite one outright. For a file that already exists, use edit_file instead: the full content passed here stays in the conversation and consumes the context window.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Full new file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact, unique block of text in an existing workspace file. This is the preferred way to change a file that already exists.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          old_text: { type: "string", description: "Exact text to replace. Must occur exactly once." },
          new_text: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
];

/** Port of `$script:Tools = if ($ReadOnly) { $script:ReadTools } else { $script:ReadTools + $script:WriteTools }`.
 * Read-only steps get the inspection tools only: the file-editing tools are not merely
 * unused but structurally absent, so a read-only runner cannot be talked into writing by
 * prompt content alone (tools.ts's dispatcher enforces the same rule again, at the only
 * place that can actually touch the filesystem, per ADR-0003 D3). */
export function getTools(readOnly: boolean): ToolDefinition[] {
  return readOnly ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS];
}
