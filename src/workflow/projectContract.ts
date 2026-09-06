// Host half of `Get-HdoProjectContract` (Configuration.ps1:549-585): reads the
// project-contract JSON file off disk, schema-validates it, then runs the pure
// post-validation checks (`checkProjectContract`, core/config/projectContract.ts -
// schemaVersion, gate id uniqueness, command-required, exit-code class overlap).
// `src/workflow/**` is a host module (ADR-0001 phase 5 plan §2 boundary): `node:fs`
// is allowed here, but this file never spawns a process and never imports `src/cli`.
import { readFileSync } from "node:fs";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import { checkProjectContract } from "../core/config/projectContract.ts";
import { isRegularFile } from "../runners/artifacts.ts";

/**
 * Copy of `src/cli/configCommand.ts`'s `readJsonFile` JSON-parsing half (same
 * BOM-stripping, same `Invalid JSON in '<path>': <msg>` text) - deliberately NOT
 * imported from `src/cli` (ADR-0001 phase 5 plan §2: `src/workflow/**` may never
 * import `cli`). Its own missing-file branch is unused here: `loadProjectContract`
 * already performs the contract-specific "Project contract was not found" check
 * before this function is ever called.
 */
function parseJsonFile(path: string): JsonObject {
  let parsed: unknown;
  try {
    // `Get-Content -Raw` strips a leading UTF-8 BOM before PowerShell parses it;
    // Node's utf8 decoding does not, so it is stripped explicitly here to match.
    const raw = readFileSync(path, "utf8");
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in '${path}': ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON in '${path}': expected a JSON object`);
  }
  return parsed as JsonObject;
}

/**
 * Port of `Get-HdoProjectContract` (Configuration.ps1:549-585). Throws (in order,
 * matching PowerShell's eager single-violation throw):
 * - `Project contract was not found: <path>` when `path` is not a regular file.
 * - `Invalid JSON in '<path>': <msg>` when the file's content is not valid JSON (or
 *   not a JSON object).
 * - `Project contract schema validation failed for '<path>': <errors joined with
 *   '; '>` when it fails `schemas/project-contract.schema.json` (PowerShell's
 *   `Test-Json` produces a single `.error` string here; Ajv produces a list, joined
 *   with '; ' - only the prefix before the first error is contractual, per ADR-0001
 *   phase 5 plan §7 risk 16).
 * - Whatever `checkProjectContract` throws (schemaVersion, duplicate/missing gate
 *   id, missing gate command, overlapping exit-code classes).
 *
 * Returns the parsed, valid contract object otherwise.
 */
export function loadProjectContract(path: string, schemas: SchemaRegistry): JsonObject {
  if (!isRegularFile(path)) {
    throw new Error(`Project contract was not found: ${path}`);
  }
  const contract = parseJsonFile(path);
  const validate = schemas.get("project-contract");
  const validation = validate(contract);
  if (!validation.valid) {
    throw new Error(`Project contract schema validation failed for '${path}': ${validation.errors.join("; ")}`);
  }
  checkProjectContract(contract, path);
  return contract;
}
