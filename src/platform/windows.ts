// Windows PlatformAdapter. Phase 2 (ADR-0001 Migration strategy) adds
// `resolveExecutable`/`killProcessTree`/`isReparsePointInPath`/`removeTree`/
// `createProcessContainer` on top of phase 1's userConfigDir/defaultDataDir/
// pathEquals/isPathWithinRoot/expandPath.
//
// Executable resolution is PATHEXT-aware and, since phase 5 (WP-D), resolves
// `.exe`/`.com`/`.cmd`/`.bat` - PATHEXT's own default order (`.COM;.EXE;.BAT;.CMD`)
// already makes an `.exe`/`.com` in the same directory win over a `.cmd`/`.bat`
// there, matching `Get-Command -CommandType Application`. `.cmd`/`.bat` are
// resolved (rather than skipped, as phase 2 left them) because
// `NodeProcessRunner.run` (src/process/runner.ts) now detects a resolved
// `.cmd`/`.bat` path and spawns `cmd.exe` directly with a command line built and
// validated by `src/core/process/cmdShim.ts`, instead of asking Node to `spawn()`
// the batch file directly - which throws *synchronously* on modern Node (EINVAL,
// CVE-2024-27980) unless `shell: true` is set, and `NodeProcessRunner` never sets
// `shell: true`. Practically this means npm-global shims such as
// `claude.cmd`/`codex.cmd` ARE now resolved (and runnable) by this adapter, closing
// the divergence from PowerShell's `Get-Command` that phase 2 documented (ADR-0001
// Migration strategy phase 5, docs/architecture.md 16.4 phase-2 item 4).
//
// `.ps1` is deliberately still never resolved (Issue #35): only Application-type
// executables are ever resolved/spawned by either implementation - PowerShell's own
// oracle uses `Get-Command <name> -CommandType Application`, which never returns a
// `.ps1` script either. An npm-global layout with both `claude.ps1` and `claude.cmd`
// therefore resolves to `claude.cmd` here (matching PS), and a `.ps1`-only command is
// `undefined` here (matching PS, which previously threw at run time for that case).
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { expandPath as expandPathCore } from "../core/config/expand.ts";
import { createWindowsProcessContainer } from "./jobObject.ts";
import { comparableFullPath, isPathWithinRoot, resolveExistingAncestor } from "./paths.ts";
import type { PlatformAdapter, ProcessContainer } from "./types.ts";

// F-04 (ported from poc/typescript/src/platform/windows.ts), extended in phase 5
// (WP-D): the extensions `NodeProcessRunner` can actually get running without
// `shell: true` - `.exe`/`.com` via a direct `spawn()`, `.cmd`/`.bat` via the
// validated `cmd.exe` wrapper in `src/process/runner.ts`. `.ps1` is deliberately
// excluded (see the module banner above).
const RESOLVABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);

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

/**
 * P-1: a candidate built by appending a PATHEXT entry (e.g. `.EXE`) to `name` carries
 * PATHEXT's own casing, not the file's real on-disk casing - `Get-Command`'s
 * `.Source` reports the on-disk name (`git.exe`), and phase-5's `doctor` surfaces
 * this text to users (`command:git`/`runner:<r>:shim` messages), so the divergence is
 * no longer just an internal implementation detail once it is user-visible. Looks up
 * `dir`'s real directory entry for `candidate` case-insensitively and returns that
 * casing; falls back to the constructed `fullPath` unchanged if the directory can't
 * be listed (e.g. a permissions error) or, defensively, if no matching entry is
 * found. This runs strictly AFTER `candidateExists`/`isFileLike` have already
 * confirmed `fullPath` resolves to something real - including an App Execution
 * Alias reparse-point placeholder, which `readdirSync` still lists by its ordinary
 * directory-entry name (only `stat`, not `readdir`, is affected by that reparse
 * behaviour), so alias resolution is unaffected by this lookup.
 */
function realCasing(dir: string, candidate: string, fullPath: string): string {
  try {
    const entries = readdirSync(dir);
    const match = entries.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
    return match ? join(dir, match) : fullPath;
  } catch {
    return fullPath;
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
      if (candidateExists(fullPath) && isFileLike(fullPath)) return realCasing(dir, candidate, fullPath);
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
