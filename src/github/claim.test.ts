// Fake-runner tests for Get-HdoClaimComments / Set-HdoManagedStatusLabel /
// Claim-HdoIssue / Protect-HdoGitHubText ports (GitHub.ps1:462-638). No real network
// or `gh`/`git` binary.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import type { GithubIssue, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { getPlatform } from "../platform/index.ts";
import { GitClient } from "../git/index.ts";
import { GhClient } from "./client.ts";
import { claimIssue, getClaimComments, protectGitHubText, setManagedStatusLabel } from "./claim.ts";

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: "gh",
    arguments: [],
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

function githubConfig(overrides: Partial<{ trustedActors: string[] }> = {}): ResolvedHdoConfig["github"] {
  return {
    labels: {
      ready: "hdo:ready",
      skip: "hdo:skip",
      statusPrefix: "hdo:status/",
      claimed: "hdo:status/claimed",
      implementing: "hdo:status/implementing",
      review: "hdo:status/review",
      changesRequested: "hdo:status/changes-requested",
      approved: "hdo:status/approved",
      escalated: "hdo:status/blocked",
      failed: "hdo:status/failed",
      cancelled: "hdo:status/cancelled",
    },
    priorityOrder: [],
    writeBack: "none",
    candidateLimit: 50,
    assignOnClaim: true,
    trustedActors: overrides.trustedActors,
  };
}

interface RawComment {
  id: number;
  body: string;
  user: { login: string };
  author_association: string;
  created_at: string;
}

function commentBody(marker: Record<string, unknown>, text = "HDO claim"): string {
  return `<!-- hdo:claim:v1 ${JSON.stringify(marker)} -->\n${text}`;
}

function validMarker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "claim",
    runId: "issue-123-abcDEF",
    issueKey: "o/r#123",
    claimedBy: "alice",
    claimedAt: "2026-01-01T00:00:00.000Z",
    leaseExpiresAt: "2026-01-02T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
}

function pagedCommentsRunner(comments: RawComment[]): ProcessRunner {
  return fakeRunner(() => makeResult({ stdout: JSON.stringify([comments]) }));
}

// --- getClaimComments -------------------------------------------------------------

test("getClaimComments: a fully valid marker from a trusted (OWNER) author is accepted", async () => {
  const marker = validMarker();
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "2026-01-01T00:00:00Z" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].runId, "issue-123-abcDEF");
  assert.equal(claims[0].status, "active");
});

