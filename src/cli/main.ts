#!/usr/bin/env node
// Composition root: wires core + platform + git together. As of phase 7 (ADR-0001
// Migration strategy) every hdo.ps1 command (help/doctor/config/issues/inspect/run/
// status/cleanup/labels) is wired here end to end.
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { buildConfigCommandOutput, nowIso, resolveCliConfig } from "./configCommand.ts";
import { runCleanupCommand } from "./cleanupCommand.ts";
import { runDoctorCommand } from "./doctorCommand.ts";
import { runInspectCommand } from "./inspectCommand.ts";
import { runIssuesCommand } from "./issuesCommand.ts";
import { runLabelsCommand } from "./labelsCommand.ts";
import { runRunCommand } from "./runCommand.ts";
import { runStatusCommand } from "./statusCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const USAGE_TEXT = [
  "Hybrid Dev Orchestrator (TypeScript, phase 1-7: config / doctor / issues / inspect / run / status / cleanup / labels)",
  "",
  "  node src/cli/main.ts doctor  [-Config <path>[,<path>...]] [-Profile <name>] [-IgnoreRepositoryConfig] [-DryRun] [-Json]",
  "  node src/cli/main.ts config  [-Config <path>[,<path>...]] [-Profile <name>] [-IgnoreRepositoryConfig] [-Json]",
  "  node src/cli/main.ts issues  [-Repository owner/repo] [-Json]",
  "  node src/cli/main.ts inspect -Issue <number> [-Repository owner/repo] [-Json]",
  "  node src/cli/main.ts run     (-Issue <number> | -Pick) [-Config <path>[,<path>...]] [-Profile <name>] [-SetStep implement=<runner>] [-IgnoreRepositoryConfig] [-DryRun] [-NoWriteBack] [-Json]",
  "  node src/cli/main.ts status  -RunId <id> [-Json]",
  "  node src/cli/main.ts cleanup -RunId <id> [-Force] [-WhatIf]",
  "  node src/cli/main.ts labels  [-Repository owner/repo] [-Apply] [-WhatIf]",
  "",
  "DryRun performs GitHub reads, contract validation, configuration resolution, and a read-only preflight only.",
  "NoWriteBack runs the local cycle without changing GitHub labels or comments.",
  "Committed .hdo/config.json is loaded automatically unless IgnoreRepositoryConfig is set.",
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
    case "run": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const { result, exitCode } = await runRunCommand({ parsed, platform, schemas });
      // Mirrors hdo.ps1's `run` case: prints the run (or DryRun execution-plan)
      // object as JSON with or without `-Json` (same rationale as `config`/`doctor`).
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCode;
    }
    case "status": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const result = await runStatusCommand({ parsed, platform, schemas });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case "issues": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const { candidates, exitCode } = await runIssuesCommand({ parsed, platform, schemas });
      // Mirrors hdo.ps1's `issues` case: prints the candidates array as JSON with or
      // without `-Json` (same rationale as `config`/`doctor`/`run`).
      process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
      // Oracle: hdo.ps1:82, "if ($candidates.Count -eq 0) { exit 4 }" (plan Q4).
      return exitCode;
    }
    case "inspect": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const result = await runInspectCommand({ parsed, platform, schemas });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case "cleanup": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const result = await runCleanupCommand({ parsed, platform, schemas });
      // `undefined` is the `-WhatIf` ShouldProcess branch (`removeRunWorktree`
      // returns nothing there). `JSON.stringify(undefined)` returns the string
      // "undefined", not "null", so it is handled explicitly here to match
      // PowerShell's observed `$null | ConvertTo-Json` output of `null` (plan Q1).
      process.stdout.write(result === undefined ? "null\n" : `${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case "labels": {
      const platform = getPlatform();
      const schemas = loadSchemaRegistry();
      const result = await runLabelsCommand({ parsed, platform, schemas });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
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
    // Mirrors hdo.ps1's top-level catch: write the message to stderr, exit 2 (4 for
    // "No eligible HDO Issue*", hdo.ps1:155 - matched by prefix, like PS's `-like`).
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = message.startsWith("No eligible HDO Issue") ? 4 : 2;
  });
