// Pure port of the checks `Get-HdoProjectContract` (Configuration.ps1) performs
// AFTER reading the file and validating it against schemas/project-contract.schema.json
// - schemaVersion, gate id uniqueness (case-insensitive), command-required, and exit
// -code class overlap. File reading and schema validation are a `cli` concern (both
// need the filesystem / an injected SchemaRegistry); see src/cli for the composition
// root that calls this after those two steps.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { getValue } from "./value.ts";

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function asNumber(value: JsonValue | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function hdoArrayItems(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function addCaseInsensitive(set: Set<string>, value: string): boolean {
  const key = value.toLowerCase();
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

/**
 * Throws with the same message text as `Get-HdoProjectContract` on the first
 * violation found (PowerShell throws eagerly rather than collecting a list, unlike
 * `Test-HdoConfiguration`). `path` is only used for error message text.
 */
export function checkProjectContract(contract: JsonObject, path: string): void {
  if (asNumber(getValue(contract, "schemaVersion", 0), 0) !== 1) {
    throw new Error(`Project contract schemaVersion must be 1: ${path}`);
  }

  const ids = new Set<string>();
  for (const gate of hdoArrayItems(getValue(contract, "validationGates", []))) {
    const gateObject = isPlainObject(gate) ? gate : {};
    const id = asString(getValue(gateObject, "id", ""));
    if (!id) throw new Error(`A validation gate in '${path}' has no id.`);
    if (!addCaseInsensitive(ids, id)) throw new Error(`Duplicate validation gate id '${id}' in '${path}'.`);
    if (!getValue(gateObject, "command", "")) throw new Error(`Validation gate '${id}' has no command.`);

    const exitClasses = [
      getValue(gateObject, "exitCodes.passed", []),
      getValue(gateObject, "exitCodes.failed", []),
      getValue(gateObject, "exitCodes.indeterminate", []),
    ];
    const seenExitCodes = new Set<number>();
    for (const exitClass of exitClasses) {
      for (const exitCode of hdoArrayItems(exitClass)) {
        const numeric = asNumber(exitCode, NaN);
        if (seenExitCodes.has(numeric)) {
          throw new Error(`Validation gate '${id}' has exit code '${asString(exitCode)}' in more than one class.`);
        }
        seenExitCodes.add(numeric);
      }
    }
  }
}
