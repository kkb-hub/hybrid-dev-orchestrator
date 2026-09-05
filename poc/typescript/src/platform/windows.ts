// Windows PlatformAdapter. Executable resolution is PATHEXT-aware but deliberately
// filters candidates down to `.exe`/`.com` only: `.cmd`/`.bat` (and `.ps1`) shims are
// never resolved here, even though the default PATHEXT order would otherwise offer
// them, because Node's `spawn()` of a bare `.cmd`/`.bat` path throws *synchronously*
// on newer Node (EINVAL, CVE-2024-27980) unless `shell: true` is set, and this PoC
// never sets `shell: true`. Practically this means npm-global shims such as
// `claude.cmd`/`codex.cmd` are NOT resolved by this adapter; a production port must
// follow the shim to its real `node <script>` target or rely on an installer build
// that ships a `.exe`. Two corrections to a previous version of this comment: (1)
// .NET's `Process.Start` on an explicit `npm.cmd` path actually works fine (it is
// only Node's `spawn` that has the EINVAL restriction) - so PowerShell's own
// `Invoke-HdoProcess` is not accidentally protected by the same mechanism; (2) `pwsh`
// `Get-Command npm` resolves to `npm.ps1`, not `npm.cmd`, on a machine with the
// PowerShell-aware npm shim installed - another reason "PowerShell effectively
// requires a .exe too" was not an accurate claim.
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { PlatformAdapter } from "./types.ts";

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// F-04: the only extensions Node can `spawn()` directly (no `shell: true`, no EINVAL).
const RESOLVABLE_EXTENSIONS = new Set([".exe", ".com"]);

function hasResolvableExtension(candidatePath: string): boolean {
  const match = /\.[A-Za-z0-9]+$/.exec(candidatePath);
  return match !== null && RESOLVABLE_EXTENSIONS.has(match[0].toLowerCase());
}

function findExecutableOnPath(name: string): string | undefined {
  // An already-qualified path (contains a separator) is checked directly, but is
  // still subject to the same .exe/.com-only filter (a caller-supplied `foo.cmd`
  // absolute path must not be handed to `spawn()` either).
  if (name.includes("/") || name.includes("\\")) {
    if (!hasResolvableExtension(name)) return undefined;
    return existsSync(name) ? resolve(name) : undefined;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExtension = /\.[A-Za-z0-9]+$/.test(name);
  const candidates = hasExtension ? [name] : pathExt.map((ext) => `${name}${ext}`);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      if (!hasResolvableExtension(candidate)) continue;
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        try {
          if (statSync(fullPath).isFile()) return fullPath;
        } catch {
          // ignore and keep searching
        }
      }
    }
  }
  return undefined;
}

function resolveTaskkill(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  const explicit = join(systemRoot, "System32", "taskkill.exe");
  return existsSync(explicit) ? explicit : "taskkill.exe";
}

function isReparsePoint(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function normalizedNoTrailingSep(path: string): string {
  const full = resolve(path);
  return full.length > 3 && (full.endsWith(sep) || full.endsWith("/")) ? full.slice(0, -1) : full;
}

export function createWindowsPlatformAdapter(): PlatformAdapter {
  return {
    name: "windows",
    spawnDetached: false,

    resolveToken(name: string): string {
      if (process.env[name] !== undefined) return process.env[name]!;
      return `%${name}%`;
    },

    homeDir(): string {
      return process.env.USERPROFILE ?? "C:\\Users\\Default";
    },

    userConfigDir(): string {
      return process.env.APPDATA ?? join(this.homeDir(), "AppData", "Roaming");
    },

    defaultDataDir(): string {
      return process.env.LOCALAPPDATA ?? join(this.homeDir(), "AppData", "Local");
    },

    pathEquals(a: string, b: string): boolean {
      return normalizedNoTrailingSep(a).toLowerCase() === normalizedNoTrailingSep(b).toLowerCase();
    },

    resolveExecutable(name: string): string | undefined {
      return findExecutableOnPath(name);
    },

    async killProcessTree(pid: number): Promise<void> {
      const taskkill = resolveTaskkill();
      await new Promise<void>((resolvePromise) => {
        const child = spawn(taskkill, ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        child.on("error", () => resolvePromise());
        child.on("close", () => resolvePromise());
      });
    },

    isReparsePointInPath(child: string, root: string): boolean {
      const rootFull = normalize(resolve(root));
      const childFull = normalize(resolve(child));
      if (isReparsePoint(rootFull)) return true;
      if (childFull === rootFull) return false;
      if (!childFull.toLowerCase().startsWith(`${rootFull.toLowerCase()}${sep}`)) return true;
      const relative = childFull.slice(rootFull.length + 1);
      let current = rootFull;
      for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
        current = join(current, segment);
        if (isReparsePoint(current)) return true;
      }
      return false;
    },

    realPath(p: string): string {
      return realpathSync.native(p);
    },

    processTreeKillStrategy(): string {
      return "taskkill /T /F /PID (PID tree walk; libuv job covers direct children only)";
    },
  };
}

export function isExecutableAccessible(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathIsAbsoluteWindows(path: string): boolean {
  return isAbsolute(path);
}
