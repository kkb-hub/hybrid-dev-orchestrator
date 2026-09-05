// Path containment helpers shared by the Windows/POSIX PlatformAdapter
// implementations. Ported from poc/typescript/src/git/index.ts
// (`comparableFullPath`/`isPathWithinRoot`), which itself mirrors
// `Get-HdoComparableFullPath`/`Test-HdoPathWithinRoot` (Git.ps1) - with two
// deliberate differences documented below (at `comparableFullPath` and at the G-04
// comment inside `isPathWithinRoot`): the symlink-resolution platform difference, and
// - unlike PowerShell - a `root` that is itself a drive root (`C:\`) is handled
// correctly here rather than being silently unsatisfiable. See docs/architecture.md
// 16 "PowerShell 実装との意図的な差異" for the full writeup of both.
import { statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export interface PathContainmentPlatform {
  readonly name: "windows" | "posix";
  /** Canonical, symlink/junction-resolved form of `p`. Throws if `p` does not exist. */
  realPath(p: string): string;
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * G-04: a filesystem root (`C:\`, `/`) must be left as-is - stripping its trailing
 * separator turns `C:\` into the drive-*relative* path `C:`, which Node resolves
 * against `process.cwd()`'s current drive instead of the drive root, silently
 * widening any containment check that uses this as `root`. `path.parse(p).root === p`
 * is true only for an actual root (POSIX `/`, or a Windows drive/UNC root), never for
 * an ordinary directory whose path happens to end in a separator, so this guard does
 * not change behaviour for any other input.
 */
function normalizeNoTrailingSep(p: string): string {
  if (parse(p).root === p) return p;
  return p.length > sep.length && p.endsWith(sep) ? p.slice(0, -sep.length) : p;
}

/**
 * Walks up from `fullPath` to the deepest *existing* ancestor, canonicalizes that
 * ancestor via `realPath`, and re-appends any non-existent tail segments unresolved.
 * Falls back to `fullPath` unchanged if no ancestor exists (all the way to the
 * filesystem root) or if `realPath` throws.
 *
 * Extracted so it can be shared by `comparableFullPath` below (always, both
 * platforms) and by the Windows `expandPath` 8.3-short-name post-step
 * (src/platform/windows.ts, applied only when the path contains `~` - see
 * docs/architecture.md 16.4 item 9).
 */
export function resolveExistingAncestor(fullPath: string, realPath: (p: string) => string): string {
  const missingSegments: string[] = [];
  let existing = fullPath;
  while (!pathExists(existing)) {
    const leaf = basename(existing);
    const parent = dirname(existing);
    if (!leaf || parent === existing) break;
    missingSegments.unshift(leaf);
    existing = parent;
  }
  if (!pathExists(existing)) return fullPath;

  let resolvedExisting: string;
  try {
    resolvedExisting = realPath(existing);
  } catch {
    return fullPath;
  }
  let result = resolvedExisting;
  for (const segment of missingSegments) result = join(result, segment);
  return result;
}

/**
 * Resolve `rawPath` to an absolute, `..`-collapsed path, then canonicalize the
 * deepest *existing* ancestor via `platform.realPath` and re-append any non-existent
 * tail segments unresolved.
 *
 * Difference from `Get-HdoComparableFullPath`: PowerShell only does this
 * ancestor/realpath resolution on Windows (`if (-not $IsWindows) { return $fullPath }`
 * - a POSIX build just normalizes). This port applies it on both platforms, matching
 * poc/typescript/src/git/index.ts: resolving symlinks before the containment check is
 * exactly what closes the symlink-escape variant of the bug everywhere, not just on
 * Windows's packaged-app LocalAppData redirection case.
 */
export function comparableFullPath(platform: PathContainmentPlatform, rawPath: string): string {
  const full = normalizeNoTrailingSep(resolve(rawPath));
  return normalizeNoTrailingSep(resolveExistingAncestor(full, (p) => platform.realPath(p)));
}

/**
 * F-03: `path.resolve()` collapses `..` segments algebraically before anything else
 * runs, so `<root>/a/../../evil` can no longer masquerade as a string that merely
 * *starts with* `<root>`. `comparableFullPath` additionally walks up to the nearest
 * *existing* ancestor and resolves it through `platform.realPath`, so a symlinked
 * root or an intermediate symlink cannot desync the comparison.
 *
 * A candidate equal to `root` itself returns false, matching
 * `Test-HdoPathWithinRoot`'s `StartsWith(root + separator)` semantics (which requires
 * a strict, separator-delimited descendant, not equality).
 */
export function isPathWithinRoot(platform: PathContainmentPlatform, candidate: string, root: string): boolean {
  const resolvedCandidate = comparableFullPath(platform, candidate);
  const resolvedRoot = comparableFullPath(platform, root);
  // H-03: for an ordinary root, a candidate equal to root already fails the
  // separator-prefixed `startsWith` check below. But when `root` is itself a
  // filesystem root (`C:\`, `/`), `comparableFullPath` leaves it separator-terminated
  // (G-04), so `prefix` below equals `resolvedRoot` verbatim and a candidate equal to
  // that same root would otherwise satisfy `startsWith(prefix)` - contradicting the
  // "equality is never containment" contract documented above. Reject equality up
  // front so it holds for every root, filesystem-root or not.
  const rootsAreEqual =
    platform.name === "windows"
      ? resolvedCandidate.toLowerCase() === resolvedRoot.toLowerCase()
      : resolvedCandidate === resolvedRoot;
  if (rootsAreEqual) return false;
  const boundary = platform.name === "windows" ? "\\" : "/";
  // G-04: a root that is itself a filesystem root (`C:\`, `/`) is already
  // separator-terminated after `comparableFullPath` (which leaves roots alone
  // instead of collapsing them to a drive-relative path). Do not append a second
  // separator in that case, or the prefix ("C:\\", "//") would never match any real
  // path.
  //
  // Deliberate divergence from PowerShell: `Test-HdoPathWithinRoot` does exactly
  // that - it always appends `[System.IO.Path]::DirectorySeparatorChar` regardless of
  // whether `$fullRoot` already ends in one, so for a drive-root `$Root` (e.g.
  // `paths.artifactRoot` set to `C:\`) the required prefix becomes `C:\\`, which no
  // real Windows path can ever start with; `Test-HdoPathWithinRoot` therefore always
  // returns `$false` for that root, even for genuine descendants. This port fixes
  // that (returns `true` for genuine descendants of a drive root) rather than
  // reproducing the bug - see docs/architecture.md 16 "PowerShell 実装との意図的な差異".
  const prefix = resolvedRoot.endsWith(boundary) ? resolvedRoot : `${resolvedRoot}${boundary}`;
  if (platform.name === "windows") {
    return resolvedCandidate.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolvedCandidate.startsWith(prefix);
}
