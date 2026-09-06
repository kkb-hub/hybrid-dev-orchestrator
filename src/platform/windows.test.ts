// Windows-only: verifies `createWindowsPlatformAdapter().expandPath` expands an 8.3
// short name (`PROGRA~1`) found in the resolved path's EXISTING prefix the same way
// .NET `[System.IO.Path]::GetFullPath` does (`GetLongPathNameW`), and does nothing at
// all when the path contains no `~` (matching .NET's own fast path). See
// docs/architecture.md 16.4 item 9 and src/platform/windows.ts's
// `expandShortNamesInExistingPrefix` for the full writeup, including the documented
// approximation (`fs.realpathSync.native` also resolves reparse points, which
// `GetLongPathNameW` does not).
//
// Skipped entirely off Windows, and skipped if this machine has no `C:\PROGRA~1`
// short name to exercise (every ordinary Windows install does, but this guards
// against an unusual environment rather than failing loudly).
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { createWindowsPlatformAdapter } from "./windows.ts";

const IS_WINDOWS = process.platform === "win32";
const PROGRA_SHORT_NAME = "C:\\PROGRA~1";
const HAS_PROGRA_SHORT_NAME = IS_WINDOWS && existsSync(PROGRA_SHORT_NAME);
const SKIP_REASON = !IS_WINDOWS
  ? "windows-only"
  : !HAS_PROGRA_SHORT_NAME
    ? "C:\\PROGRA~1 does not exist on this machine"
    : false;

/** The oracle: spawns `pwsh` to compute the real `[IO.Path]::GetFullPath` result, when pwsh is available. */
function dotnetGetFullPath(input: string): string | undefined {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", `[IO.Path]::GetFullPath('${input}')`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return undefined;
  return probe.stdout.trim();
}

test("expandPath expands an 8.3 short name in the existing prefix like .NET GetFullPath", { skip: SKIP_REASON }, () => {
  const adapter = createWindowsPlatformAdapter();
  const input = "C:\\PROGRA~1\\hdo-does-not-exist\\x.json";
  // Hardcoded fallback matches this repo's verified `[IO.Path]::GetFullPath` output
  // for every ordinary Windows install (C:\PROGRA~1 always expands to
  // "C:\Program Files"); used only when pwsh itself is not on PATH.
  const expected = dotnetGetFullPath(input) ?? "C:\\Program Files\\hdo-does-not-exist\\x.json";
  const result = adapter.expandPath(input, undefined);
  assert.equal(result, expected);
});

test("expandPath leaves a path without '~' unchanged by the short-name post-step", { skip: SKIP_REASON }, () => {
  const adapter = createWindowsPlatformAdapter();
  const input = "C:\\Windows\\System32\\hdo-does-not-exist\\x.json";
  const result = adapter.expandPath(input, undefined);
  assert.equal(result, input);
});

// --- phase 2: resolveExecutable / killProcessTree / isReparsePointInPath / removeTree ---

test("resolveExecutable finds a well-known .exe on PATH", { skip: !IS_WINDOWS && "windows-only" }, () => {
  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("cmd");
  assert.ok(resolved, "expected cmd.exe to resolve on any Windows machine");
  assert.ok(resolved!.toLowerCase().endsWith("cmd.exe"));
  assert.ok(existsSync(resolved!));
});

test("resolveExecutable returns undefined for a name that does not exist anywhere on PATH", { skip: !IS_WINDOWS && "windows-only" }, () => {
  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.resolveExecutable("hdo-definitely-does-not-exist-anywhere"), undefined);
});

// --- phase 5 (WP-D): .cmd/.bat shim resolution, .ps1 exclusion (Issue #35) ---

test("resolveExecutable: an .exe beats a .cmd in the same directory (PATHEXT default order)", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-exevscmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hdo-foo.exe"), "not a real PE, existence is all that matters here", "utf8");
  writeFileSync(join(dir, "hdo-foo.cmd"), "@echo off\r\necho hi\r\n", "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("hdo-foo");
  assert.ok(resolved, "expected hdo-foo to resolve");
  assert.ok(resolved!.toLowerCase().endsWith("hdo-foo.exe"), `expected the .exe to win, got ${resolved}`);
});

