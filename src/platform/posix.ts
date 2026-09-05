// POSIX PlatformAdapter. Not a migration-phase gate (ADR-0001 Amendment 2026-09-05
// makes Windows the first target) but kept alongside windows.ts so `getPlatform()`
// behaves sensibly if this ever runs under WSL2/Linux ahead of the dedicated phase.
// Executable resolution walks PATH and checks the executable bit; process-tree kill
// relies on the child having been spawned with `detached: true` (making it its own
// process-group leader) so `process.kill(-pid, 'SIGKILL')` reaches the whole group -
// this fails if the child itself calls `setsid()` and re-parents descendants into a
// new group. There is no POSIX equivalent of the Windows Job Object here;
// `createProcessContainer` is a no-op (`attached: false`) and callers must rely on
// `killProcessTree` alone.
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { expandPath as expandPathCore } from "../core/config/expand.ts";
import { comparableFullPath, isPathWithinRoot } from "./paths.ts";
import type { PlatformAdapter, ProcessContainer } from "./types.ts";

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

// N-8: `X_OK` alone only checks the executable permission bit - a directory (or
// other non-regular-file) with the executable bit set (e.g. `rwxr-xr-x`, needed
// simply to allow traversal into it) would otherwise pass this check despite not
// being something `spawn()` can actually run. `statSync` (follows symlinks) confirms
// the resolved target is a regular file.
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findExecutableOnPath(name: string): string | undefined {
  if (name.includes("/")) {
    return existsSync(name) && isExecutableFile(name) ? resolve(name) : undefined;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const NOOP_PROCESS_CONTAINER: ProcessContainer = {
  attached: false,
  error: "",
  terminate(): void {
    // No-op: callers must fall back to platform.killProcessTree.
  },
  dispose(): void {
    // No-op.
  },
};

export function createPosixPlatformAdapter(): PlatformAdapter {
  const adapter: PlatformAdapter = {
    name: "posix",
    spawnDetached: true,

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

    resolveExecutable(name: string): string | undefined {
      return findExecutableOnPath(name);
    },

    async killProcessTree(pid: number): Promise<void> {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    },

    isReparsePointInPath(child: string, root: string): boolean {
      const rootFull = normalizeNoTrailingSep(root);
      const childFull = normalizeNoTrailingSep(child);
      if (isSymlink(rootFull)) return true;
      if (childFull === rootFull) return false;
      if (!childFull.startsWith(`${rootFull}${sep}`)) return true;
      const relative = childFull.slice(rootFull.length + 1);
      let current = rootFull;
      for (const segment of relative.split("/").filter(Boolean)) {
        current = join(current, segment);
        if (isSymlink(current)) return true;
      }
      return false;
    },

    async removeTree(path: string): Promise<void> {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    },

    async createProcessContainer(): Promise<ProcessContainer> {
      return NOOP_PROCESS_CONTAINER;
    },
  };
  return adapter;
}
