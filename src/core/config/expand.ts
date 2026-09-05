// Pure `%VAR%` path template expansion, mirroring `Expand-HdoPath` in Common.ps1
// exactly (including its error text). The environment lookup and platform default
// directories are injected via `EnvironmentTokenResolver` so this file never touches
// `node:os`/`node:fs`/`node:child_process` and can run under the core boundary test.
//
// Order of operations, matching Expand-HdoPath line for line:
//   1. If the raw %LOCALAPPDATA% env var is unset AND the token appears (case
//      -insensitively) in the path, replace it with the injected platform default
//      data directory - or throw if that default is also unavailable.
//   2. Same for %APPDATA% against the platform user config directory.
//   3. General `%VAR%` expansion (mirrors [Environment]::ExpandEnvironmentVariables):
//      every other token is replaced by the resolver's value when defined, and left
//      untouched (percent signs and all) when not - PowerShell does not throw on an
//      unknown token, it just leaves it literally in place.
//   4. Literal `{repository}` substitution (only when repositoryPath is given).
//   5. If the result is not already absolute, root it under repositoryPath (or the
//      resolver's cwd fallback when repositoryPath is not given).
//   6. Final `resolve()` (mirrors `[System.IO.Path]::GetFullPath`, with two known
//      divergences: `path.resolve` trims a trailing separator from its result,
//      whereas .NET `GetFullPath` preserves one if the input had it - e.g.
//      `{repository}/` expands to `C:\repo` here but `C:\repo\` under PowerShell.
//      See docs/architecture.md 16.4 item 7 for the config-validation consequence.
//      Second, `GetFullPath` also expands an 8.3 short name (`RUNNER~1`) found in the
//      existing prefix of its input, which `path.resolve` never does; this module
//      stays pure (no node:fs) so it cannot close that gap itself - the Windows
//      PlatformAdapter (src/platform/windows.ts) does it as a post-step on top of
//      this function's result. See docs/architecture.md 16.4 item 9.
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export interface EnvironmentTokenResolver {
  /** Raw lookup of a single environment variable by exact name; undefined if unset. */
  getEnv(name: string): string | undefined;
  /** Platform default data directory - the %LOCALAPPDATA% fallback target. */
  defaultDataDir(): string;
  /** Platform default user config directory - the %APPDATA% fallback target. */
  userConfigDir(): string;
  /** Current working directory to root a relative path under when no repositoryPath is given. */
  cwd(): string;
}

// Global regex constants reused only via String.prototype.replace(), which resets
// lastIndex to 0 at the start of every call per the ECMA-262 algorithm - so sharing
// these objects across calls is safe (no stale lastIndex leaks into `.test()`, since
// `.test()` is never called on these two).
const LOCALAPPDATA_REPLACE_PATTERN = /%LOCALAPPDATA%/gi;
const APPDATA_REPLACE_PATTERN = /%APPDATA%/gi;
const GENERIC_TOKEN_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

function containsTokenCaseInsensitive(text: string, token: string): boolean {
  return new RegExp(`%${token}%`, "i").test(text);
}

function expandEnvironmentVariables(text: string, resolver: EnvironmentTokenResolver): string {
  return text.replace(GENERIC_TOKEN_PATTERN, (match, name: string) => {
    const value = resolver.getEnv(name);
    return value !== undefined ? value : match;
  });
}

export function expandPath(rawPath: string, repositoryPath: string | undefined, resolver: EnvironmentTokenResolver): string {
  let expanded = rawPath;

  if (resolver.getEnv("LOCALAPPDATA") === undefined && containsTokenCaseInsensitive(expanded, "LOCALAPPDATA")) {
    const directory = resolver.defaultDataDir();
    if (!directory) {
      throw new Error(
        `Path '${rawPath}' references %LOCALAPPDATA% but neither the environment variable nor a platform default directory is available.`,
      );
    }
    expanded = expanded.replace(LOCALAPPDATA_REPLACE_PATTERN, () => directory);
  }

  if (resolver.getEnv("APPDATA") === undefined && containsTokenCaseInsensitive(expanded, "APPDATA")) {
    const directory = resolver.userConfigDir();
    if (!directory) {
      throw new Error(
        `Path '${rawPath}' references %APPDATA% but neither the environment variable nor a platform default directory is available.`,
      );
    }
    expanded = expanded.replace(APPDATA_REPLACE_PATTERN, () => directory);
  }

  expanded = expandEnvironmentVariables(expanded, resolver);

  if (repositoryPath) {
    expanded = expanded.split("{repository}").join(repositoryPath);
  }

  if (!isAbsolute(expanded)) {
    const base = repositoryPath || resolver.cwd();
    expanded = join(base, expanded);
  }

  return resolvePath(expanded);
}