test("getClaimComments: rejects an untrusted author (no trustedActors configured, association not OWNER/MEMBER/COLLABORATOR)", async () => {
  const marker = validMarker();
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "NONE", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects a marker whose claimedBy does not match the comment author", async () => {
  const marker = validMarker({ claimedBy: "bob" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects a marker with the wrong version/kind", async () => {
  const marker = validMarker({ kind: "not-claim" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects a marker whose issueKey does not match repository#number", async () => {
  const marker = validMarker({ issueKey: "o/r#999" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects a malformed runId", async () => {
  const marker = validMarker({ runId: "not-a-valid-run-id" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects an invalid state", async () => {
  const marker = validMarker({ state: "pending" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

test("getClaimComments: rejects a lease that does not extend past claimedAt", async () => {
  const marker = validMarker({ claimedAt: "2026-01-02T00:00:00.000Z", leaseExpiresAt: "2026-01-01T00:00:00.000Z" });
  const comments: RawComment[] = [{ id: 1, body: commentBody(marker), user: { login: "alice" }, author_association: "OWNER", created_at: "x" }];
  const gh = new GhClient({ runner: pagedCommentsRunner(comments) });
  const claims = await getClaimComments(gh, { github: githubConfig() }, "o/r", 123, "/repo");
  assert.equal(claims.length, 0);
});

// --- setManagedStatusLabel ---------------------------------------------------------

function makeGitAndGh(runner: ProcessRunner): { gh: GhClient; git: GitClient } {
  const platform = getPlatform();
  return { gh: new GhClient({ runner }), git: new GitClient({ runner, platform }) };
}

test("setManagedStatusLabel: removes the current ready/status labels (except the target) and adds the target", async () => {
  let editArgs: string[] | undefined;
  const runner = fakeRunner((options) => {
    const args = options.arguments ?? [];
    if (args[0] === "issue" && args[1] === "view") {
      return makeResult({ stdout: JSON.stringify({ number: 1, title: "t", body: "b", state: "OPEN", labels: ["hdo:ready", "other-label"], url: "u", updatedAt: "x" }) });
    }
    if (args[0] === "issue" && args[1] === "edit") {
      editArgs = args;
      return makeResult({ exitCode: 0 });
    }
    return makeResult({ exitCode: 1, stderr: "unhandled" });
  });
  const { gh, git } = makeGitAndGh(runner);
  await setManagedStatusLabel(gh, { github: githubConfig() }, git, "o/r", 1, "hdo:status/claimed", "/repo");
  assert.ok(editArgs);
  assert.ok(editArgs!.includes("--remove-label"));
  assert.equal(editArgs![editArgs!.indexOf("--remove-label") + 1], "hdo:ready");
  assert.ok(editArgs!.includes("--add-label"));
  assert.equal(editArgs![editArgs!.indexOf("--add-label") + 1], "hdo:status/claimed");
  assert.ok(!editArgs!.includes("other-label"));
});

test("setManagedStatusLabel: no-op (no gh issue edit call) when the target label is already the only ready/status label", async () => {
  let editCalls = 0;
  const runner = fakeRunner((options) => {
    const args = options.arguments ?? [];
    if (args[0] === "issue" && args[1] === "view") {
      return makeResult({ stdout: JSON.stringify({ number: 1, title: "t", body: "b", state: "OPEN", labels: ["hdo:status/claimed"], url: "u", updatedAt: "x" }) });
    }
    if (args[0] === "issue" && args[1] === "edit") {
      editCalls++;
      return makeResult({ exitCode: 0 });
    }
    return makeResult({ exitCode: 1, stderr: "unhandled" });
  });
  const { gh, git } = makeGitAndGh(runner);
  await setManagedStatusLabel(gh, { github: githubConfig() }, git, "o/r", 1, "hdo:status/claimed", "/repo");
  assert.equal(editCalls, 0);
});

// --- claimIssue ---------------------------------------------------------------------

interface ClaimFakeOptions {
  currentIssueOverrides?: Partial<Record<string, unknown>>;
  initialComments?: RawComment[];
  login?: string;
  labelEditFails?: boolean;
}

function makeClaimFake(options: ClaimFakeOptions = {}): { runner: ProcessRunner; comments: () => RawComment[] } {
  const comments: RawComment[] = options.initialComments ? [...options.initialComments] : [];
  let nextId = comments.reduce((max, c) => Math.max(max, c.id), 0) + 1;

  const runner: ProcessRunner = {
    async run(procOptions: ProcessRunOptions): Promise<ProcessResult> {
      const args = procOptions.arguments ?? [];
      if (args[0] === "issue" && args[1] === "view") {
        return makeResult({
          stdout: JSON.stringify({
            number: 123,
            title: "t",
            body: "original-body",
            state: "OPEN",
            labels: ["hdo:ready"],
            url: "u",
            updatedAt: "2026-01-01T00:00:00Z",
            ...options.currentIssueOverrides,
          }),
        });
      }
      if (args[0] === "issue" && args[1] === "edit") {
        if (options.labelEditFails && args.includes("--add-label")) {
          return makeResult({ exitCode: 1, stderr: "label update failed" });
        }
        return makeResult({ exitCode: 0 });
      }
      if (args[0] === "api" && args.includes("--paginate")) {
        return makeResult({ stdout: JSON.stringify([comments]) });
      }
      if (args[0] === "api" && args[1] === "user") {
        return makeResult({ stdout: `${options.login ?? "alice"}\n` });
      }
      if (args[0] === "api" && args.includes("-X") && args.includes("POST")) {
        const bodyArg = args[args.indexOf("-f") + 1] ?? "";
        const body = bodyArg.startsWith("body=") ? bodyArg.slice("body=".length) : bodyArg;
        const id = nextId++;
        comments.push({ id, body, user: { login: options.login ?? "alice" }, author_association: "OWNER", created_at: new Date().toISOString() });
        return makeResult({ stdout: JSON.stringify({ id }) });
      }
      if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
        const endpoint = args[3] ?? "";
        const id = Number(endpoint.split("/").pop());
        const bodyArg = args[args.indexOf("-f") + 1] ?? "";
        const body = bodyArg.startsWith("body=") ? bodyArg.slice("body=".length) : bodyArg;
        const existing = comments.find((c) => c.id === id);
        if (existing) existing.body = body;
        return makeResult({ stdout: JSON.stringify({ id }) });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  return { runner, comments: () => comments };
}

function baseIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    repository: "o/r",
    number: 123,
    url: "u",
    updatedAt: "2026-01-01T00:00:00Z",
    title: "t",
    state: "OPEN",
    labels: ["hdo:ready"],
    body: "original-body",
    ...overrides,
  };
}

function fullConfig(overrides: Partial<{ trustedActors: string[] }> = {}): ResolvedHdoConfig {
  return {
    schemaVersion: 1,
    activeProfile: "default",
    profiles: {},
    runners: {},
    github: githubConfig(overrides),
    workflow: { maxFixAttempts: 3, implicitFallback: false, onNoDiff: "fail", onValidationFailure: "escalate", onMaxFixAttempts: "escalate" },
    paths: { worktreeRoot: "/worktrees", artifactRoot: "/artifacts" },
    projectContractPath: ".hdo/project.json",
  };
}

test("claimIssue: throws when the Issue changed since contract validation (stale updatedAt)", async () => {
  const { runner } = makeClaimFake({ currentIssueOverrides: { updatedAt: "2026-02-02T00:00:00Z" } });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    () => claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-run1", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Issue #123 changed after contract validation; re-run HDO against a fresh snapshot.",
  );
});

test("claimIssue: throws when another run already holds an active claim", async () => {
  const existingMarker = validMarker({ runId: "issue-123-existing" });
  const { runner } = makeClaimFake({
    initialComments: [{ id: 1, body: commentBody(existingMarker), user: { login: "alice" }, author_association: "OWNER", created_at: "2026-01-01T00:00:00Z" }],
  });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    () => claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-newrun", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Issue #123 already has an active HDO run: issue-123-existing",
  );
});

test("claimIssue: throws when the authenticated actor is not in github.trustedActors", async () => {
  const { runner } = makeClaimFake({ login: "mallory" });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    () => claimIssue(gh, git, fullConfig({ trustedActors: ["alice"] }), baseIssue(), "issue-123-run1", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Authenticated GitHub actor 'mallory' is not listed in github.trustedActors.",
  );
});

test("claimIssue: loses the race to a lower comment id and releases its own marker", async () => {
  // A competitor's active claim is already sitting at id 1; our own comment (posted
  // during the call) will land at id 2, so the competitor's lower id wins.
  const competitorMarker = validMarker({ runId: "issue-1-competitor", claimedBy: "bob" });
  const { runner, comments } = makeClaimFake({
    initialComments: [],
    login: "alice",
  });
  // Seed the competitor claim AFTER our own posts, by wrapping the runner: intercept
  // the POST call once to also insert the competitor comment with a lower id first.
  let posted = false;
  const wrapped: ProcessRunner = {
    async run(options) {
      const args = options.arguments ?? [];
      if (!posted && args[0] === "api" && args.includes("-X") && args.includes("POST")) {
        posted = true;
        comments().push({ id: 1, body: commentBody(competitorMarker), user: { login: "bob" }, author_association: "OWNER", created_at: "2026-01-01T00:00:00Z" });
      }
      return runner.run(options);
    },
  };
  const { gh, git } = makeGitAndGh(wrapped);
  await assert.rejects(
    () => claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-mine", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Issue #123 claim conflict. Winning run: issue-1-competitor",
  );
  // Our own posted comment's marker must have been released (PATCHed to state: released).
  const ownComment = comments().find((c) => c.body.includes("issue-123-mine"));
  assert.ok(ownComment);
  assert.match(ownComment!.body, /"state":"released"/);
});

test("claimIssue: conflict message falls back to an empty winner name (not the string 'undefined') when no active claim is found at all", async () => {
  // Our own posted comment is given an untrusted `author_association` (`NONE`), so
  // `getClaimComments` filters it out too (trustedActors is empty, so the trust gate
  // falls back to OWNER/MEMBER/COLLABORATOR) - `claims` ends up empty and `winner` is
  // `undefined`. GitHub.ps1:571's `$winner.runId` on a $null `$winner` string-
  // interpolates as "" (PowerShell null-safe member access), not the TS default of
  // `undefined`; this pins that behavior.
  const runner: ProcessRunner = {
    async run(procOptions: ProcessRunOptions): Promise<ProcessResult> {
      const args = procOptions.arguments ?? [];
      if (args[0] === "issue" && args[1] === "view") {
        return makeResult({
          stdout: JSON.stringify({ number: 123, title: "t", body: "original-body", state: "OPEN", labels: ["hdo:ready"], url: "u", updatedAt: "2026-01-01T00:00:00Z" }),
        });
      }
      if (args[0] === "api" && args.includes("--paginate")) {
        return makeResult({ stdout: JSON.stringify([[]]) });
      }
      if (args[0] === "api" && args[1] === "user") {
        return makeResult({ stdout: "alice\n" });
      }
      if (args[0] === "api" && args.includes("-X") && args.includes("POST")) {
        return makeResult({ stdout: JSON.stringify({ id: 1 }) });
      }
      if (args[0] === "api" && args.includes("-X") && args.includes("PATCH")) {
        return makeResult({ stdout: JSON.stringify({ id: 1 }) });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    () => claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-mine", "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Issue #123 claim conflict. Winning run: ",
  );
});

test("claimIssue: succeeds when there is no competing claim, returning the comment id, marker, and no warning", async () => {
  const { runner, comments } = makeClaimFake({ login: "alice" });
  const { gh, git } = makeGitAndGh(runner);
  const result = await claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-mine", "/repo");
  assert.equal(result.marker.runId, "issue-123-mine");
  assert.equal(result.marker.state, "active");
  assert.equal(result.warning, null);
  assert.equal(comments().length, 1);
});

test("claimIssue: a status-label update failure after a successful claim releases the marker and rethrows", async () => {
  const { runner, comments } = makeClaimFake({ login: "alice", labelEditFails: true });
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(() => claimIssue(gh, git, fullConfig(), baseIssue(), "issue-123-mine", "/repo"));
  const ownComment = comments().find((c) => c.body.includes("issue-123-mine"));
  assert.ok(ownComment);
  assert.match(ownComment!.body, /"state":"released"/);
});

// --- protectGitHubText ---------------------------------------------------------------

test("protectGitHubText: escapes HTML comment delimiters so caller text cannot terminate a claim marker", () => {
  const result = protectGitHubText("prefix <!-- injected --> suffix");
  assert.equal(result, "prefix &lt;!-- injected --&gt; suffix");
});

test("protectGitHubText: inserts a zero-width space after every @ to prevent accidental mentions", () => {
  const zwsp = String.fromCodePoint(0x200b);
  const result = protectGitHubText("cc @someone and @another");
  assert.equal(result, `cc @${zwsp}someone and @${zwsp}another`);
});

test("protectGitHubText: truncates text longer than maximumLength and appends an ellipsis", () => {
  const result = protectGitHubText("a".repeat(20), 10);
  assert.equal(result, "a".repeat(10) + "…");
});

test("protectGitHubText: null/undefined/empty text returns an empty string", () => {
  assert.equal(protectGitHubText(null), "");
  assert.equal(protectGitHubText(undefined), "");
  assert.equal(protectGitHubText(""), "");
});
