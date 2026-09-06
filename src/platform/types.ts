// PlatformAdapter. Phase 1 covered userConfigDir/defaultDataDir/pathEquals/
// isPathWithinRoot/expandPath (config/state only). Phase 2 (ADR-0001 Migration
// strategy, process/platform) adds everything process-tree- and long-path-related:
// `resolveExecutable`, `killProcessTree`, `isReparsePointInPath`, `removeTree`,
// `createProcessContainer` (Windows Job Object via koffi - see
// docs/adr/0002-windows-job-object-via-koffi.md), and `spawnDetached`.
import type { EnvironmentTokenResolver } from "../core/config/expand.ts";

export interface PlatformAdapter extends EnvironmentTokenResolver {
  readonly name: "windows" | "posix";

  /** Case-insensitive on Windows, case-sensitive on POSIX, after normalizing both paths. */
  pathEquals(a: string, b: string): boolean;

  /** Canonical, symlink/junction-resolved form of `p`. Throws if `p` does not exist. */
  realPath(p: string): string;

  /** Mirrors `Get-HdoComparableFullPath` (Git.ps1) - see src/platform/paths.ts. */
  comparableFullPath(rawPath: string): string;

  /** Mirrors `Test-HdoPathWithinRoot` (Git.ps1) - see src/platform/paths.ts. */
  isPathWithinRoot(candidate: string, root: string): boolean;

  /**
   * `Expand-HdoPath` port (core/config/expand.ts) plus this platform's own
   * post-processing. On Windows this additionally expands an 8.3 short name
   * (`RUNNER~1`) in the resolved path's existing prefix, matching .NET
   * `[System.IO.Path]::GetFullPath` - see src/platform/windows.ts and
   * docs/architecture.md 16.4 item 9. POSIX just delegates to the core function.
   */
  expandPath(rawPath: string, repositoryPath?: string): string;

  /**
   * Resolves an executable name to an absolute path the way `NodeProcessRunner` can
   * actually get running without `shell: true`, or `undefined` if not found. On
   * Windows this is PATH+PATHEXT-aware and filters candidates down to
   * `.exe`/`.com`/`.cmd`/`.bat` (see src/platform/windows.ts's module comment): an
   * `.exe`/`.com` is `spawn()`-able directly, while a `.cmd`/`.bat` match is run by
   * `NodeProcessRunner` through a validated `cmd.exe` wrapper (see
   * src/core/process/cmdShim.ts and src/process/runner.ts) - PATHEXT's own default
   * order still makes an `.exe`/`.com` in the same directory win over a `.cmd`/`.bat`
   * there. `.ps1` is never resolved by either implementation (Issue #35: only
   * Application-type executables are ever resolved/spawned). An already-qualified
   * path (containing a separator) is checked directly, subject to the same extension
   * filter.
   */
  resolveExecutable(name: string): string | undefined;

  /**
   * Best-effort termination of a process and its descendants by PID, used as the
   * fallback when `createProcessContainer` reports `attached: false` (or was never
   * called/available). Windows: `taskkill /T /F /PID` (a PID-tree walk; fragile
   * against a descendant that has already been reparented away from a dead direct
   * child). POSIX: `process.kill(-pid, 'SIGKILL')` against a detached process-group
   * leader, falling back to `process.kill(pid, 'SIGKILL')`.
   */
  killProcessTree(pid: number): Promise<void>;

  /** True if any path segment strictly between `root` and `child` (inclusive of root) is a reparse point/symlink. */
  isReparsePointInPath(child: string, root: string): boolean;

  /**
   * Removes a directory tree at `path`, long-path-safe on Windows (verified on this
   * machine: `fs.rm` with `recursive: true, force: true` deletes paths well past 260
   * characters without needing a `\\?\`-prefixed retry - see Issue #25 and
   * `src/git/index.ts`'s `worktreeRemove`). Never throws if `path` does not exist.
   */
  removeTree(path: string): Promise<void>;

  /**
   * Attempts to place the process identified by `pid` under this platform's
   * strongest available containment mechanism immediately after spawn. On Windows,
   * this holds its own Win32 Job Object (via `koffi`; see
   * docs/adr/0002-windows-job-object-via-koffi.md) with
   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so `dispose()` terminates every
   * descendant still assigned to the job - including a grandchild that inherited a
   * redirected pipe handle, which `killProcessTree`'s PID-tree walk cannot reliably
   * reach once the direct child has already exited. On POSIX this is a no-op
   * container (`attached: false`, `error: ""`); callers must fall back to
   * `killProcessTree`.
   */
  createProcessContainer(pid: number): Promise<ProcessContainer>;

  /** Whether newly spawned children should be `detached` for POSIX process-group kill to work; false on Windows (see `NodeProcessRunner`). */
  readonly spawnDetached: boolean;
}

export interface ProcessContainer {
  /** True if the process was actually placed under this platform's containment mechanism. */
  readonly attached: boolean;
  /**
   * Non-empty iff containment could not be established (e.g. a Win32 API call
   * failed, or `koffi` itself could not be loaded). Callers surface this verbatim in
   * a drain-timeout message, mirroring PowerShell's `KillOnCloseJob.Error` /
   * `"Process-tree containment was unavailable: " + processJob.Error`.
   */
  readonly error: string;
  /** Terminates the container (and, on Windows, every process still assigned to it) immediately. Safe to call when `attached` is false (no-op). */
  terminate(): void;
  /** Releases any OS handles held by this container. Idempotent - safe to call more than once, and safe to call without ever calling `terminate()`. */
  dispose(): void;
}
