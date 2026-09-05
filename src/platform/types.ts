// PlatformAdapter, trimmed to what phase 1 needs (see ADR-0001 Migration strategy):
// `killProcessTree`/`resolveExecutable`/`isReparsePointInPath` belong to phase 2
// (process/platform) and are intentionally NOT ported yet.
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
}
