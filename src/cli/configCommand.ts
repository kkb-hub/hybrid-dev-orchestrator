// Composition root for the `config` subcommand: reads every config source from disk
// (default/user/repository/explicit), resolves the repository root via git (falling
// back to `isGitRepository = false` exactly like `Get-HdoConfig` when `git rev-parse`
// fails), and calls the pure `resolveHdoConfig` core. Mirrors `hdo.ps1 config`,
// including the fact that `-SetStep` is accepted by the CLI parser but never passed
// through for this subcommand (see hdo.ps1's `Get-HdoCliConfig` helper, which never
// threads `$SetStep` into `Get-HdoConfig` either).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import { getExecutionPlan } from "../core/config/executionPlan.ts";
import type { RepositoryConfigSnapshot } from "../core/config/repository.ts";
import { resolveHdoConfig, type NamedConfigSource, type ResolveConfigHost } from "../core/config/resolve.ts";
import { GitClient } from "../git/index.ts";
import { getRepositoryConfigSnapshot } from "../git/repositoryConfig.ts";
import type { PlatformAdapter } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import type { ParsedArgs } from "./args.ts";
import { CONFIG_DEFAULT_PATH } from "./paths.ts";

/** True for a regular file, matching `Test-Path -PathType Leaf` (a directory is not a "leaf"). */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Mirrors `Read-HdoJsonFile` (Common.ps1), including its exact error message text. */
export function readJsonFile(path: string): JsonObject {
  if (!isRegularFile(path)) throw new Error(`JSON file was not found: ${path}`);
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

export interface ResolveCliConfigOptions {
  parsed: ParsedArgs;
  platform: PlatformAdapter;
  schemas: SchemaRegistry;
  /** Overridable for tests; defaults to a real `git` on PATH. */
  git?: GitClient;
  /**
   * Overrides `parsed.profile` (needed by `selectIssue`'s route-hint re-resolution,
   * Workflow.ps1:246, which calls `Get-HdoConfig` again with the Issue's
   * `preferredExecution` rather than the CLI's original `-Profile`). Behaviour is
   * unchanged when absent - `parsed.profile` is used exactly like before.
   */
  profile?: string;
  /**
   * `-SetStep` overrides, already parsed (`parseSetStepOverrides`). `config`
   * (hdo.ps1's `Get-HdoCliConfig`) never threads `-SetStep` through; `run` does.
   * Behaviour is unchanged (empty) when absent.
   */
  stepOverrides?: Record<string, string>;
  /**
   * When set, a `git rev-parse --show-toplevel` failure is rethrown instead of
   * being swallowed into `isGitRepository = false`. `run` (Workflow.ps1:244,
   * `Get-HdoRepositoryRoot` -> `Invoke-HdoGit ... -ThrowOnError`) must abort
   * before any GitHub access when `-RepositoryPath` is not a git repository;
   * `config`/`doctor`/`status` keep the fallback behaviour (absent/false).
   */
  requireGitRepository?: boolean;
}

const SET_STEP_PATTERN = /^(plan|implement|review|fix)=(?<runner>[A-Za-z0-9._-]+)$/i;

/**
 * Port of hdo.ps1's `-SetStep` parsing loop (hdo.ps1:93-99): each `step=runner`
 * string is matched case-insensitively against the four step names, the runner name
 * captured, and the result accumulated into an object keyed by the STEP NAME AS
 * WRITTEN ON THE COMMAND LINE (mirrors `$stepOverrides[$override.Split('=')[0]] =
 * $Matches.runner` - the key is the raw prefix before `=`, not a normalized-case step
 * name; `resolveHdoConfig`'s `setKeyIgnoreCase` already treats step names
 * case-insensitively when applying them to `config.steps`).
 */
export function parseSetStepOverrides(setStep: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const entry of setStep) {
    const match = entry.match(SET_STEP_PATTERN);
    if (!match?.groups) {
      // Oracle: hdo.ps1:96, "Invalid -SetStep '$override'. Expected step=runner."
      throw new Error(`Invalid -SetStep '${entry}'. Expected step=runner.`);
    }
    const stepName = entry.split("=")[0];
    overrides[stepName] = match.groups.runner;
  }
  return overrides;
}

export async function resolveCliConfig(options: ResolveCliConfigOptions): Promise<JsonObject> {
  const { parsed, platform, schemas } = options;
  const git = options.git ?? new GitClient({ runner: new NodeProcessRunner({ platform }), platform });

  const requestedRepositoryPath = resolve(parsed.repositoryPath);
  let repositoryPath = requestedRepositoryPath;
  let isGitRepository = true;
  try {
    repositoryPath = await git.repositoryRoot(requestedRepositoryPath);
  } catch (error) {
    if (options.requireGitRepository) throw error;
    isGitRepository = false;
  }

  const defaultConfig: NamedConfigSource = {
    origin: CONFIG_DEFAULT_PATH,
    value: readJsonFile(CONFIG_DEFAULT_PATH),
  };

  let userConfig: NamedConfigSource | undefined;
  const userConfigPath = join(platform.userConfigDir(), "hdo", "config.json");
  if (existsSync(userConfigPath)) {
    userConfig = { origin: userConfigPath, value: readJsonFile(userConfigPath) };
  }

  let repositorySnapshot: RepositoryConfigSnapshot;
  if (parsed.ignoreRepositoryConfig || !isGitRepository) {
    repositorySnapshot = {
      loaded: false,
      ignored: parsed.ignoreRepositoryConfig,
      path: join(repositoryPath, ".hdo", "config.json"),
      revision: "HEAD",
      commit: null,
      blob: null,
      sha256: null,
    };
  } else {
    repositorySnapshot = await getRepositoryConfigSnapshot(git, schemas, repositoryPath);
  }

  const explicitConfigs: NamedConfigSource[] = parsed.config.map((rawPath) => {
    const expandedPath = platform.expandPath(rawPath, repositoryPath);
    return { origin: expandedPath, value: readJsonFile(expandedPath) };
  });

  const host: ResolveConfigHost = {
    pathEquals: (a, b) => platform.pathEquals(a, b),
    isPathWithinRoot: (child, root) => platform.isPathWithinRoot(child, root),
    expandPath: (raw, repoPath) => platform.expandPath(raw, repoPath),
  };

  return resolveHdoConfig({
    defaultConfig,
    userConfig,
    repositorySnapshot,
    explicitConfigs,
    overrides: {},
    profile: options.profile !== undefined ? options.profile : parsed.profile,
    // hdo.ps1's `config` subcommand never threads -SetStep into Get-HdoConfig either;
    // `run` (WP-F2) passes `parseSetStepOverrides(parsed.setStep)` here instead.
    stepOverrides: options.stepOverrides ?? {},
    repositoryPath,
    host,
    schemas,
  });
}

/** ISO 8601 UTC timestamp for `execution.generatedAt` (analogous to `Get-HdoUtcTimestamp`). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Mirrors the object shape `hdo.ps1 config` prints. */
export function buildConfigCommandOutput(resolvedConfig: JsonObject, generatedAt: string): JsonObject {
  return {
    profile: resolvedConfig.resolvedProfile ?? null,
    sources: resolvedConfig.configSources ?? [],
    repositoryConfig: resolvedConfig.repositoryConfig ?? null,
    warnings: resolvedConfig.configurationWarnings ?? [],
    execution: getExecutionPlan(resolvedConfig, generatedAt) as unknown as JsonObject,
  };
}
