// POSIX PlatformAdapter. Executable resolution walks PATH and checks the executable
// bit; process-tree kill relies on the child having been spawned with `detached:
// true` (making it its own process-group leader) so `process.kill(-pid, 'SIGKILL')`
// reaches the whole group. This fails if the child itself calls `setsid()` and
// re-parents descendants into a new group - see README "既知の制約".
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync } from "node:fs";
import { delimiter, join, normalize, resolve, sep } from "node:path";
import type { PlatformAdapter } from "./types.ts";

function findExecutableOnPath(name: string): string | undefined {
  if (name.includes("/")) {
    return existsSync(name) && isExecutable(name) ? resolve(name) : undefined;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function xdgOrFallback(envName: string, fallback: string): string {
  const value = process.env[envName];
  return value && value.length > 0 ? value : fallback;
}

export function createPosixPlatformAdapter(): PlatformAdapter {
  return {
    name: "posix",
    spawnDetached: true,

    resolveToken(name: string): string {
      if (process.env[name] !== undefined) return process.env[name]!;
      // AC-02: on POSIX, %LOCALAPPDATA%/%APPDATA% must fall back to the XDG data dir
      // instead of leaving a literal, unusable "%LOCALAPPDATA%" segment in the path.
      if (name === "LOCALAPPDATA" || name === "APPDATA") {
        return this.defaultDataDir();
      }
      return `%${name}%`;
    },

    homeDir(): string {
      return process.env.HOME ?? "/root";
    },

    userConfigDir(): string {
      return xdgOrFallback("XDG_CONFIG_HOME", join(this.homeDir(), ".config"));
    },

    defaultDataDir(): string {
      return xdgOrFallback("XDG_DATA_HOME", join(this.homeDir(), ".local", "share"));
    },

    pathEquals(a: string, b: string): boolean {
      const normalizeNoTrailingSep = (path: string): string => {
        const full = resolve(path);
        return full.length > 1 && full.endsWith(sep) ? full.slice(0, -1) : full;
      };
      return normalizeNoTrailingSep(a) === normalizeNoTrailingSep(b);
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
      const rootFull = normalize(resolve(root));
      const childFull = normalize(resolve(child));
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

    realPath(p: string): string {
      return realpathSync.native(p);
    },

    processTreeKillStrategy(): string {
      return "process.kill(-pid, 'SIGKILL') on a detached process group leader";
    },
  };
}
