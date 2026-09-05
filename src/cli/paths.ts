// Filesystem locations the CLI (composition root) needs, resolved from this file's
// own location so the CLI works regardless of the caller's current working
// directory (mirrors `$PSScriptRoot`-based resolution in hdo.ps1).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL(".", import.meta.url));
/** src/cli -> repo root is two levels up. */
export const REPO_ROOT = resolve(CLI_DIR, "..", "..");
export const CONFIG_DEFAULT_PATH = resolve(REPO_ROOT, "config", "hdo.default.json");
export const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas");
export const SCHEMA_FIXTURES_DIR = resolve(REPO_ROOT, "tests", "fixtures", "schema");
export const PROJECT_CONTRACT_PATH = resolve(REPO_ROOT, ".hdo", "project.json");
