// Fake-runner tests for GhClient - no real network or `gh` binary anywhere. Mirrors
// the fake-ProcessRunner style already used in src/git/index.test.ts.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import { GitClient } from "../git/index.ts";
import { GhClient, getIssue, getLabelNames, resolveRepositorySlug } from "./client.ts";

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: overrides.command ?? "gh",
    arguments: overrides.arguments ?? [],
    exitCode: overrides.exitCode ?? 0,
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
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
  };
}

function fakeRunner(handler: (options: ProcessRunOptions) => ProcessResult): ProcessRunner {
  return { async run(options: ProcessRunOptions): Promise<ProcessResult> { return handler(options); } };
}

test("exec never throws and reports a non-zero exit code with stderr", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 7, stderr: "boom" }));
  const gh = new GhClient({ runner });
  const result = await gh.exec(["issue", "view", "1"], "/repo");
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "boom");
});

test("execJson: throws 'GitHub CLI failed: <stderr>' on non-zero exit", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 1, stderr: "  not found  " }));
  const gh = new GhClient({ runner });
  await assert.rejects(
    () => gh.execJson(["issue", "view", "1"], "/repo"),
    (error: unknown) => error instanceof Error && error.message === "GitHub CLI failed: not found",
  );
});

test("execJson: throws 'GitHub CLI returned invalid JSON: <message>' on unparseable stdout", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 0, stdout: "not json" }));
  const gh = new GhClient({ runner });
  await assert.rejects(
    () => gh.execJson(["issue", "view", "1"], "/repo"),
    (error: unknown) => error instanceof Error && error.message.startsWith("GitHub CLI returned invalid JSON: "),
  );
});

test("execJson: parses valid JSON stdout", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 0, stdout: JSON.stringify({ number: 42 }) }));
  const gh = new GhClient({ runner });
  const result = await gh.execJson<{ number: number }>(["issue", "view", "42"], "/repo");
  assert.equal(result.number, 42);
});

test("execThrowing: throws formatProcessFailure('gh', ...) text (distinct from execJson's message) on non-zero exit", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 4, stdout: "out", stderr: "err" }));
  const gh = new GhClient({ runner, ghExecutable: "gh.exe" });
  await assert.rejects(
    () => gh.execThrowing(["label", "create", "x"], "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Command 'gh' failed with exit code 4. err",
  );
});

test("execPagedJson: builds the --paginate --slurp argv and flattens a page-of-pages array", async () => {
  let seenArgs: string[] = [];
  const runner = fakeRunner((options) => {
    seenArgs = options.arguments ?? [];
    return makeResult({ exitCode: 0, stdout: JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]) });
  });
  const gh = new GhClient({ runner });
  const items = await gh.execPagedJson<{ id: number }>("repos/o/r/issues/1/comments", "/repo");
  assert.deepEqual(seenArgs, ["api", "--paginate", "--slurp", "-X", "GET", "repos/o/r/issues/1/comments", "-f", "per_page=100"]);
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
});

test("execPagedJson: throws 'GitHub CLI failed: ...' on non-zero exit and 'GitHub CLI returned invalid paginated JSON: ...' on a parse failure", async () => {
  const failingRunner = fakeRunner(() => makeResult({ exitCode: 1, stderr: "denied" }));
  const gh1 = new GhClient({ runner: failingRunner });
  await assert.rejects(
    () => gh1.execPagedJson("endpoint", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "GitHub CLI failed: denied",
  );

  const invalidJsonRunner = fakeRunner(() => makeResult({ exitCode: 0, stdout: "{not json" }));
  const gh2 = new GhClient({ runner: invalidJsonRunner });
  await assert.rejects(
    () => gh2.execPagedJson("endpoint", "/repo"),
    (error: unknown) => error instanceof Error && error.message.startsWith("GitHub CLI returned invalid paginated JSON: "),
  );
});

test("getLabelNames: handles both string[] and {name}[] label shapes, and null/undefined", () => {
  assert.deepEqual(getLabelNames(["a", "b"]), ["a", "b"]);
  assert.deepEqual(getLabelNames([{ name: "a" }, { name: "b" }]), ["a", "b"]);
  assert.deepEqual(getLabelNames(undefined), []);
  assert.deepEqual(getLabelNames(null), []);
  assert.deepEqual(getLabelNames([]), []);
});

test("resolveRepositorySlug: prefers github.repository from configuration", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 0, stdout: "should not be used" }));
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  const slug = await resolveRepositorySlug({ github: { repository: "kkb-hub/hybrid-dev-orchestrator" } as never, repositoryPath: "/repo" }, git);
  assert.equal(slug, "kkb-hub/hybrid-dev-orchestrator");
});