test("resolveExecutable: P-1 returns the on-disk casing of a PATHEXT-resolved name, not PATHEXT's own casing", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  // PATHEXT candidates are built by appending PATHEXT's own entries (typically
  // uppercase, e.g. ".EXE") to the bare name - a naive implementation returns that
  // constructed casing verbatim, which diverges from `Get-Command`'s `.Source`
  // (real on-disk casing) and is now user-visible via `doctor`'s
  // `command:<name>`/`runner:<name>:shim` messages (arch 16.4-6 / review round 1
  // finding P-1).
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-casing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hdo-cased.exe"), "not a real PE, existence is all that matters here", "utf8");
  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";
  t.after(() => {
    process.env.PATH = previousPath;
    process.env.PATHEXT = previousPathExt;
  });

  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("hdo-cased");
  assert.ok(resolved, "expected hdo-cased to resolve");
  assert.ok(resolved!.endsWith("hdo-cased.exe"), `expected the on-disk (lowercase) casing, got ${resolved}`);
  assert.ok(!resolved!.endsWith("hdo-cased.EXE"), `expected NOT to see PATHEXT's own casing, got ${resolved}`);
});

test("resolveExecutable: the pwsh App Execution Alias still resolves after the on-disk-casing lookup (P-1)", { skip: !IS_WINDOWS && "windows-only" }, () => {
  // readdirSync (used by the on-disk-casing fix above) must not disturb App
  // Execution Alias resolution, which depends on lstatSync/statSync tolerance, not
  // on directory listing - verified against this development machine's real `pwsh`
  // alias (see the module's `candidateExists`/`isFileLike` doc comments).
  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("pwsh");
  if (!resolved) {
    // Not every machine has pwsh on PATH; this test only pins the interaction with
    // the casing fix when it IS present.
    return;
  }
  assert.ok(resolved.toLowerCase().endsWith("pwsh.exe"));
  assert.ok(existsSync(resolved) || lstatSync(resolved).isSymbolicLink());
});

test("resolveExecutable: a .cmd beats a .ps1 with the same base name (only Application-type commands resolve, Issue #35)", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-cmdvsps1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hdo-bar.cmd"), "@echo off\r\necho hi\r\n", "utf8");
  writeFileSync(join(dir, "hdo-bar.ps1"), "Write-Output 'hi'\r\n", "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("hdo-bar");
  assert.ok(resolved, "expected hdo-bar to resolve");
  assert.ok(resolved!.toLowerCase().endsWith("hdo-bar.cmd"), `expected the .cmd to win over the .ps1, got ${resolved}`);
});

test("resolveExecutable: a .ps1-only command is undefined (never resolved by either implementation)", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-ps1only-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hdo-baz.ps1"), "Write-Output 'hi'\r\n", "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.resolveExecutable("hdo-baz"), undefined);
});

test("resolveExecutable: a qualified path ending in .cmd is resolved", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-qualifiedcmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cmdPath = join(dir, "hdo-qualified.cmd");
  writeFileSync(cmdPath, "@echo off\r\necho hi\r\n", "utf8");

  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable(cmdPath);
  assert.ok(resolved, "expected a qualified .cmd path to resolve");
  assert.ok(resolved!.toLowerCase().endsWith("hdo-qualified.cmd"));
});

test("resolveExecutable: a qualified path ending in .ps1 is undefined", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-qualifiedps1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ps1Path = join(dir, "hdo-qualified.ps1");
  writeFileSync(ps1Path, "Write-Output 'hi'\r\n", "utf8");

  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.resolveExecutable(ps1Path), undefined);
});

test("killProcessTree terminates a running process by PID", { skip: !IS_WINDOWS && "windows-only" }, async () => {
  const adapter = createWindowsPlatformAdapter();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolvePromise) => {
    if (typeof child.pid === "number") resolvePromise();
    else child.once("spawn", () => resolvePromise());
  });
  const pid = child.pid!;
  await adapter.killProcessTree(pid);
  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" });
      // CSV row: "image","PID","session name","session#","mem usage" - match the PID column exactly.
      alive = output.split(/\r?\n/).some((line) => line.split('","')[1] === String(pid));
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(alive, false, `expected pid ${pid} to be gone after killProcessTree`);
});

test("isReparsePointInPath: false for an ordinary nested directory with no reparse point", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-reparse-plain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.isReparsePointInPath(nested, root), false);
});

