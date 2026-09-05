import type { EnvironmentTokenResolver } from "../core/config/expand.ts";

export interface PlatformAdapter extends EnvironmentTokenResolver {
  readonly name: "windows" | "posix";

  /** Directory that holds `hdo/config.json` (APPDATA on Windows, XDG_CONFIG_HOME on POSIX). */
  userConfigDir(): string;

  /** Directory that holds run/worktree data by default (LOCALAPPDATA on Windows, XDG_DATA_HOME on POSIX). */
  defaultDataDir(): string;

  /** Case-insensitive on Windows, case-sensitive on POSIX, after normalizing both paths. */
  pathEquals(a: string, b: string): boolean;

  /** Resolves an executable name to an absolute path, or undefined if not found. */
  resolveExecutable(name: string): string | undefined;

  /**
   * Terminates a process and (best-effort) its descendants. Callers that need this to
   * work MUST have started the process the way this platform's process/runner.ts
   * documents (e.g. `detached: true` on POSIX so the child is its own process-group
   * leader). See README "既知の制約" for the gaps (on Windows, libuv already maintains
   * one global job per Node host process - not one job per child - shared by every
   * non-detached direct child, and that alone already covers them automatically;
   * reaching a grandchild depends entirely on the direct child still being alive when
   * the PID tree walk runs, since there is no explicit Job Object handle this code
   * holds).
   */
  killProcessTree(pid: number): Promise<void>;

  /** True if any path segment strictly between `root` and `child` (inclusive of root) is a reparse point/symlink. */
  isReparsePointInPath(child: string, root: string): boolean;

  /** Canonical, symlink/junction-resolved form of `p`. Throws if `p` does not exist. */
  realPath(p: string): string;

  /** Name of the kill mechanism this adapter uses, for `probe` diagnostics. */
  processTreeKillStrategy(): string;

  /** Whether newly spawned children should be `detached` for process-group kill to work. */
  readonly spawnDetached: boolean;
}
