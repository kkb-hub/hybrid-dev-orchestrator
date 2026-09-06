// GitClient tests against REAL temporary git repositories (no mocking of `git`
// itself) - phase 2 additions (ProcessRunner-backed exec, worktreeAdd/List/Remove/
// Prune, `-c core.longpaths=true` on Windows).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { formatProcessFailure, GitClient, sha256Hex } from "./index.ts";

const platform = getPlatform();
const runner = new NodeProcessRunner({ platform });

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-gitclient-test-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  return dir;
}

function commitAll(dir: string, message: string): void {
  runGit(["add", "-A"], dir);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], dir);
}

function removeRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function newGitClient(overrides: Partial<{ runner: ProcessRunner; platform: PlatformAdapter }> = {}): GitClient {
  return new GitClient({ runner: overrides.runner ?? runner, platform: overrides.platform ?? platform });
}

/**
 * Compares a path reported by `git worktree list --porcelain` (which may use
 * forward slashes, or an 8.3 short name for a component under `%TEMP%` on Windows)
 * with a caller-supplied path, the same way `Get-HdoComparableFullPath` does.
 */
function worktreePathsEqual(gitReportedPath: string, candidate: string): boolean {
  return platform.pathEquals(platform.comparableFullPath(gitReportedPath), platform.comparableFullPath(candidate));
}

/**
 * S-10: this machine's own `~/.gitconfig` sets `core.longpaths=true`, which would
 * make the long-path regression tests below pass vacuously (git would succeed even
 * without `exec`'s own `-c core.longpaths=true`, and even with it present against a
 * `false`-setting global config, since a *later* value in the SAME file layer wins -
 * but a machine with no such override at all must not be silently masked by this
 * one). For the duration of `fn`, replaces `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`
 * so every `git` invocation this process makes (both the test's own `execFileSync`
 * helpers and anything `GitClient` spawns) reads exactly `globalConfigContents`
 * (empty string = no overrides at all) as its global config, with the system config
 * skipped entirely - then restores whatever was there before (deleting the vars
 * again if they were unset, never assigning `""`).
 */
async function withIsolatedGitConfig<T>(globalConfigContents: string, fn: () => Promise<T>): Promise<T> {
  const configDir = mkdtempSync(join(tmpdir(), "hdo-gitclient-isolated-config-"));
  const configPath = join(configDir, "gitconfig");
  writeFileSync(configPath, globalConfigContents, "utf8");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    return await fn();
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    rmSync(configDir, { recursive: true, force: true });
  }
}

/**
 * Wraps `realRunner` so `git worktree remove` always reports a simulated failure
 * without ever invoking real git, and `git worktree list --porcelain` has
 * `targetPath`'s `worktree <path>` line stripped out of the real result - simulating
 * the actual Issue #25 failure shape (git deletes its own admin entry, gitfile and
 * tracked files before hitting "Filename too long", so `worktree list` no longer
 * shows the entry even though `worktree remove` itself reported non-zero) without
 * needing a real >260-character path in every test that exercises the fallback.
 * Every other invocation (including `worktree prune`) passes straight through.
 */
// Simulates git's issue-#25 failure shape: `worktree remove` fails, and ONLY FROM THEN
// ON the target disappears from `worktree list` (git deletes its admin entry before it
// hits the undeletable path). Before the remove, the target is listed normally, so the
// NB-1 pre-check in worktreeRemove passes.
function makeFailingRemoveRunner(realRunner: ProcessRunner, targetPath: string, simulatedStderr: string): ProcessRunner {
  let removeAttempted = false;
  return {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args.includes("remove")) {
        removeAttempted = true;
        return {
          command: options.command,
          arguments: args,
          exitCode: 1,
          timedOut: false,
          outputLimitExceeded: false,
          outputLimitStream: "",
          outputDrainTimedOut: false,
          maximumOutputBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutPath: "",
          stderrPath: "",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          stdout: "",
          stderr: simulatedStderr,
        };
      }
      const real = await realRunner.run(options);
      if (removeAttempted && args.includes("list")) {
        const filteredStdout = real.stdout
          .split(/\r?\n/)
          .filter((line) => !(line.startsWith("worktree ") && worktreePathsEqual(line.slice("worktree ".length), targetPath)))
          .join("\n");
        return { ...real, stdout: filteredStdout };
      }
      return real;
    },
  };
}