test("resolveRepositorySlug: parses owner/repo out of git remote.origin.url when github.repository is unset", async () => {
  const runner = fakeRunner((options) => {
    if ((options.arguments ?? []).includes("config")) {
      return makeResult({ exitCode: 0, stdout: "https://github.com/kkb-hub/hybrid-dev-orchestrator.git\n" });
    }
    return makeResult({ exitCode: 0 });
  });
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  const slug = await resolveRepositorySlug({ github: {} as never, repositoryPath: "/repo" }, git);
  assert.equal(slug, "kkb-hub/hybrid-dev-orchestrator");
});

test("resolveRepositorySlug: throws when the remote URL cannot be resolved to a GitHub slug", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 0, stdout: "https://example.com/not-github.git\n" }));
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  await assert.rejects(
    () => resolveRepositorySlug({ github: {} as never, repositoryPath: "/repo" }, git),
    (error: unknown) => error instanceof Error && error.message === "Unable to resolve GitHub owner/repository. Set github.repository in configuration.",
  );
});

test("resolveRepositorySlug: throws formatProcessFailure('git', ...) when 'git config' itself fails", async () => {
  const runner = fakeRunner(() => makeResult({ exitCode: 1, stderr: "not a git repository" }));
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  await assert.rejects(
    () => resolveRepositorySlug({ github: {} as never, repositoryPath: "/repo" }, git),
    (error: unknown) => error instanceof Error && error.message.startsWith("Command 'git' failed with exit code 1."),
  );
});

test("getIssue: builds 'gh issue view <n> --repo <repo> --json <fields>' and injects repository + normalized labels", async () => {
  let seenArgs: string[] = [];
  let seenCwd = "";
  const runner = fakeRunner((options) => {
    seenArgs = options.arguments ?? [];
    seenCwd = options.workingDirectory;
    return makeResult({
      exitCode: 0,
      stdout: JSON.stringify({ number: 7, title: "t", body: "b", state: "OPEN", labels: [{ name: "hdo:ready" }], url: "u", updatedAt: "2026-01-01T00:00:00Z" }),
    });
  });
  const gh = new GhClient({ runner });
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  const issue = await getIssue(gh, git, { github: {} as never, repositoryPath: "/repo" }, 7, "kkb-hub/hybrid-dev-orchestrator");
  assert.deepEqual(seenArgs, [
    "issue",
    "view",
    "7",
    "--repo",
    "kkb-hub/hybrid-dev-orchestrator",
    "--json",
    "number,title,body,state,labels,assignees,milestone,author,createdAt,updatedAt,url,comments",
  ]);
  assert.equal(seenCwd, "/repo");
  assert.equal(issue.repository, "kkb-hub/hybrid-dev-orchestrator");
  assert.deepEqual(issue.labels, ["hdo:ready"]);
  assert.equal(issue.number, 7);
});

test("getIssue: resolves the repository slug when none is supplied", async () => {
  const runner = fakeRunner((options) => {
    const args = options.arguments ?? [];
    if (args.includes("config")) return makeResult({ exitCode: 0, stdout: "git@github.com:kkb-hub/hybrid-dev-orchestrator.git\n" });
    return makeResult({ exitCode: 0, stdout: JSON.stringify({ number: 1, title: "t", body: "b", state: "OPEN", labels: [], url: "u", updatedAt: "x" }) });
  });
  const gh = new GhClient({ runner });
  const platform = getPlatform();
  const git = new GitClient({ runner, platform });
  const issue = await getIssue(gh, git, { github: {} as never, repositoryPath: "/repo" }, 1);
  assert.equal(issue.repository, "kkb-hub/hybrid-dev-orchestrator");
});
