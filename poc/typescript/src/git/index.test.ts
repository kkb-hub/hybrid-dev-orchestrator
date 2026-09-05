import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPlatform } from "../platform/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { GitClient, comparableFullPath, isPathWithinRoot } from "./index.ts";

const platform = getPlatform();
const runner = new NodeProcessRunner({ platform });
const git = new GitClient({ runner, platform });

async function run(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const result = await runner.run({ command, args, cwd, timeoutSeconds: 30 });
  return { exitCode: result.exitCode, stdout: result.stdout };
}

test("worktree add/list/remove and untracked file detection", async (t) => {
  const gitPath = platform.resolveExecutable(process.platform === "win32" ? "git.exe" : "git");
  if (!gitPath) {
    t.skip("git was not found on PATH in this environment");
    return;
  }

  const repoDir = mkdtempSync(join(tmpdir(), "hdo-poc-git-repo-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "hdo-poc-git-worktree-"));
  let worktreePath: string | undefined;

  t.after(() => {
    if (worktreePath) {
      try {
        execRemoveSync(gitPath, repoDir, worktreePath);
      } catch {
        // best-effort cleanup
      }
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  });

  await run(gitPath, ["init", "--initial-branch=main"], repoDir);
  await run(gitPath, ["config", "user.email", "hdo-poc@example.invalid"], repoDir);
  await run(gitPath, ["config", "user.name", "HDO PoC"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "hdo poc fixture\n", "utf8");
  await run(gitPath, ["add", "README.md"], repoDir);
  await run(gitPath, ["commit", "-m", "initial commit"], repoDir);

  const baseCommit = await git.revParseHead(repoDir);
  assert.match(baseCommit, /^[0-9a-f]{40}$/);

  worktreePath = join(worktreeRoot, "wt-1");
  await git.worktreeAdd(repoDir, worktreePath, "hdo-poc/test-branch", baseCommit);

  const worktrees = await git.worktreeList(repoDir);
  assert.ok(
    worktrees.some((entry) => git.worktreePathEquals(entry.path, worktreePath!)),
    `expected 'git worktree list' to include ${worktreePath}, got: ${JSON.stringify(worktrees)}`,
  );

  const contained = await git.isContainedWorktree(repoDir, worktreePath, worktreeRoot);
  assert.equal(contained, true);

  writeFileSync(join(worktreePath, "untracked.txt"), "not yet added\n", "utf8");
  const others = await git.lsFilesOthers(worktreePath);
  assert.ok(others.includes("untracked.txt"), `expected untracked.txt among ${JSON.stringify(others)}`);

  await git.worktreeRemove(repoDir, worktreePath, true);
  const worktreesAfterRemoval = await git.worktreeList(repoDir);
  assert.ok(!worktreesAfterRemoval.some((entry) => git.worktreePathEquals(entry.path, worktreePath!)));
  worktreePath = undefined;
});

async function execRemoveSync(gitPath: string, repoDir: string, worktreePath: string): Promise<void> {
  await runner.run({ command: gitPath, args: ["worktree", "remove", "--force", worktreePath], cwd: repoDir, timeoutSeconds: 30 });
}

// F-03: isPathWithinRoot must resolve `..` (and, where possible, symlinks) before
// doing its containment check, instead of comparing raw, possibly-nonexistent path
// strings. See src/git/index.ts `isPathWithinRoot`/`comparableFullPath` for the fix.
test("isPathWithinRoot: '..' traversal above root is rejected even when the target does not exist", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // <root>/a/../../evil algebraically collapses to <root's parent>/evil - outside root.
  const traversal = join(root, "a", "..", "..", "evil");
  assert.equal(isPathWithinRoot(platform, traversal, root), false);
});

test("isPathWithinRoot: a '..' segment that stays inside root is accepted", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "inside"), { recursive: true });
  const candidate = join(root, "sub", "..", "inside");
  assert.equal(isPathWithinRoot(platform, candidate, root), true);
});