test("exec never rejects and reports a non-zero exit code with stderr for an invalid git subcommand", async () => {
  const dir = initRepo();
  try {
    const git = newGitClient();
    const result = await git.exec(["definitely-not-a-real-git-subcommand"], dir);
    assert.notEqual(result.exitCode, 0);
  } finally {
    removeRepo(dir);
  }
});

test("revParseVerify: exitCode 0 for HEAD after a commit, non-zero before any commit", async () => {
  const dir = initRepo();
  try {
    const git = newGitClient();
    const before = await git.revParseVerify(dir, "HEAD^{commit}");
    assert.notEqual(before.exitCode, 0);
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const after = await git.revParseVerify(dir, "HEAD^{commit}");
    assert.equal(after.exitCode, 0);
    assert.match(after.stdout.trim(), /^[0-9a-f]{40}$/);
  } finally {
    removeRepo(dir);
  }
});

test("show: returns committed blob content", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "hello world", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const result = await git.show(dir, "HEAD:a.txt");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello world");
  } finally {
    removeRepo(dir);
  }
});

test("repositoryRoot: resolves the toplevel path and throws formatProcessFailure text for a non-git directory", async () => {
  const dir = initRepo();
  try {
    const git = newGitClient();
    const root = await git.repositoryRoot(dir);
    assert.ok(existsSync(root));
  } finally {
    removeRepo(dir);
  }

  const notGit = mkdtempSync(join(tmpdir(), "hdo-gitclient-notgit-"));
  try {
    const git = newGitClient();
    await assert.rejects(
      () => git.repositoryRoot(notGit),
      (error: unknown) => error instanceof Error && error.message.startsWith("Command 'git' failed with exit code"),
    );
  } finally {
    removeRepo(notGit);
  }
});

test("worktreeAdd + worktreeList + worktreeRemove: full lifecycle on a real repository", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

    const resolvedWorktreePath = join(tmpdir(), `hdo-gitclient-wt-${Date.now()}`);
    await git.worktreeAdd(dir, { branch: "hdo/test-worktree", worktreePath: resolvedWorktreePath, baseCommit: head });
    try {
      assert.ok(existsSync(resolvedWorktreePath));

      const listed = await git.worktreeList(dir);
      assert.ok(
        listed.some((p) => worktreePathsEqual(p, resolvedWorktreePath)),
        `expected worktreeList to include ${resolvedWorktreePath}, got: ${JSON.stringify(listed)}`,
      );

      await git.worktreeRemove(dir, resolvedWorktreePath, { force: true });
      assert.equal(existsSync(resolvedWorktreePath), false);

      const listedAfter = await git.worktreeList(dir);
      assert.ok(!listedAfter.some((p) => worktreePathsEqual(p, resolvedWorktreePath)));
    } finally {
      if (existsSync(resolvedWorktreePath)) rmSync(resolvedWorktreePath, { recursive: true, force: true });
      await git.worktreePrune(dir).catch(() => undefined);
    }
  } finally {
    removeRepo(dir);
  }
});

test("every git invocation gets -c core.longpaths=true prepended on Windows", { skip: process.platform !== "win32" && "windows-only" }, async () => {
  const dir = initRepo();
  try {
    const seenArgs: string[][] = [];
    const spyingRunner: ProcessRunner = {
      async run(options: ProcessRunOptions): Promise<ProcessResult> {
        seenArgs.push(options.arguments ?? []);
        return runner.run(options);
      },
    };
    const git = newGitClient({ runner: spyingRunner });
    await git.exec(["status"], dir);
    assert.ok(seenArgs.length > 0);
    assert.deepEqual(seenArgs[0].slice(0, 2), ["-c", "core.longpaths=true"]);
  } finally {
    removeRepo(dir);
  }
});

