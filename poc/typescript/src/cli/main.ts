#!/usr/bin/env node
// Composition root: wires core + platform + process + git together. Subcommands:
// doctor, probe, validate <schemaName> <jsonFile>, config. Exit codes mirror HDO
// (0 success, 2 argument/config/schema error, 3 preflight failure - see doctor.ts).
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { runConfigCliCommand } from "./configCliCommand.ts";
import { runDoctor } from "./doctor.ts";
import { runProbe } from "./probe.ts";
import { runValidateCommand } from "./validateCommand.ts";

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: main.ts <command> [options]",
      "",
      "Commands:",
      "  doctor                          Environment/config preflight (exit 3 on failure)",
      "  probe                           Print observed OS/runtime differences as JSON",
      "  validate <schemaName> <file>    Validate a JSON file against schemas/<schemaName>.schema.json",
      "  config                          Print the resolved, merged, validated configuration",
      "",
      "Options:",
      "  --json                          Machine-readable JSON on stdout",
      "  --config a.json,b.json          Explicit config overlays, merged left to right (config command only)",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  const parsed = parseArgs(rest);
  const platform = getPlatform();

  switch (subcommand) {
    case "doctor":
      return runDoctor(platform, parsed.json);
    case "probe":
      return runProbe(platform, parsed.json);
    case "validate":
      return runValidateCommand(parsed);
    case "config":
      return runConfigCliCommand(platform, parsed);
    default:
      printUsage();
      return 2;
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 2;
  });
