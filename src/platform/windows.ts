// Windows PlatformAdapter. Phase 2 (ADR-0001 Migration strategy) adds
// `resolveExecutable`/`killProcessTree`/`isReparsePointInPath`/`removeTree`/
// `createProcessContainer` on top of phase 1's userConfigDir/defaultDataDir/
// pathEquals/isPathWithinRoot/expandPath.
//
// Executable resolution is PATHEXT-aware but deliberately filters candidates down to
// `.exe`/`.com` only: `.cmd`/`.bat` (and `.ps1`) shims are never resolved here,
// because Node's `spawn()` of a bare `.cmd`/`.bat` path throws *synchronously* on
// modern Node (EINVAL, CVE-2024-27980) unless `shell: true` is set, and
// `NodeProcessRunner` never sets `shell: true`. Practically this means npm-global
// shims such as `claude.cmd`/`codex.cmd` are NOT resolved by this adapter; a later
// migration phase must either follow the shim to its real `node <script>` target or
// rely on an installer build that ships a `.exe`. This is a documented divergence
// from PowerShell's `Get-Command`, which DOES resolve `npm.cmd`-style shims (see
// ADR-0001 Migration strategy phase 5 and docs/architecture.md 16.4).
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { expandPath as expandPathCore } from "../core/config/expand.ts";
import { createWindowsProcessContainer } from "./jobObject.ts";
import { comparableFullPath, isPathWithinRoot, resolveExistingAncestor } from "./paths.ts";
import type { PlatformAdapter, ProcessContainer } from "./types.ts";

// F-04 (ported from poc/typescript/src/platform/windows.ts): the only extensions
// Node can `spawn()` directly (no `shell: true`, no EINVAL).
const RESOLVABLE_EXTENSIONS = new Set([".exe", ".com"]);

function hasResolvableExtension(candidatePath: string): boolean {
  const match = /\.[A-Za-z0-9]+$/.exec(candidatePath);
  return match !== null && RESOLVABLE_EXTENSIONS.has(match[0].toLowerCase());
}

/**
 * A Windows "App Execution Alias" (e.g. `pwsh.exe`/`python.exe` under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` for a Microsoft Store-distributed app) is a
 * small reparse-point placeholder file that `fs.existsSync`/`fs.statSync` cannot see
 * through: `existsSync` reports it as missing and `statSync` throws `EACCES`, even
 * though the file is real, `CreateProcess`-spawnable, and is exactly what a plain
 * `where.exe pwsh` resolves to on a machine where PowerShell 7 was installed this way
 * (observed on this development machine: no separate `Program Files\PowerShell\7`
 * install exists, only this alias). `fs.accessSync(path, F_OK)` and `fs.lstatSync`
 * both see it correctly (`lstatSync().isSymbolicLink()` is true for it), so existence
 * and file-likeness are checked that way instead of `existsSync`/`statSync`.
 */
function candidateExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * N-8: a symlink candidate is only "file-like" if it actually RESOLVES to a regular
 * file - `lstatSync().isSymbolicLink()` alone would also accept a symlink pointing at
 * a directory (or a broken symlink), neither of which `spawn()` can run.
 * `statSync` (which follows the link) is used to confirm that, EXCEPT when it itself
 * throws: that is exactly the App Execution Alias case documented above
 * (`fs.statSync` throws `EACCES` for a real, spawnable reparse-point placeholder), so
 * a `statSync` failure on a path `lstatSync` already confirmed is a symlink is
 * tolerated rather than rejected.
 */
