// PowerShell-style option parser: options are case-insensitive and prefixed with a
// single `-` (also accepting `--` GNU-style aliases, per ADR-0001 Migration strategy
// "両実装をまたぐ契約" - existing option NAMES must be accepted, GNU aliases may be
// added, but nothing existing may be removed). The option set intentionally matches
// hdo.ps1's full parameter list even though phase 1 only wires up `config`/`help`:
// future phases (run/status/cleanup/labels) reuse this same parser without changing
// its shape, and CLI parity tests want unrecognized-but-accepted options to round
// -trip cleanly rather than erroring.
import { cwd } from "node:process";

export interface ParsedArgs {
  command: string;
  positionals: string[];
  json: boolean;
  /** Every `-Config`/`--config` occurrence, comma-split and trimmed, in encounter order. */
  config: string[];
  profile?: string;
  /** Raw `step=runner` strings from each `-SetStep` occurrence (not parsed here - see hdo.ps1 `run`). */
  setStep: string[];
  ignoreRepositoryConfig: boolean;
  repositoryPath: string;
  repository?: string;
  issue?: number;
  runId?: string;
  pick: boolean;
  dryRun: boolean;
  noWriteBack: boolean;
  apply: boolean;
  force: boolean;
  whatIf: boolean;
}

type SwitchName =
  | "json"
  | "ignorerepositoryconfig"
  | "pick"
  | "dryrun"
  | "nowriteback"
  | "apply"
  | "force"
  | "whatif";

type ValueName = "config" | "profile" | "setstep" | "repositorypath" | "repository" | "issue" | "runid";

const SWITCH_NAMES: readonly SwitchName[] = [
  "json",
  "ignorerepositoryconfig",
  "pick",
  "dryrun",
  "nowriteback",
  "apply",
  "force",
  "whatif",
];
const VALUE_NAMES: readonly ValueName[] = [
  "config",
  "profile",
  "setstep",
  "repositorypath",
  "repository",
  "issue",
  "runid",
];

function splitConfigList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isOptionToken(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--";
}

/** Splits `--config=a.json` / `-Config=a.json` into name + inline value; returns undefined value otherwise. */
function splitInlineValue(rest: string): { name: string; inlineValue?: string } {
  const eq = rest.indexOf("=");
  if (eq === -1) return { name: rest };
  return { name: rest.slice(0, eq), inlineValue: rest.slice(eq + 1) };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "",
    positionals: [],
    json: false,
    config: [],
    setStep: [],
    ignoreRepositoryConfig: false,
    repositoryPath: cwd(),
    pick: false,
    dryRun: false,
    noWriteBack: false,
    apply: false,
    force: false,
    whatIf: false,
  };

  let sawCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!isOptionToken(token)) {
      if (!sawCommand) {
        parsed.command = token;
        sawCommand = true;
      } else {
        parsed.positionals.push(token);
      }
      continue;
    }

    const rest = token.replace(/^--?/, "");
    const { name: rawName, inlineValue } = splitInlineValue(rest);
    const name = rawName.toLowerCase();

    if ((SWITCH_NAMES as readonly string[]).includes(name)) {
      switch (name as SwitchName) {
        case "json":
          parsed.json = true;
          break;
        case "ignorerepositoryconfig":
          parsed.ignoreRepositoryConfig = true;
          break;
        case "pick":
          parsed.pick = true;
          break;
        case "dryrun":
          parsed.dryRun = true;
          break;
        case "nowriteback":
          parsed.noWriteBack = true;
          break;
        case "apply":
          parsed.apply = true;
          break;
        case "force":
          parsed.force = true;
          break;
        case "whatif":
          parsed.whatIf = true;
          break;
      }
      continue;
    }

    if ((VALUE_NAMES as readonly string[]).includes(name)) {
      const value = inlineValue !== undefined ? inlineValue : (argv[++i] ?? "");
      switch (name as ValueName) {
        case "config":
          parsed.config.push(...splitConfigList(value));
          break;
        case "profile":
          parsed.profile = value;
          break;
        case "setstep":
          parsed.setStep.push(value);
          break;
        case "repositorypath":
          parsed.repositoryPath = value;
          break;
        case "repository":
          parsed.repository = value;
          break;
        case "runid":
          parsed.runId = value;
          break;
        case "issue": {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) throw new Error(`Invalid -Issue value '${value}'.`);
          parsed.issue = numeric;
          break;
        }
      }
      continue;
    }

    throw new Error(`Unknown option '${token}'.`);
  }

  return parsed;
}