test("isReparsePointInPath: true when an intermediate segment is a directory junction", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-reparse-junction-"));
  const outsideTarget = mkdtempSync(join(tmpdir(), "hdo-reparse-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideTarget, { recursive: true, force: true });
  });
  mkdirSync(join(outsideTarget, "leaf"), { recursive: true });
  const junctionPath = join(root, "junction");
  // Directory junctions do not require elevated privilege on Windows, unlike
  // symbolic links - safe to create in an unprivileged CI runner.
  symlinkSync(outsideTarget, junctionPath, "junction");
  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.isReparsePointInPath(join(junctionPath, "leaf"), root), true);
});

test("removeTree deletes a nested directory tree and is a no-op when the path does not exist", { skip: !IS_WINDOWS && "windows-only" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hdo-removetree-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "file.txt"), "content", "utf8");
  const adapter = createWindowsPlatformAdapter();
  await adapter.removeTree(root);
  assert.equal(existsSync(root), false);
  // No-op / does not throw when the path is already gone.
  await adapter.removeTree(root);
});

test("resolveExecutable tries PATHEXT candidates for a name whose trailing dot-suffix is not itself a PATHEXT extension", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  // N-8: `python3.12` looks like it already has an "extension" (`.12`), but `.12` is
  // not one of PATHEXT's recognized extensions, so `Get-Command`-equivalent
  // resolution must still try `python3.12.exe` etc., not treat the name as already
  // extension-qualified and give up.
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-dotted-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hdo-dotted3.12.exe"), "not a real PE, existence is all that matters here", "utf8");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createWindowsPlatformAdapter();
  const resolved = adapter.resolveExecutable("hdo-dotted3.12");
  assert.ok(resolved, "expected hdo-dotted3.12.exe to resolve even though the bare name ends in '.12'");
  assert.ok(resolved!.toLowerCase().endsWith("hdo-dotted3.12.exe"));
});

test("resolveExecutable does not resolve a directory junction merely named like an .exe", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  // N-8: a reparse-point candidate must actually RESOLVE to a regular file -
  // `lstatSync().isSymbolicLink()` alone is also true for a directory junction, which
  // `spawn()` cannot run. Directory junctions do not require elevated privilege on
  // Windows, unlike symbolic links, so this is safe in an unprivileged CI runner.
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-dirjunction-"));
  const targetDir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-dirjunction-target-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  });
  const junctionPath = join(dir, "hdo-junction-only.exe");
  symlinkSync(targetDir, junctionPath, "junction");
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createWindowsPlatformAdapter();
  assert.equal(adapter.resolveExecutable("hdo-junction-only"), undefined);
});

test("isReparsePointInPath throws for a missing path segment (mirrors PS's Get-Item -ErrorAction Stop)", { skip: !IS_WINDOWS && "windows-only" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-reparse-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missingChild = join(root, "does-not-exist", "leaf");
  const adapter = createWindowsPlatformAdapter();
  assert.throws(() => adapter.isReparsePointInPath(missingChild, root));
});

test("isReparsePointInPath returns true for a child outside a NONEXISTENT root without throwing", { skip: !IS_WINDOWS && "windows-only" }, () => {
  // The path-containment check runs before any filesystem access, matching PS's own
  // check order - an unrelated child must not require the root to even exist.
  const adapter = createWindowsPlatformAdapter();
  const missingRoot = join(tmpdir(), "hdo-reparse-root-does-not-exist-" + Date.now());
  const unrelatedChild = join(tmpdir(), "hdo-reparse-unrelated-child-" + Date.now());
  assert.equal(adapter.isReparsePointInPath(unrelatedChild, missingRoot), true);
});

test("createProcessContainer attaches around a real spawned process and dispose() is idempotent", { skip: !IS_WINDOWS && "windows-only" }, async () => {
  const adapter = createWindowsPlatformAdapter();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolvePromise) => {
    if (typeof child.pid === "number") resolvePromise();
    else child.once("spawn", () => resolvePromise());
  });
  const container = await adapter.createProcessContainer(child.pid!);
  try {
    assert.equal(container.attached, true, `expected containment to attach; error was: ${container.error}`);
    assert.equal(container.error, "");
  } finally {
    container.dispose();
    container.dispose(); // idempotent
  }
  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      const output = execFileSync("tasklist", ["/FI", `PID eq ${child.pid}`, "/NH"], { encoding: "utf8" });
      alive = output.includes(String(child.pid));
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(alive, false, "dispose() should have killed the contained process (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)");
});
