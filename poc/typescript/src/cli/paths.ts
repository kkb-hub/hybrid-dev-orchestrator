// Filesystem locations the CLI (composition root) needs, resolved from this file's
// own location so the CLI works regardless of the caller's current working directory
// (see plugin-surface, which invokes this file with an unrelated cwd).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL(".", import.meta.url));
export const POC_ROOT = resolve(CLI_DIR, "..", "..");
export const REPO_ROOT = resolve(POC_ROOT, "..", "..");
export const CONFIG_DEFAULT_PATH = resolve(REPO_ROOT, "config", "hdo.default.json");
export const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas");
export const SCHEMA_FIXTURES_DIR = resolve(REPO_ROOT, "tests", "fixtures", "schema");
