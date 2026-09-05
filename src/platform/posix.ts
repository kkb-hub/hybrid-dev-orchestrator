// POSIX PlatformAdapter, trimmed to phase 1's needs (see types.ts banner). Not a
// migration-phase gate (ADR-0001 Amendment 2026-09-05 makes Windows the first
// target) but kept alongside windows.ts so `getPlatform()` behaves sensibly if this
// ever runs under WSL2/Linux ahead of the dedicated phase.
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { expandPath as expandPathCore } from "../core/config/expand.ts";
import { comparableFullPath, isPathWithinRoot } from "./paths.ts";
import type { PlatformAdapter } from "./types.ts";

function homeDir(): string {
  return process.env.HOME ?? "/root";
}

function xdgOrFallback(envName: string, fallback: string): string {
  const value = process.env[envName];
  return value && value.length > 0 ? value : fallback;
}

function normalizeNoTrailingSep(path: string): string {
  const full = resolve(path);
  return full.length > 1 && full.endsWith(sep) ? full.slice(0, -1) : full;
}

export function createPosixPlatformAdapter(): PlatformAdapter {
  const adapter: PlatformAdapter = {
    name: "posix",

    getEnv(name: string): string | undefined {
      return process.env[name];
    },

    cwd(): string {
      return process.cwd();
    },

    userConfigDir(): string {
      return xdgOrFallback("XDG_CONFIG_HOME", join(homeDir(), ".config"));
    },

    defaultDataDir(): string {
      return xdgOrFallback("XDG_DATA_HOME", join(homeDir(), ".local", "share"));
    },

    pathEquals(a: string, b: string): boolean {
      return normalizeNoTrailingSep(a) === normalizeNoTrailingSep(b);
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
      return expandPathCore(rawPath, repositoryPath, adapter);
    },
  };
  return adapter;
}
