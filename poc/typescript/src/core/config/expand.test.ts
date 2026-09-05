import { strict as assert } from "node:assert";
import { join, sep } from "node:path";
import { test } from "node:test";
import { expandPathTemplate, expandTokens, type EnvironmentTokenResolver } from "./expand.ts";

function resolverFor(vars: Record<string, string>, home: string): EnvironmentTokenResolver {
  return {
    resolveToken: (name) => vars[name] ?? `%${name}%`,
    homeDir: () => home,
  };
}

test("expandTokens substitutes %VAR% tokens", () => {
  const resolver = resolverFor({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test");
  assert.equal(expandTokens("%LOCALAPPDATA%\\hdo\\worktrees", resolver), "C:\\Users\\test\\AppData\\Local\\hdo\\worktrees");
});

test("expandTokens leaves an undefined token as the resolver's own fallback text", () => {
  const resolver = resolverFor({}, "/home/test");
  assert.equal(expandTokens("%UNDEFINED_VAR%/x", resolver), "%UNDEFINED_VAR%/x");
});

test("expandTokens expands a bare ~ and ~/ prefix", () => {
  const resolver = resolverFor({}, "/home/test");
  assert.equal(expandTokens("~", resolver), "/home/test");
  // node:path.join normalizes separators for the current platform, so on Windows the
  // POSIX-looking home dir "/home/test" comes back with backslashes throughout.
  assert.equal(expandTokens("~/hdo", resolver), join("/home/test", "hdo"));
});

test("expandPathTemplate roots a relative path under the repository path", () => {
  const resolver = resolverFor({}, "/home/test");
  const result = expandPathTemplate("relative/worktrees", "/repo", resolver);
  assert.equal(result, `${sep}repo${sep}relative${sep}worktrees`);
});

test("expandPathTemplate substitutes {repository} and leaves absolute paths rooted at the drive/root", () => {
  const resolver = resolverFor({}, "/home/test");
  const result = expandPathTemplate("{repository}/.hdo/worktrees", "/repo", resolver);
  assert.equal(result, `${sep}repo${sep}.hdo${sep}worktrees`);
});

test("expandPathTemplate falls back through the injected resolver for LOCALAPPDATA on POSIX", () => {
  // This is the behaviour required by AC-02: on POSIX, an undefined LOCALAPPDATA must
  // fall back to the XDG data dir instead of producing a literal "%LOCALAPPDATA%" path.
  // The platform adapter is responsible for the fallback decision; here we only prove
  // that whatever the adapter returns is what ends up in the final path.
  const resolver = resolverFor({ LOCALAPPDATA: "/home/test/.local/share" }, "/home/test");
  const result = expandPathTemplate("%LOCALAPPDATA%/hdo/worktrees", "/repo", resolver);
  assert.equal(result, `${sep}home${sep}test${sep}.local${sep}share${sep}hdo${sep}worktrees`);
  assert.ok(!result.includes("%"), "must not contain a literal, unexpanded token");
});