test("isPathWithinRoot: a sibling directory that merely shares root as a string prefix is rejected", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suffixSibling = `${root}-suffix`;
  const candidate = join(suffixSibling, "x");
  assert.equal(isPathWithinRoot(platform, candidate, root), false);
});

test("isPathWithinRoot: a candidate equal to root itself is rejected (matches Test-HdoPathWithinRoot's StartsWith(root + separator))", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(isPathWithinRoot(platform, root, root), false);
});

test("isPathWithinRoot: a non-existent nested candidate under an existing root is accepted", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "does-not-exist-yet", "deeper", "still");
  assert.equal(isPathWithinRoot(platform, candidate, root), true);
});

test("isPathWithinRoot: a symlinked root resolves consistently with its target", (t) => {
  const base = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-symlink-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, "target");
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, "child"), { recursive: true });
  const rootAlias = join(base, "alias");
  try {
    symlinkSync(target, rootAlias, "dir");
  } catch (error) {
    t.skip(`symlink creation failed (likely requires Developer Mode/elevation on this machine): ${(error as Error).message}`);
    return;
  }
  // Whether the caller names the root by its symlink alias or by its real target, a
  // candidate reached through the alias must be reported as contained either way.
  const candidateViaAlias = join(rootAlias, "child");
  assert.equal(isPathWithinRoot(platform, candidateViaAlias, rootAlias), true);
  assert.equal(isPathWithinRoot(platform, candidateViaAlias, target), true);
});

// G-04: `normalizeNoTrailingSep` used to turn `C:\` into the drive-*relative* path
// `C:`, which Node then resolves against `process.cwd()`'s current drive instead of
// the actual drive root - silently widening containment checks that pass `C:\` (or
// any other filesystem root) as `root`. These cases are Windows-only because they
// specifically exercise drive-letter root handling.
test("comparableFullPath: a drive root is left as 'C:\\', not collapsed to drive-relative 'C:'", (t) => {
  if (process.platform !== "win32") {
    t.skip("drive-letter root handling is Windows-only");
    return;
  }
  assert.equal(comparableFullPath(platform, "C:\\"), "C:\\");
});

test("isPathWithinRoot: 'C:\\' itself is never within an unrelated root", (t) => {
  if (process.platform !== "win32") {
    t.skip("drive-letter root handling is Windows-only");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "hdo-poc-within-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(isPathWithinRoot(platform, "C:\\", root), false);
});

test("isPathWithinRoot: a real path under the drive root is within root 'C:\\'", (t) => {
  if (process.platform !== "win32") {
    t.skip("drive-letter root handling is Windows-only");
    return;
  }
  assert.equal(isPathWithinRoot(platform, "C:\\Windows", "C:\\"), true);
});

// POSIX equivalents of the two cases above: `/` as `root` must behave the same way
// (accepting real descendants, never accepting itself as a descendant of anything).
test("isPathWithinRoot (POSIX): '/' itself is never within an unrelated root", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX root handling does not apply on Windows");
    return;
  }
  assert.equal(isPathWithinRoot(platform, "/", "/tmp"), false);
});

test("isPathWithinRoot (POSIX): a real path under '/' is within root '/'", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX root handling does not apply on Windows");
    return;
  }
  assert.equal(isPathWithinRoot(platform, "/tmp/x", "/"), true);
});

// H-03: a filesystem root compared against itself used to slip through - unlike an
// ordinary root, `comparableFullPath` leaves a filesystem root separator-terminated
// (G-04), so the candidate-equals-root case was not caught by the plain `startsWith`
// prefix check. See `isPathWithinRoot` in git/index.ts for the fix.
test("isPathWithinRoot: 'C:\\' is not within root 'C:\\' (filesystem root compared to itself)", (t) => {
  if (process.platform !== "win32") {
    t.skip("drive-letter root handling is Windows-only");
    return;
  }
  assert.equal(isPathWithinRoot(platform, "C:\\", "C:\\"), false);
});

test("isPathWithinRoot (POSIX): '/' is not within root '/' (filesystem root compared to itself)", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX root handling does not apply on Windows");
    return;
  }
  assert.equal(isPathWithinRoot(platform, "/", "/"), false);
});
