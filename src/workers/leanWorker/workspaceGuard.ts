// Workspace path containment - port of `Test-PathInsideWorkspace` and `Resolve-WorkerPath`
// (workers/hdo-ollama-worker.ps1:127-174). This is ADR-0003 D3's security boundary: every
// tool that touches the filesystem resolves the model-supplied path through here first,
// and a model can never be talked into reading or writing anything outside the workspace
// or inside `.git`.
//
// Deliberately NOT built on `src/platform/paths.ts`'s `isPathWithinRoot` /
// `PlatformAdapter.isReparsePointInPath`, even though both exist and cover similar ground:
//
//   - `isPathWithinRoot` (via `comparableFullPath`) resolves symlinks in the *existing*
//     ancestor chain eagerly, as one step, before ever comparing prefixes. The PS oracle
//     does the opposite on purpose: `Test-PathInsideWorkspace` is a pure lexical
//     `GetFullPath` + prefix check with NO filesystem access, and the link-escape check is
//     a separate pass that walks the ancestor chain component by component afterwards.
//     Collapsing those two passes into one eager resolution would also collapse the two
//     distinct error messages the parity tests key on ("path escapes the workspace" vs.
//     "path resolves through a link that leaves the workspace") into one, and would
//     change behaviour for the (common) case where the target doesn't exist yet - eager
//     `realpath`-style resolution has no defined answer for a path that isn't there,
//     whereas the oracle's ancestor walk simply skips components that don't exist yet.
//   - `PlatformAdapter.isReparsePointInPath` answers "is ANY component between root and
//     child a reparse point at all", which is a stricter and different question than the
//     oracle's "does the reparse point's OWN target land outside the workspace" (a
//     symlink that points to a different location *inside* the workspace is fine per the
//     oracle, but would trip `isReparsePointInPath` regardless of where it points). It
//     also throws (via `lstatSync`) on a missing path component, which is exactly the
//     "target does not exist yet" case `write_file` needs to tolerate.
//
// So this module reimplements the oracle's own two-stage check directly against
// `node:fs`/`node:path`, rather than adapting either shared helper to a shape it wasn't
// built for.
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { lstatSync, readlinkSync } from "node:fs";

/**
 * Port of .NET's `Path.IsPathRooted` on Windows: true if the path starts with a directory
 * separator, or its second character is a volume separator (`:`) - which is true even for
 * a drive-*relative* path like `C:foo` (no separator after the colon). Node's own
 * `path.win32.isAbsolute` returns `false` for that case (it requires the separator too),
 * which would let a drive-relative escape slip past this check where the PS oracle
 * rejects it, so a dedicated check is used instead of `node:path`'s.
 */
function isPathRooted(rawPath: string): boolean {
  if (rawPath.length === 0) return false;
  const first = rawPath[0];
  if (first === "/" || first === "\\") return true;
  return rawPath.length > 1 && rawPath[1] === ":";
}

/**
 * Port of `Test-PathInsideWorkspace`: compares against the workspace plus a trailing
 * separator so a sibling directory whose name merely starts with the workspace name
 * (`C:\repo-old` vs. `C:\repo`) is not accepted. Always case-insensitive, matching the PS
 * oracle's unconditional `[StringComparison]::OrdinalIgnoreCase` (the oracle does not
 * branch on platform for this comparison, so neither does this port).
 */
export function isPathInsideWorkspace(fullPath: string, workspace: string): boolean {
  const prefix = workspace + sep;
  const lowerFull = fullPath.toLowerCase();
  return lowerFull === workspace.toLowerCase() || lowerFull.startsWith(prefix.toLowerCase());
}

function existsLoose(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the chain of symlinks/junctions starting AT `p` itself to its final target,
 * following the whole chain (`a` -> `b` -> `c` resolves to `c`), matching .NET's
 * `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)`. Returns `null` if `p` is
 * not itself a reparse point (mirroring `ResolveLinkTarget`'s `null` for an ordinary
 * file/directory) - deliberately does NOT use `fs.realpathSync`, which would also resolve
 * symlinks in `p`'s *ancestor* path components; the oracle's ancestor walk (see
 * `resolveWorkerPath` below) checks each ancestor for this independently, one at a time,
 * so resolving them again here would test something already covered by a different
 * iteration of that walk.
 *
 * Relies on `lstatSync().isSymbolicLink()` to detect a reparse point, same limitation as
 * `isReparsePoint` in src/platform/windows.ts (documented there as S-6(a)): this sees
 * ordinary symlinks and NTFS junctions, but not every reparse tag Windows defines (e.g. a
 * OneDrive/ProjFS placeholder), which PowerShell's `Attributes -band ReparsePoint` would
 * catch and this does not.
 */
function resolveLinkChainTarget(p: string): string | null {
  let current = p;
  let sawLink = false;
  const seen = new Set<string>();
  for (;;) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      // A broken final hop still counts as "resolved to somewhere" if we ever followed a
      // link to get here; an unreadable starting path (shouldn't happen - existsLoose
      // already confirmed it) is treated as "not a link".
      return sawLink ? current : null;
    }
    if (!isLink) return sawLink ? current : null;
    if (seen.has(current)) return current; // defensive: a link cycle, treat as resolved here.
    seen.add(current);
    sawLink = true;
    const target = readlinkSync(current);
    current = isAbsolute(target) ? target : resolve(dirname(current), target);
  }
}

/**
 * Resolves a model-supplied path and proves it stays inside the workspace - port of
 * `Resolve-WorkerPath`. Throws with the exact PS message text on every rejection path;
 * the parity test suite matches tool-result strings on these substrings verbatim.
 */
export function resolveWorkerPath(workspace: string, rawPath: string): string {
  if (rawPath === undefined || rawPath === null || rawPath.trim() === "") {
    throw new Error("path must not be empty");
  }
  if (isPathRooted(rawPath)) {
    throw new Error(`path must be workspace-relative: ${rawPath}`);
  }
  const full = resolve(workspace, rawPath);
  if (!isPathInsideWorkspace(full, workspace)) {
    throw new Error(`path escapes the workspace: ${rawPath}`);
  }

  // Git metadata is off limits even though it sits inside the workspace - see the long
  // rationale in the PS source (Runner script lines 148-156): HDO runs real git against
  // this worktree, so a writable .git turns a file edit into command execution.
  const relative = full === workspace ? "" : full.slice(workspace.length + 1);
  const firstSegment = relative.split(/[\\/]/).filter((segment) => segment.length > 0)[0];
  if (firstSegment !== undefined && firstSegment.toLowerCase() === ".git") {
    throw new Error(`path is inside git metadata and is not writable or readable by a worker: ${rawPath}`);
  }

  // GetFullPath is purely lexical, so a junction or symlink planted inside the workspace
  // still satisfies the prefix check above while pointing outside it. Every existing
  // component between the workspace and the target is inspected, not just the target
  // itself.
  let cursor = full;
  while (cursor.length > workspace.length) {
    if (existsLoose(cursor)) {
      const linkTarget = resolveLinkChainTarget(cursor);
      if (linkTarget !== null && !isPathInsideWorkspace(resolve(linkTarget), workspace)) {
        throw new Error(`path resolves through a link that leaves the workspace: ${rawPath}`);
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return full;
}
