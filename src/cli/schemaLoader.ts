// Reads the 7 canonical schema files (unmodified) and builds the SchemaRegistry.
// This is the only place phase 1 reads `schemas/*.json` from disk - `core` never
// touches the filesystem itself (see src/core/contracts/schemas.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../core/contracts/schemas.ts";
import type { SchemaObject } from "../core/contracts/validate.ts";
import { SCHEMAS_DIR } from "./paths.ts";

function readSchema(name: string): SchemaObject {
  const path = join(SCHEMAS_DIR, `${name}.schema.json`);
  return JSON.parse(readFileSync(path, "utf8")) as SchemaObject;
}

export function loadSchemaRegistry(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = readSchema(name);
  }
  return new SchemaRegistry(documents);
}
