// CLI argument parsing for the lean Ollama worker (port of the PS `param()` block,
// workers/hdo-ollama-worker.ps1:39-69).
//
// `src/cli/args.ts` was checked first, per the phase 8 task brief, and does not fit here:
// it parses hdo.ps1's own command set (config/doctor/issues/run/...), where every value
// is optional and unrecognized-but-accepted options round-trip cleanly for CLI parity
// tests. This worker's contract is the opposite shape - five mandatory string flags, a
// clutch of numeric flags each with its own PowerShell `[ValidateRange(...)]`, and a
// `[switch]` - and a wrong or missing value must fail the run outright rather than be
// accepted and ignored. Reusing that parser would mean bolting mandatory-ness and range
// validation onto a shape that was deliberately built without either, so this is a small,
// purpose-built parser instead.
//
// PowerShell's `CmdletBinding` binds parameters case-insensitively and only ever expects
// a single leading `-` (`-PromptFile`, not `--prompt-file`), so that is what this parser
// accepts too - no GNU-style aliases, since none exist on the oracle to match.

export interface WorkerArgs {
  promptFile: string;
  outputFile: string;
  schemaFile: string;
  workingDirectory: string;
  model: string;
  contextTokens: number;
  readOnly: boolean;
  maxTurns: number;
  maxToolResultChars: number;
  compactAtPercent: number;
  keepRecentMessages: number;
  requestTimeoutSeconds: number;
  ollamaUri: string;
}

type StringFlag = "promptFile" | "outputFile" | "schemaFile" | "workingDirectory" | "model" | "ollamaUri";
type IntFlag =
  | "contextTokens"
  | "maxTurns"
  | "maxToolResultChars"
  | "compactAtPercent"
  | "keepRecentMessages"
  | "requestTimeoutSeconds";

const STRING_FLAGS: Record<string, StringFlag> = {
  promptfile: "promptFile",
  outputfile: "outputFile",
  schemafile: "schemaFile",
  workingdirectory: "workingDirectory",
  model: "model",
  ollamauri: "ollamaUri",
};

const INT_FLAGS: Record<string, IntFlag> = {
  contexttokens: "contextTokens",
  maxturns: "maxTurns",
  maxtoolresultchars: "maxToolResultChars",
  compactatpercent: "compactAtPercent",
  keeprecentmessages: "keepRecentMessages",
  requesttimeoutseconds: "requestTimeoutSeconds",
};

// Mirrors each `[ValidateRange(min, max)]` on the PS param block exactly.
const INT_RANGES: Record<IntFlag, readonly [number, number]> = {
  contextTokens: [1024, 1048576],
  maxTurns: [1, 200],
  maxToolResultChars: [1000, 200000],
  compactAtPercent: [0, 95],
  keepRecentMessages: [2, 50],
  requestTimeoutSeconds: [30, 3600],
};

const INT_DEFAULTS: Record<IntFlag, number> = {
  contextTokens: 32768,
  maxTurns: 40,
  maxToolResultChars: 20000,
  compactAtPercent: 65,
  keepRecentMessages: 6,
  requestTimeoutSeconds: 600,
};

const MANDATORY_STRING_FLAGS: readonly StringFlag[] = [
  "promptFile",
  "outputFile",
  "schemaFile",
  "workingDirectory",
  "model",
];

const DEFAULT_OLLAMA_URI = "http://127.0.0.1:11434/api/chat";
const OLLAMA_URI_PATTERN = /^https?:\/\//;

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const strings: Partial<Record<StringFlag, string>> = {};
  const ints: Partial<Record<IntFlag, number>> = {};
  let readOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-" || token === "--") {
      throw new Error(`Unexpected positional argument '${token}'.`);
    }
    const name = token.replace(/^-+/, "").toLowerCase();

    if (name === "readonly") {
      readOnly = true;
      continue;
    }

    if (name in STRING_FLAGS) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Option '${token}' requires a value.`);
      strings[STRING_FLAGS[name]] = value;
      continue;
    }

    if (name in INT_FLAGS) {
      const raw = argv[++i];
      if (raw === undefined) throw new Error(`Option '${token}' requires a value.`);
      const flag = INT_FLAGS[name];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) throw new Error(`Option '${token}' expects an integer, got '${raw}'.`);
      const [min, max] = INT_RANGES[flag];
      if (parsed < min || parsed > max) {
        throw new Error(`Option '${token}' must be between ${min} and ${max}, got ${parsed}.`);
      }
      ints[flag] = parsed;
      continue;
    }

    throw new Error(`Unknown option '${token}'.`);
  }

  for (const flag of MANDATORY_STRING_FLAGS) {
    if (!strings[flag]) throw new Error(`Missing required option '-${flag[0].toUpperCase()}${flag.slice(1)}'.`);
  }

  const ollamaUri = strings.ollamaUri ?? DEFAULT_OLLAMA_URI;
  if (!OLLAMA_URI_PATTERN.test(ollamaUri)) {
    throw new Error(`Option '-OllamaUri' must match ${OLLAMA_URI_PATTERN}, got '${ollamaUri}'.`);
  }

  return {
    promptFile: strings.promptFile!,
    outputFile: strings.outputFile!,
    schemaFile: strings.schemaFile!,
    workingDirectory: strings.workingDirectory!,
    model: strings.model!,
    contextTokens: ints.contextTokens ?? INT_DEFAULTS.contextTokens,
    readOnly,
    maxTurns: ints.maxTurns ?? INT_DEFAULTS.maxTurns,
    maxToolResultChars: ints.maxToolResultChars ?? INT_DEFAULTS.maxToolResultChars,
    compactAtPercent: ints.compactAtPercent ?? INT_DEFAULTS.compactAtPercent,
    keepRecentMessages: ints.keepRecentMessages ?? INT_DEFAULTS.keepRecentMessages,
    requestTimeoutSeconds: ints.requestTimeoutSeconds ?? INT_DEFAULTS.requestTimeoutSeconds,
    ollamaUri,
  };
}
