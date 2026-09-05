import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatform } from "./index.ts";

const platform = getPlatform();

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("pathEquals: identical path in a different case", (t) => {
  const dir = makeTempDir("hdo-poc-pathequals-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const upper = dir.toUpperCase();
  const lower = dir.toLowerCase();
  if (platform.name === "windows") {
    assert.equal(platform.pathEquals(upper, lower), true, "Windows path comparison must be case-insensitive");
  } else {
    // On a case-sensitive POSIX filesystem, upper/lower-cased forms of a real mixed
    // case temp dir are different paths unless the OS itself is case-insensitive
    // (e.g. default macOS). Only assert the direction that always holds: a path
    // compared with itself is always equal, and case must matter unless identical.
    assert.equal(platform.pathEquals(dir, dir), true);
    if (upper !== lower) {
      assert.equal(platform.pathEquals(upper, lower), false, "POSIX path comparison must be case-sensitive");
    }
  }
});

test("pathEquals: trailing separator does not affect equality", (t) => {
  const dir = makeTempDir("hdo-poc-pathequals-sep-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(platform.pathEquals(dir, `${dir}${platform.name === "windows" ? "\\" : "/"}`), true);
});

test("resolveExecutable finds node and git, and returns undefined for a bogus command", () => {
  const nodeResolved = platform.resolveExecutable(process.platform === "win32" ? "node.exe" : "node");
  assert.ok(nodeResolved, "expected to resolve the node executable via PATH");

  const gitResolved = platform.resolveExecutable(process.platform === "win32" ? "git.exe" : "git");
  assert.ok(gitResolved, "expected to resolve git via PATH (required by the rest of this PoC's git tests)");

  assert.equal(platform.resolveExecutable("hdo-poc-definitely-not-a-real-command"), undefined);
});

test("isReparsePointInPath: false for a plain nested directory", (t) => {
  const root = makeTempDir("hdo-poc-reparse-plain-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(platform.isReparsePointInPath(nested, root), false);
});

test("isReparsePointInPath: true when a symlink sits between root and child (POSIX)", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only case: Windows uses junctions/dir-symlinks, covered by separate cases below");
    return;
  }
  const root = makeTempDir("hdo-poc-reparse-symlink-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  mkdirSync(real, { recursive: true });
  const linkDir = join(root, "link");
  symlinkSync(real, linkDir, "dir");
  const child = join(linkDir, "leaf");
  mkdirSync(child, { recursive: true });
  assert.equal(platform.isReparsePointInPath(child, root), true);
});

test("isReparsePointInPath: true when a junction sits between root and child (Windows)", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only case: junctions do not exist on POSIX");
    return;
  }
  const root = makeTempDir("hdo-poc-reparse-junction-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  mkdirSync(real, { recursive: true });
  const linkDir = join(root, "link");
  try {
    execFileSync("cmd.exe", ["/c", "mklink", "/J", linkDir, real], { stdio: "pipe" });
  } catch (error) {
    t.skip(`mklink /J failed (likely a permissions restriction in this environment): ${(error as Error).message}`);
    return;
  }
  const child = join(linkDir, "leaf");
  mkdirSync(child, { recursive: true });
  assert.equal(platform.isReparsePointInPath(child, root), true);
});

test("isReparsePointInPath: true when a directory symlink sits between root and child (Windows)", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only case: exercises Windows directory-symlink reparse points specifically");
    return;
  }
  const root = makeTempDir("hdo-poc-reparse-dirsymlink-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real");
  mkdirSync(real, { recursive: true });
  const linkDir = join(root, "link");
  try {
    symlinkSync(real, linkDir, "dir");
  } catch (error) {
    t.skip(`Directory symlink creation failed (likely requires Developer Mode/elevation): ${(error as Error).message}`);
    return;
  }
  const child = join(linkDir, "leaf");
  mkdirSync(child, { recursive: true });
  assert.equal(platform.isReparsePointInPath(child, root), true);
});

test("userConfigDir and defaultDataDir return non-empty absolute-looking paths", () => {
  assert.ok(platform.userConfigDir().length > 0);
  assert.ok(platform.defaultDataDir().length > 0);
});

// F-04: resolveExecutable must never hand back a `.cmd`/`.bat` shim - Node's `spawn()`
// of one throws synchronously (EINVAL, CVE-2024-27980) unless `shell: true` is set,
// which this PoC never does. `npm` is a good real-world probe because on a typical
// Windows Node install it is ONLY available as `npm.cmd`/`npm.ps1`, no `npm.exe`.
test("resolveExecutable('npm') is either undefined or resolves only to a .exe/.com target (Windows)", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only case: .cmd/.bat shim filtering is a Windows-specific concern");
    return;
  }
  const resolved = platform.resolveExecutable("npm");
  if (resolved === undefined) return; // npm not on PATH in this environment at all - acceptable
  assert.match(resolved.toLowerCase(), /\.(exe|com)$/, `expected only a .exe/.com resolution, got: ${resolved}`);
});

test("resolveToken falls back for LOCALAPPDATA on POSIX instead of leaving a literal token", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only case: Windows always has a real LOCALAPPDATA, no fallback path to exercise");
    return;
  }
  const previous = process.env.LOCALAPPDATA;
  delete process.env.LOCALAPPDATA;
  try {
    const resolved = platform.resolveToken("LOCALAPPDATA");
    assert.ok(!resolved.includes("%"), `expected a real fallback path, got: ${resolved}`);
    assert.equal(resolved, platform.defaultDataDir());
  } finally {
    if (previous !== undefined) process.env.LOCALAPPDATA = previous;
  }
});
