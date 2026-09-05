export interface ParsedArgs {
  json: boolean;
  config: string[];
  positionals: string[];
}

/** Minimal, dependency-free argv parser: `--json`, `--config a.json,b.json` / `--config=a.json,b.json`, and positionals. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  let json = false;
  let config: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--config") {
      const value = argv[++i] ?? "";
      config = splitConfigList(value);
      continue;
    }
    if (token.startsWith("--config=")) {
      config = splitConfigList(token.slice("--config=".length));
      continue;
    }
    positionals.push(token);
  }

  return { json, config, positionals };
}

function splitConfigList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
