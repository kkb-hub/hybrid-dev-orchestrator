// Pure `%VAR%` / `~` path template expansion. Mirrors `Expand-HdoPath` in Common.ps1
// but with the environment lookup and home directory injected so this file never
// touches `node:os`/`node:fs`/`node:child_process` and can run under the core
// boundary test. The platform adapter decides *what* a token resolves to (including
// the POSIX XDG fallback for `%LOCALAPPDATA%`); this module only performs the
// textual substitution and repository-relative rooting.
import { isAbsolute, join, normalize } from "node:path";

export interface EnvironmentTokenResolver {
  /** Resolve a single `%NAME%` token (without percent signs) to a replacement string. */
  resolveToken(name: string): string;
  /** Absolute path to substitute for a leading `~`. */
  homeDir(): string;
}

const TOKEN_PATTERN = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

export function expandTokens(rawPath: string, resolver: EnvironmentTokenResolver): string {
  let expanded = rawPath.replace(TOKEN_PATTERN, (_match, name: string) => resolver.resolveToken(name));
  if (expanded === "~") {
    expanded = resolver.homeDir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(resolver.homeDir(), expanded.slice(2));
  }
  return expanded;
}

/**
 * Expands `%VAR%`/`~` tokens, substitutes the literal `{repository}` placeholder, and
 * roots the result under `repositoryPath` when it is not already absolute. Equivalent
 * to `Expand-HdoPath` (minus the final `GetFullPath` normalization, which is left to
 * the caller since "final path resolution" on a possibly-nonexistent path is a
 * platform concern on Windows with reparse points/8.3 aliases).
 */
export function expandPathTemplate(
  rawPath: string,
  repositoryPath: string,
  resolver: EnvironmentTokenResolver,
): string {
  let expanded = expandTokens(rawPath, resolver);
  expanded = expanded.split("{repository}").join(repositoryPath);
  if (!isAbsolute(expanded)) {
    expanded = join(repositoryPath, expanded);
  }
  return normalize(expanded);
}