test(
  "Windows long-path regression (Issue #25): worktreeRemove force-removes a worktree containing a deeply nested (>300 char) path (isolated git config: no core.longpaths anywhere)",
  { skip: process.platform !== "win32" && "windows-only" },
  async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "x", "utf8");
      commitAll(dir, "init");
      // NS-1: a spy on removeTree proves that GIT (thanks to `exec`'s `-c
      // core.longpaths=true`) removed the worktree, not the filesystem fallback -
      // without the spy this test would pass with the `-c` removed, masked by the
      // fallback.
      let removeTreeCalls = 0;
      const spyPlatform: PlatformAdapter = {
        ...platform,
        async removeTree(path: string) {
          removeTreeCalls++;
          return platform.removeTree(path);
        },
      };
      const git = newGitClient({ platform: spyPlatform });
      const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

      const worktreePath = join(tmpdir(), `hdo-gitclient-longpath-wt-${Date.now()}`);
      await git.worktreeAdd(dir, { branch: "hdo/longpath-regression", worktreePath, baseCommit: head });

      // Build a deeply nested directory chain INSIDE the worktree (not via git) whose
      // absolute path exceeds 300 characters, with a file at the bottom - the actual
      // Issue #25 scenario: the worktree root itself is a normal short path, but
      // content nested inside it is deep.
      let deep = worktreePath;
      while (deep.length < 300) {
        deep = join(deep, "nested-segment-0123456789");
      }
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "file.txt"), "deep content", "utf8");
      assert.ok(join(deep, "file.txt").length > 300);

      // S-10: isolate this machine's own git config (which sets core.longpaths=true
      // globally and would otherwise mask a missing `-c core.longpaths=true` in
      // `exec`) so this test actually exercises `exec`'s own override, not an ambient
      // setting. Without the `-c`, git fails with exit 255 "Filename too long" here and
      // the fallback takes over - which the removeTree spy below turns into a failure.
      await withIsolatedGitConfig("", async () => {
        await git.worktreeRemove(dir, worktreePath, { force: true });
      });
      assert.equal(existsSync(worktreePath), false);
      assert.equal(removeTreeCalls, 0, "git itself must have removed the long-path worktree; the fallback must not have run");

      const listedAfter = await git.worktreeList(dir);
      assert.ok(!listedAfter.some((p) => worktreePathsEqual(p, worktreePath)));
    } finally {
      removeRepo(dir);
    }
  },
);

test(
  "Windows long-path regression, real 'Filename too long' failure (global git config sets core.longpaths=false, beating -c): worktreeRemove still cleans up via the fallback",
  { skip: process.platform !== "win32" && "windows-only" },
  async () => {
    const dir = initRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "x", "utf8");
      commitAll(dir, "init");
      const git = newGitClient();
      const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

      const worktreePath = join(tmpdir(), `hdo-gitclient-longpath-falsecfg-wt-${Date.now()}`);
      await git.worktreeAdd(dir, { branch: "hdo/longpath-falsecfg-regression", worktreePath, baseCommit: head });

      let deep = worktreePath;
      while (deep.length < 300) {
        deep = join(deep, "nested-segment-0123456789");
      }
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "file.txt"), "deep content", "utf8");
      assert.ok(join(deep, "file.txt").length > 300);

      // A GLOBAL config file setting core.longpaths=false is cached by git while
      // reading config files and wins over exec's later `-c core.longpaths=true`
      // (confirmed by experiment - see the module-level facts this issue records), so
      // `git worktree remove --force` genuinely fails with "Filename too long" here,
      // after already deleting its own admin entry/gitfile/tracked files - the exact
      // shape `worktreeRemove`'s fallback exists for.
      await withIsolatedGitConfig("[core]\n\tlongpaths = false\n", async () => {
        await git.worktreeRemove(dir, worktreePath, { force: true });
      });
      assert.equal(existsSync(worktreePath), false, "the fallback (removeTree + prune) must finish the removal");

      const listedAfter = await git.worktreeList(dir);
      assert.ok(!listedAfter.some((p) => worktreePathsEqual(p, worktreePath)));
    } finally {
      removeRepo(dir);
    }
  },
);

