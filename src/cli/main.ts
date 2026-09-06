#!/usr/bin/env node
// Composition root: wires core + platform + git together. Phases 1-5 implement the
// `config` and `doctor` subcommands end to end (plus `help`); the remaining hdo.ps1
// commands (issues/inspect/run/status/cleanup/labels) are later migration phases
// (see ADR-0001 Migration strategy) - `args.ts` already accepts their option names
// so those phases do not need to touch the parser again.
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { buildConfigCommandOutput, nowIso, resolveCliConfig } from "./configCommand.ts";
import { runDoctorCommand } from "./doctorCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const USAGE_TEXT = [
  "Hybrid Dev Orchestrator (TypeScript, phase 1-5: config / doctor)",
  "",
  "  node src/cli/main.ts doctor [-Config <path>[,<path>...]] [-Profile <name>] [-IgnoreRepositoryConfig] [-DryRun] [-Json]",
  "  node src/cli/main.ts config  [-Config <path>[,<path>...]] [-Profile <name>] [-IgnoreRepositoryConfig] [-RepositoryPath <path>] [-Json]",
  "  node src/cli/main.ts help",
  "",
  "PowerShell (hdo.ps1) remains the canonical CLI for every other command until",
  "Migration strategy phase 7 (ADR-0001).",
  "",
].join("\n");

/** Unknown command/option still writes usage to stderr (an error path); only the
 * `help` command itself matches PowerShell's stdout destination (see printUsage's
 * caller in `main`, and docs/architecture.md 16.4 item 8). */
function printUsageToStderr(): void {
  process.stderr.write(USAGE_TEXT);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "help":
      // Matches `hdo.ps1 help`, which writes to stdout.
      process.stdout.write(USAGE_TEXT);
      return 0;
    case "config": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const resolvedConfig = await resolveCliConfig({ parsed, platform, schemas });
      const output = buildConfigCommandOutput(resolvedConfig, nowIso());
      // PowerShell's default (non-`-Json`) table formatting is not worth
      // reproducing for a machine-oriented config dump; `config` without `-Json`
      // prints the same JSON as `config -Json` (documented in README.md's
      // TypeScript section).
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }
    case "doctor": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const { result, exitCode } = await runDoctorCommand({ parsed, platform, schemas });
      // Mirrors hdo.ps1's `Write-HdoCliOutput`: `doctor` prints the same JSON with or
      // without `-Json` (the non-`-Json` table formatting is not worth reproducing
      // for a machine-oriented result - same rationale as `config` above).
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCode;
    }
    default:
      printUsageToStderr();
      return 2;
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    // Mirrors hdo.ps1's top-level catch: write the message to stderr, exit 2.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
