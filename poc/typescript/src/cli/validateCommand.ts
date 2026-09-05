import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAgainstSchema, type SchemaObject } from "../core/contracts/validate.ts";
import type { ParsedArgs } from "./args.ts";
import { SCHEMAS_DIR } from "./paths.ts";

export async function runValidateCommand(parsed: ParsedArgs): Promise<number> {
  const [schemaName, jsonFile] = parsed.positionals;
  if (!schemaName || !jsonFile) {
    process.stderr.write("Usage: main.ts validate <schemaName> <jsonFile> [--json]\n");
    return 2;
  }

  const schemaPath = join(SCHEMAS_DIR, `${schemaName}.schema.json`);
  let schema: SchemaObject;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8")) as SchemaObject;
  } catch (error) {
    process.stderr.write(`Could not read schema '${schemaName}' (${schemaPath}): ${(error as Error).message}\n`);
    return 2;
  }

  let data: unknown;
  try {
    data = JSON.parse(await readFile(resolve(jsonFile), "utf8"));
  } catch (error) {
    process.stderr.write(`Could not read/parse JSON file '${jsonFile}': ${(error as Error).message}\n`);
    return 2;
  }

  const result = validateAgainstSchema(schema, data);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    process.stdout.write("valid\n");
  } else {
    process.stdout.write(`invalid:\n${result.errors.map((error) => ` - ${error}`).join("\n")}\n`);
  }
  return result.valid ? 0 : 2;
}