test("worktreeRemove falls back to platform.removeTree + worktree prune when git itself reports failure", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();
    const worktreePath = join(tmpdir(), `hdo-gitclient-fallback-wt-${Date.now()}`);
    await git.worktreeAdd(dir, { branch: "hdo/fallback-test", worktreePath, baseCommit: head });
    assert.ok(existsSync(worktreePath));

    // A runner that makes `git worktree remove` itself always fail (as if git
    // encountered "Filename too long") AND hides the worktree from `worktree list`
    // (simulating that git already deleted its own admin entry before failing), but
    // passes every other git invocation (including `worktree prune`) straight through
    // to the real runner - so the fallback path (platform.removeTree, a real fs.rm,
    // then a real `worktree prune`) is what actually has to delete the directory and
    // clear Git's bookkeeping.
    const failingRemoveRunner = makeFailingRemoveRunner(runner, worktreePath, "simulated: Filename too long");
    const gitWithFailingRemove = newGitClient({ runner: failingRemoveRunner });
    await gitWithFailingRemove.worktreeRemove(dir, worktreePath, { force: true });
    assert.equal(existsSync(worktreePath), false);
  } finally {
    removeRepo(dir);
  }
});

test("worktreeRemove throws the ORIGINAL git failure (with a fallback-failure suffix) when the fallback also cannot remove the directory", async (t: TestContext) => {
  const dir = initRepo();
  let worktreePath: string | undefined;
  t.after(() => {
    if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();
    worktreePath = join(tmpdir(), `hdo-gitclient-doublefail-wt-${Date.now()}`);
    await git.worktreeAdd(dir, { branch: "hdo/doublefail-test", worktreePath, baseCommit: head });

    const failingRemoveRunner = makeFailingRemoveRunner(runner, worktreePath, "simulated: Filename too long");
    // A platform whose removeTree is a no-op (simulating the fallback ALSO being
    // unable to remove the directory) - the original git failure must surface (with
    // a "fallback removal left in place" suffix), not a new/different error.
    const noopRemoveTreePlatform: PlatformAdapter = {
      ...platform,
      async removeTree(): Promise<void> {
        // no-op: pretend even fs.rm could not remove it
      },
    };
    const git2 = newGitClient({ runner: failingRemoveRunner, platform: noopRemoveTreePlatform });
    // worktreePath (join(tmpdir(), ...)) is already absolute, so resolving it against
    // `dir` (as `worktreeRemove` does internally) leaves it unchanged.
    const expectedMessage =
      formatProcessFailure("git", 1, "", "simulated: Filename too long") + ` Fallback removal left '${worktreePath}' in place.`;
    await assert.rejects(
      () => git2.worktreeRemove(dir, worktreePath!, { force: true }),
      (error: unknown) => error instanceof Error && error.message === expectedMessage,
    );
    assert.ok(existsSync(worktreePath), "the directory must still exist - nothing else touched it");
  } finally {
    if (existsSync(dir)) removeRepo(dir);
    // Git's own worktree admin entry for `worktreePath` (registered by worktreeAdd,
    // never unregistered since both the real remove and the fallback were prevented
    // from succeeding) is orphaned along with `dir` itself; nothing further to clean
    // up on the git side since `dir` (and its .git/worktrees admin data) is gone too.
  }
});

test("worktreeRemove(force:true) on a LOCKED worktree throws the original git failure, directory and lock entry intact", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();
    const worktreePath = join(tmpdir(), `hdo-gitclient-locked-wt-${Date.now()}`);
    await git.worktreeAdd(dir, { branch: "hdo/locked-test", worktreePath, baseCommit: head });
    runGit(["worktree", "lock", worktreePath], dir);

    try {
      await assert.rejects(
        () => git.worktreeRemove(dir, worktreePath, { force: true }),
        (error: unknown) =>
          error instanceof Error &&
          /^Command 'git' failed with exit code 128\. .*locked.*/is.test(error.message),
      );
      assert.ok(existsSync(worktreePath), "a refused removal must leave the directory in place");
      const listed = await git.worktreeList(dir);
      assert.ok(listed.some((p) => worktreePathsEqual(p, worktreePath)), "the locked worktree must still be listed");
      // The lock entry itself (visible via `worktree list --porcelain`'s `locked`
      // line) must survive too - worktreeRemove must never call unlock/prune here.
      const porcelain = (await git.exec(["worktree", "list", "--porcelain"], dir)).stdout;
      assert.match(porcelain, /locked/);
    } finally {
      runGit(["worktree", "unlock", worktreePath], dir);
      await git.worktreeRemove(dir, worktreePath, { force: true }).catch(() => undefined);
    }
  } finally {
    removeRepo(dir);
  }
});

