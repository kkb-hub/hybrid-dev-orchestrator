// Note on expected values: the final step of `expandPath` is `path.resolve()`, which
// on Windows roots a path like "/repo/x" at the CURRENT drive (e.g. "C:\repo\x"), not
// at a bare "\repo\x". Every expectation below is therefore computed with `resolve()`
// itself rather than a hand-written string, so these tests assert the same
// normalization `expandPath` performs without hardcoding a drive letter.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";
import { expandPath, type EnvironmentTokenResolver } from "./expand.ts";

function resolverFor(
  vars: Record<string, string>,
  options: { defaultData?: string; userConfig?: string; cwd?: string } = {},
): EnvironmentTokenResolver {
  return {
    getEnv: (name) => vars[name],
    defaultDataDir: () => options.defaultData ?? "/fallback/data",
    userConfigDir: () => options.userConfig ?? "/fallback/config",
    cwd: () => options.cwd ?? "/cwd",
  };
}

test("expandPath substitutes a %VAR% token that is set in the environment", () => {
  const resolver = resolverFor({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
  const result = expandPath("%LOCALAPPDATA%\\hdo\\worktrees", "C:\\repo", resolver);
  assert.equal(result, resolve("C:\\Users\\test\\AppData\\Local\\hdo\\worktrees"));
});

test("expandPath falls back to the platform default data dir when %LOCALAPPDATA% is unset", () => {
  const resolver = resolverFor({}, { defaultData: "/home/test/.local/share" });
  const result = expandPath("%LOCALAPPDATA%/hdo/worktrees", "/repo", resolver);
  assert.equal(result, resolve("/home/test/.local/share/hdo/worktrees"));
  assert.ok(!result.includes("%"), "must not contain a literal, unexpanded token");
});

test("expandPath falls back to the platform default user config dir when %APPDATA% is unset", () => {
  const resolver = resolverFor({}, { userConfig: "/home/test/.config" });
  const result = expandPath("%APPDATA%/hdo/config.json", "/repo", resolver);
  assert.equal(result, resolve("/home/test/.config/hdo/config.json"));
});

test("expandPath does NOT fall back to the platform default when the env var IS set", () => {
  const resolver = resolverFor(
    { LOCALAPPDATA: "/actual/env/value" },
    { defaultData: "/should/not/be/used" },
  );
  const result = expandPath("%LOCALAPPDATA%/hdo", "/repo", resolver);
  assert.equal(result, resolve("/actual/env/value/hdo"));
});

test("expandPath throws the same message PowerShell uses when neither the env var nor a platform default is available", () => {
  const resolver: EnvironmentTokenResolver = {
    getEnv: () => undefined,
    defaultDataDir: () => "",
    userConfigDir: () => "",
    cwd: () => "/cwd",
  };
  assert.throws(
    () => expandPath("%LOCALAPPDATA%/hdo", "/repo", resolver),
    /Path '%LOCALAPPDATA%\/hdo' references %LOCALAPPDATA% but neither the environment variable nor a platform default directory is available\./,
  );
  assert.throws(
    () => expandPath("%APPDATA%/hdo", "/repo", resolver),
    /Path '%APPDATA%\/hdo' references %APPDATA% but neither the environment variable nor a platform default directory is available\./,
  );
});

test("expandPath leaves an unknown %FOO% token literally in place instead of throwing", () => {
  const resolver = resolverFor({});
  const result = expandPath("%UNKNOWN_VAR%/hdo/worktrees", "/repo", resolver);
  assert.equal(result, resolve("/repo/%UNKNOWN_VAR%/hdo/worktrees"));
});

test("expandPath expands a generic %VAR% that IS set via the injected resolver", () => {
  const resolver = resolverFor({ MY_VAR: "custom-value" });
  const result = expandPath("%MY_VAR%/hdo", "/repo", resolver);
  assert.equal(result, resolve("/repo/custom-value/hdo"));
});

test("expandPath substitutes the literal {repository} placeholder", () => {
  const resolver = resolverFor({});
  const result = expandPath("{repository}/.hdo/worktrees", "/repo", resolver);
  assert.equal(result, resolve("/repo/.hdo/worktrees"));
});

test("expandPath roots a relative path under repositoryPath", () => {
  const resolver = resolverFor({});
  const result = expandPath("relative/worktrees", "/repo", resolver);
  assert.equal(result, resolve("/repo/relative/worktrees"));
});

test("expandPath roots a relative path under the resolver's cwd when no repositoryPath is given", () => {
  const resolver = resolverFor({}, { cwd: "/cwd" });
  const result = expandPath("relative/worktrees", undefined, resolver);
  assert.equal(result, resolve("/cwd/relative/worktrees"));
});

test("expandPath leaves an already-absolute path rooted at its own drive/root", () => {
  const resolver = resolverFor({});
  const result = expandPath("/already/absolute", "/repo", resolver);
  assert.equal(result, resolve("/already/absolute"));
});