function isFileLike(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (stats.isFile()) return true;
    if (!stats.isSymbolicLink()) return false;
    try {
      return statSync(path).isFile();
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function findExecutableOnPath(name: string): string | undefined {
  // An already-qualified path (contains a separator) is checked directly, but is
  // still subject to the same .exe/.com-only filter (a caller-supplied `foo.cmd`
  // absolute path must not be handed to `spawn()` either).
  if (name.includes("/") || name.includes("\\")) {
    if (!hasResolvableExtension(name)) return undefined;
    return candidateExists(name) && isFileLike(name) ? resolve(name) : undefined;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // N-8: `Get-Command` treats a name's trailing "extension" as already-qualified
  // only when it is actually one of PATHEXT's extensions - a name containing a dot
  // that ISN'T a recognized extension (e.g. `python3.12`) must still try every
  // PATHEXT candidate (`python3.12.exe`, ...), not be treated as a literal,
  // extension-complete filename that only PATHEXT-less lookup would ever find.
  const trailingExtensionMatch = /\.[A-Za-z0-9]+$/.exec(name);
  const trailingExtension = trailingExtensionMatch ? trailingExtensionMatch[0] : "";
  const hasRecognizedExtension = pathExt.some((ext) => ext.toLowerCase() === trailingExtension.toLowerCase());
  const candidates = hasRecognizedExtension ? [name] : pathExt.map((ext) => `${name}${ext}`);
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      if (!hasResolvableExtension(candidate)) continue;
      const fullPath = join(dir, candidate);
      if (candidateExists(fullPath) && isFileLike(fullPath)) return fullPath;
    }
  }
  return undefined;
}

function resolveTaskkill(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  const explicit = join(systemRoot, "System32", "taskkill.exe");
  return existsSync(explicit) ? explicit : "taskkill.exe";
}

/**
 * S-6(b): mirrors `Test-HdoReparsePointInPath`'s `Get-Item -LiteralPath ... -Force
 * -ErrorAction Stop` (Runner.ps1) - a MISSING segment throws (a terminating error in
 * PS), it does not silently report "not a reparse point". Deliberately does not
 * catch `lstatSync`'s error here; callers that want a missing-root/segment to mean
 * "outside" must check for that themselves before calling this (see
 * `isReparsePointInPath` below, which checks path-containment before ever touching
 * the filesystem, exactly mirroring PS's own check order).
 *
 * S-6(a) (documented divergence, not fixed here - see docs/architecture.md 16.4):
 * this only recognizes the symlink/junction/App-Execution-Alias reparse tags that
 * `lstatSync().isSymbolicLink()` sees, whereas PS's `Attributes -band
 * [FileAttributes]::ReparsePoint` recognizes ANY reparse tag, including OneDrive/
 * ProjFS placeholder files that Node's `fs` module does not surface as symlinks.
 */
function isReparsePoint(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

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
    spawnDetached: false,

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
      const rootFull = normalizedNoTrailingSep(root);
      const childFull = normalizedNoTrailingSep(child);
      const childEqualsRoot = childFull.toLowerCase() === rootFull.toLowerCase();
      // S-6(b): checked BEFORE any filesystem access, mirroring PS's own order
      // (`Test-HdoReparsePointInPath` checks `Test-HdoPathWithinRoot` first, only
      // then calls `Get-Item` on the root) - a child outside root returns `true`
      // without ever needing `root` itself to exist, so a nonexistent root does not
      // spuriously throw for an otherwise-unrelated `child`.
      if (!childEqualsRoot && !childFull.toLowerCase().startsWith(`${rootFull.toLowerCase()}${sep}`)) return true;
      if (isReparsePoint(rootFull)) return true;
      if (childEqualsRoot) return false;
      const relative = childFull.slice(rootFull.length + 1);
      let current = rootFull;
      for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
        current = join(current, segment);
        if (isReparsePoint(current)) return true;
      }
      return false;
    },

    async removeTree(path: string): Promise<void> {
      // Verified locally (Node 24, Windows 11): `fs.rm` with `recursive`/`force`
      // deletes paths well past 260 characters without a `\\?\`-prefixed retry - see
      // Issue #25 and src/git/index.ts's `worktreeRemove`. `force: true` also makes
      // this a no-op (never throws) when `path` does not exist.
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    },

    async createProcessContainer(pid: number): Promise<ProcessContainer> {
      return createWindowsProcessContainer(pid);
    },
  };
  return adapter;
}