test("NB-1: worktreeRemove refuses (and touches nothing) when git does not list the target beforehand - unrelated directory, nonexistent path, worktree of another repository", async (t: TestContext) => {
  const dir = initRepo();
  const otherRepo = initRepo();
  let otherWorktree: string | undefined;
  t.after(() => {
    if (otherWorktree && existsSync(otherWorktree)) rmSync(otherWorktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    writeFileSync(join(otherRepo, "b.txt"), "y", "utf8");
    commitAll(otherRepo, "init");
    const git = newGitClient();
    const refusal = (target: string) => (error: unknown) =>
      error instanceof Error && error.message === `Refusing cleanup because Git does not list the target as a worktree: ${target}`;

    // 1. an unrelated directory with content
    const unrelated = mkdtempSync(join(tmpdir(), "hdo-gitclient-unrelated-"));
    t.after(() => rmSync(unrelated, { recursive: true, force: true }));
    writeFileSync(join(unrelated, "precious.txt"), "keep me", "utf8");
    await assert.rejects(() => git.worktreeRemove(dir, unrelated, { force: true }), refusal(unrelated));
    assert.equal(readFileSync(join(unrelated, "precious.txt"), "utf8"), "keep me");

    // 2. a nonexistent path resolves against the repository, and is refused (not silently "removed")
    const missing = join(dir, "does-not-exist");
    await assert.rejects(() => git.worktreeRemove(dir, "does-not-exist", { force: true }), refusal(missing));

    // 3. a worktree that belongs to ANOTHER repository
    const otherHead = (await git.revParseVerify(otherRepo, "HEAD^{commit}")).stdout.trim();
    const otherWorktreePath = join(tmpdir(), `hdo-gitclient-other-wt-${Date.now()}`);
    otherWorktree = otherWorktreePath;
    await git.worktreeAdd(otherRepo, { branch: "hdo/other-repo", worktreePath: otherWorktreePath, baseCommit: otherHead });
    await assert.rejects(() => git.worktreeRemove(dir, otherWorktreePath, { force: true }), refusal(otherWorktreePath));
    assert.ok(existsSync(join(otherWorktreePath, "b.txt")), "the other repository's worktree must be intact");
    assert.ok((await git.worktreeList(otherRepo)).some((p) => worktreePathsEqual(p, otherWorktreePath)), "the other repository must still list its worktree");
  } finally {
    removeRepo(dir);
    removeRepo(otherRepo);
  }
});

test("worktreeRemove(force:false) on a DIRTY worktree throws the original git failure, files intact", async (t: TestContext) => {
  const dir = initRepo();
  let dirtyWorktree: string | undefined;
  t.after(() => {
    if (dirtyWorktree && existsSync(dirtyWorktree)) rmSync(dirtyWorktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    commitAll(dir, "init");
    const git = newGitClient();
    const head = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();
    const worktreePath = join(tmpdir(), `hdo-gitclient-dirty-wt-${Date.now()}`);
    dirtyWorktree = worktreePath;
    await git.worktreeAdd(dir, { branch: "hdo/dirty-test", worktreePath, baseCommit: head });
    writeFileSync(join(worktreePath, "a.txt"), "uncommitted change", "utf8");

    await assert.rejects(
      () => git.worktreeRemove(dir, worktreePath, { force: false }),
      (error: unknown) =>
        error instanceof Error && /^Command 'git' failed with exit code 128\. /.test(error.message),
    );
    assert.ok(existsSync(worktreePath), "a refused removal must leave the directory in place");
    assert.equal(readFileSync(join(worktreePath, "a.txt"), "utf8"), "uncommitted change", "the uncommitted change must survive untouched");
    const listed = await git.worktreeList(dir);
    assert.ok(listed.some((p) => worktreePathsEqual(p, worktreePath)), "the dirty worktree must still be listed");
  } finally {
    removeRepo(dir);
  }
});

// Phase 3 (ADR-0001 Migration strategy): `GitClient.diff`, a port of `Get-HdoDiff`
// (Git.ps1). Each test below is traceable 1:1 to a named PowerShell oracle case so a
// reviewer can confirm this cannot silently drift from it.

// Oracle: tests/run-tests.ps1:868 - `Get-HdoSha256 ''` is asserted to equal this exact
// constant directly, independent of `Get-HdoDiff`.
const EMPTY_PATCH_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Oracle: tests/run-tests.ps1 (no named assertion for the clean case beyond the
// EMPTY_PATCH_SHA256 constant above) - exercises `hasChanges`/`patch`/`hash`/`numstat`/
// `status` all being empty/false on a worktree with no changes since the base commit.
test("diff: reports no changes on a clean worktree with the fixed empty-diff SHA-256", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "tracked.txt"), "baseline", "utf8");
    commitAll(dir, "baseline");
    const git = newGitClient();
    const baseCommit = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

    const result = await git.diff(dir, baseCommit);
    assert.equal(result.patch, "");
    assert.equal(result.hash, EMPTY_PATCH_SHA256);
    assert.deepEqual(result.numstat, []);
    assert.deepEqual(result.status, []);
    assert.equal(result.hasChanges, false);
    assert.match(result.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    removeRepo(dir);
  }
});

// Oracle: tests/run-tests.ps1:944-964, test case name
// "diff capture includes untracked content and filenames with spaces".
test("diff: captures untracked content and filenames with spaces", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "tracked.txt"), "baseline", "utf8");
    commitAll(dir, "baseline");
    const git = newGitClient();
    const baseCommit = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

    writeFileSync(join(dir, "untracked file.txt"), "untracked evidence", "utf8");

    const result = await git.diff(dir, baseCommit);
    assert.equal(result.hasChanges, true);
    assert.match(result.patch, /untracked evidence/);
    assert.match(result.patch, /untracked file\.txt/);
    assert.ok(result.numstat.some((line) => line.includes("untracked file.txt")));
    assert.equal(result.hash, sha256Hex(result.patch));
  } finally {
    removeRepo(dir);
  }
});

