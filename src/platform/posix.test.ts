// POSIX-only runtime checks for the phase 2 additions to `createPosixPlatformAdapter`
// (`resolveExecutable`/`killProcessTree`/`isReparsePointInPath`/`removeTree`/
// `createProcessContainer`). Not a CI gate (ADR-0001 Amendment 2026-09-05 makes
// Windows the first migration target - see docs/architecture.md 16.2), but kept so
// this module has real test coverage once a Linux/WSL2 CI job is added, and so the
// pure logic here is exercised at least once on any POSIX development machine.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createPosixPlatformAdapter } from "./posix.ts";

const IS_POSIX = process.platform !== "win32";
const SKIP_REASON = IS_POSIX ? false : "posix-only";

test("resolveExecutable finds a well-known executable on PATH", { skip: SKIP_REASON }, () => {
  const adapter = createPosixPlatformAdapter();
  const resolved = adapter.resolveExecutable("sh");
  assert.ok(resolved, "expected /bin/sh (or an equivalent) to resolve on any POSIX machine");
});

test("resolveExecutable returns undefined for a name that does not exist anywhere on PATH", { skip: SKIP_REASON }, () => {
  const adapter = createPosixPlatformAdapter();
  assert.equal(adapter.resolveExecutable("hdo-definitely-does-not-exist-anywhere"), undefined);
});

test("resolveExecutable does not resolve an executable-bit directory merely named like a command", { skip: SKIP_REASON }, (t) => {
  // N-8: `accessSync(path, X_OK)` alone is also true for a directory with its
  // executable ("traversal") bit set, which is not something `spawn()` can run -
  // `isExecutableFile` must additionally confirm the resolved target is a regular
  // file.
  const dir = mkdtempSync(join(tmpdir(), "hdo-resolveexe-dir-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bogusCommandDir = join(dir, "hdo-dir-only-command");
  mkdirSync(bogusCommandDir, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const adapter = createPosixPlatformAdapter();
  assert.equal(adapter.resolveExecutable("hdo-dir-only-command"), undefined);
});

test("killProcessTree terminates a detached process group", { skip: SKIP_REASON }, async () => {
  const adapter = createPosixPlatformAdapter();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore", detached: true });
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
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(alive, false, `expected pid ${pid} to be gone after killProcessTree`);
});

test("isReparsePointInPath: false for an ordinary nested directory with no symlink", { skip: SKIP_REASON }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-reparse-plain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const adapter = createPosixPlatformAdapter();
  assert.equal(adapter.isReparsePointInPath(nested, root), false);
});

test("isReparsePointInPath: true when an intermediate segment is a symlink", { skip: SKIP_REASON }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-reparse-symlink-"));
  const outsideTarget = mkdtempSync(join(tmpdir(), "hdo-reparse-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideTarget, { recursive: true, force: true });
  });
  mkdirSync(join(outsideTarget, "leaf"), { recursive: true });
  const linkPath = join(root, "link");
  symlinkSync(outsideTarget, linkPath);
  const adapter = createPosixPlatformAdapter();
  assert.equal(adapter.isReparsePointInPath(join(linkPath, "leaf"), root), true);
});

test("removeTree deletes a nested directory tree and is a no-op when the path does not exist", { skip: SKIP_REASON }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hdo-removetree-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "file.txt"), "content", "utf8");
  const adapter = createPosixPlatformAdapter();
  await adapter.removeTree(root);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(root), false);
  await adapter.removeTree(root);
});

test("createProcessContainer is a no-op container (attached: false, error: '')", { skip: SKIP_REASON }, async () => {
  const adapter = createPosixPlatformAdapter();
  const container = await adapter.createProcessContainer(process.pid);
  assert.equal(container.attached, false);
  assert.equal(container.error, "");
  container.terminate();
  container.dispose();
  container.dispose();
});
