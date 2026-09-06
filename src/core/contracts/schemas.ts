// Schema name registry. `core` never reads schema files itself (that is a
// composition-root/CLI concern - see src/cli/schemaLoader.ts); this module only
// knows how to cache compiled validators once the caller has injected the already
// -parsed schema documents.
import { compileSchema, type CompiledValidator, type SchemaObject } from "./validate.ts";

export const SCHEMA_NAMES = [
  "hdo-config",
  "hdo-repository-config",
  "issue-contract",
  "project-contract",
  "review-result",
  "task-contract",
  "worker-result",
] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

export type SchemaDocumentMap = Record<SchemaName, SchemaObject>;

/**
 * Resolves compiled Ajv validators by name, from a map of already-parsed schema
 * documents supplied by the composition root. Compilation is lazy and cached: a
 * schema is only compiled the first time it is asked for.
 */
export class SchemaRegistry {
  private readonly documents: SchemaDocumentMap;
  private readonly compiled = new Map<SchemaName, CompiledValidator>();

  constructor(documents: SchemaDocumentMap) {
    this.documents = documents;
  }

  get(name: SchemaName): CompiledValidator {
    const cached = this.compiled.get(name);
    if (cached) return cached;
    const document = this.documents[name];
    if (!document) {
      throw new Error(`Unknown schema name '${name}'. Known schemas: ${SCHEMA_NAMES.join(", ")}`);
    }
    const validator = compileSchema(document);
    this.compiled.set(name, validator);
    return validator;
  }

  /**
   * Returns the raw, already-parsed schema document for `name` (the same object
   * `get()` would compile), without compiling it. Lets hosts hand the canonical
   * schema straight to `claudeSchema`/`codexSchema` (transport-schema derivation) so
   * they never need to re-read a schema file themselves. Throws the identical
   * "Unknown schema name" text `get()` throws, for the same unknown `name`.
   */
  getDocument(name: SchemaName): SchemaObject {
    const document = this.documents[name];
    if (!document) {
      throw new Error(`Unknown schema name '${name}'. Known schemas: ${SCHEMA_NAMES.join(", ")}`);
    }
    return document;
  }
}

export function isSchemaName(value: string): value is SchemaName {
  return (SCHEMA_NAMES as readonly string[]).includes(value);
}