// Oracle: tests/test-process-output.ps1 (~lines 140-169) - two untracked files of 1500
// bytes each against a deliberately small `-MaximumPatchBytes 2048`, proving the cap is
// cumulative across untracked files and throws rather than truncates.
test("diff: caps the aggregate patch across untracked files, throwing rather than truncating", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "tracked.txt"), "base", "utf8");
    commitAll(dir, "base");
    const git = newGitClient();
    const baseCommit = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

    writeFileSync(join(dir, "untracked-a.txt"), "a".repeat(1500), "utf8");
    writeFileSync(join(dir, "untracked-b.txt"), "b".repeat(1500), "utf8");

    await assert.rejects(
      () => git.diff(dir, baseCommit, { maximumPatchBytes: 2048 }),
      (error: unknown) => error instanceof Error && /^Aggregate Git diff exceeds/.test(error.message),
    );
  } finally {
    removeRepo(dir);
  }
});

// Not separately named in the PowerShell oracle (tracked modifications/deletions are
// exercised implicitly throughout `run-tests.ps1`'s workflow tests, not as a standalone
// `Get-HdoDiff` case) - added here because `diff`'s tracked-file path is otherwise
// untested by the two named cases above, which only cover untracked files.
test("diff: captures tracked modifications and deletions relative to the base commit", async () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "modified.txt"), "before", "utf8");
    writeFileSync(join(dir, "deleted.txt"), "gone soon", "utf8");
    commitAll(dir, "baseline");
    const git = newGitClient();
    const baseCommit = (await git.revParseVerify(dir, "HEAD^{commit}")).stdout.trim();

    writeFileSync(join(dir, "modified.txt"), "after", "utf8");
    rmSync(join(dir, "deleted.txt"));

    const result = await git.diff(dir, baseCommit);
    assert.equal(result.hasChanges, true);
    assert.match(result.patch, /-before/);
    assert.match(result.patch, /\+after/);
    assert.ok(result.numstat.some((line) => line.includes("modified.txt")));
    assert.ok(result.numstat.some((line) => line.includes("deleted.txt")));
    assert.ok(result.status.some((line) => line.includes("deleted.txt")));
  } finally {
    removeRepo(dir);
  }
});
