// Windows PlatformAdapter, trimmed to phase 1's needs (see types.ts banner).
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { expandPath as expandPathCore } from "../core/config/expand.ts";
import { comparableFullPath, isPathWithinRoot, resolveExistingAncestor } from "./paths.ts";
import type { PlatformAdapter } from "./types.ts";

function normalizedNoTrailingSep(path: string): string {
  const full = resolve(path);
  return full.length > 3 && (full.endsWith(sep) || full.endsWith("/")) ? full.slice(0, -1) : full;
}

function homeDir(): string {
  return process.env.USERPROFILE ?? "C:\\Users\\Default";
}

/**
 * .NET `[System.IO.Path]::GetFullPath` expands an 8.3 short name (`RUNNER~1`) that
 * appears in the *existing* prefix of its input via `GetLongPathNameW`, and does
 * nothing at all when the input contains no `~` (that is its own fast path - see
 * `Expand-HdoPath`/core/config/expand.ts's header, whose final step mirrors
 * `GetFullPath` via `path.resolve`, but `path.resolve` never expands short names).
 * This closes that gap for the Windows adapter only: GitHub Actions' `windows-latest`
 * resolves `%TEMP%` to a short-name path (`C:\Users\RUNNER~1\...`), so without this a
 * path built from `%TEMP%` would keep the short name here while PowerShell's
 * `GetFullPath` expands it, breaking config/CLI parity.
 *
 * `resolveExistingAncestor` finds the deepest existing ancestor and canonicalizes it
 * via `realpathSync.native` - which is an approximation, not an exact match, for
 * `GetLongPathNameW`: the .NET call only expands short names and never follows
 * symlinks/junctions, whereas `realpathSync.native` resolves the FINAL path (reparse
 * points included). The two agree whenever the existing prefix contains no reparse
 * point, which is the expected case for a plain filesystem path like `%TEMP%`; see
 * docs/architecture.md 16.4 item 9.
 */
function expandShortNamesInExistingPrefix(fullPath: string): string {
  if (!fullPath.includes("~")) return fullPath;
  return resolveExistingAncestor(fullPath, (p) => realpathSync.native(p));
}

export function createWindowsPlatformAdapter(): PlatformAdapter {
  const adapter: PlatformAdapter = {
    name: "windows",

    getEnv(name: string): string | undefined {
      return process.env[name];
    },

    cwd(): string {
      return process.cwd();
    },

    userConfigDir(): string {
      return process.env.APPDATA ?? join(homeDir(), "AppData", "Roaming");
    },

    defaultDataDir(): string {
      return process.env.LOCALAPPDATA ?? join(homeDir(), "AppData", "Local");
    },

    pathEquals(a: string, b: string): boolean {
      return normalizedNoTrailingSep(a).toLowerCase() === normalizedNoTrailingSep(b).toLowerCase();
    },

    realPath(p: string): string {
      return realpathSync.native(p);
    },

    comparableFullPath(rawPath: string): string {
      return comparableFullPath(adapter, rawPath);
    },

    isPathWithinRoot(candidate: string, root: string): boolean {
      return isPathWithinRoot(adapter, candidate, root);
    },

    expandPath(rawPath: string, repositoryPath?: string): string {
      return expandShortNamesInExistingPrefix(expandPathCore(rawPath, repositoryPath, adapter));
    },
  };
  return adapter;
}
