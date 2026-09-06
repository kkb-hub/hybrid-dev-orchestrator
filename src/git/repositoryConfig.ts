// Port of `Get-HdoRepositoryConfigSnapshot` (Configuration.ps1) on top of `GitClient`.
// Lives in `git/` (not `core/`) because it needs the filesystem (to check whether an
// uncommitted `.hdo/config.json` exists in the working tree, for the two "exists but
// not trustworthy yet" error messages) and a real git process.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import type { RepositoryConfigSnapshot } from "../core/config/repository.ts";
import { formatProcessFailure, GitClient, sha256Hex } from "./index.ts";

const RELATIVE_CONFIG_PATH = ".hdo/config.json";

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function getRepositoryConfigSnapshot(
  git: GitClient,
  schemas: SchemaRegistry,
  repositoryPath: string,
  revision = "HEAD",
): Promise<RepositoryConfigSnapshot> {
  const repositoryRoot = await git.repositoryRoot(repositoryPath);
  const workingTreePath = join(repositoryRoot, RELATIVE_CONFIG_PATH);

  const commitResult = await git.revParseVerify(repositoryRoot, `${revision}^{commit}`);
  if (commitResult.exitCode !== 0) {
    if (fileExists(workingTreePath)) {
      throw new Error(
        `Repository configuration exists but '${revision}' is not a readable commit. Commit .hdo/config.json before HDO can trust it.`,
      );
    }
    return {
      loaded: false,
      ignored: false,
      path: workingTreePath,
      revision,
      commit: null,
      blob: null,
      sha256: null,
      value: null,
    };
  }

  const commit = commitResult.stdout.trim();
  const objectName = `${commit}:${RELATIVE_CONFIG_PATH}`;
  const blobResult = await git.revParseVerify(repositoryRoot, objectName);
  if (blobResult.exitCode !== 0) {
    if (fileExists(workingTreePath)) {
      throw new Error("Repository configuration must be committed before HDO can load it automatically: .hdo/config.json");
    }
    return {
      loaded: false,
      ignored: false,
      path: workingTreePath,
      revision,
      commit,
      blob: null,
      sha256: null,
      value: null,
    };
  }

  const showResult = await git.show(repositoryRoot, objectName);
  if (showResult.exitCode !== 0) {
    throw new Error(formatProcessFailure("git", showResult.exitCode, showResult.stdout, showResult.stderr));
  }
  const content = showResult.stdout;

  // Mirrors Test-HdoJsonSchema, which itself first attempts `ConvertFrom-Json` and
  // reports a JSON parse failure as a schema validation failure (not the separate
  // "Invalid repository configuration JSON" message below, which PowerShell's second,
  // redundant `ConvertFrom-Json` after a successful schema check exists to catch).
  let parsedForSchema: unknown;
  try {
    parsedForSchema = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Repository configuration schema validation failed for '${workingTreePath}' at ${commit}: Invalid JSON: ${(error as Error).message}`,
    );
  }
  const schemaValidation = schemas.get("hdo-repository-config")(parsedForSchema);
  if (!schemaValidation.valid) {
    throw new Error(
      `Repository configuration schema validation failed for '${workingTreePath}' at ${commit}: ${schemaValidation.errors.join("; ")}`,
    );
  }

  let value: JsonObject;
  try {
    value = JSON.parse(content) as JsonObject;
  } catch (error) {
    throw new Error(`Invalid repository configuration JSON in '${workingTreePath}' at ${commit}: ${(error as Error).message}`);
  }

  return {
    loaded: true,
    ignored: false,
    path: workingTreePath,
    revision,
    commit,
    blob: blobResult.stdout.trim(),
    sha256: sha256Hex(content),
    value,
  };
}
