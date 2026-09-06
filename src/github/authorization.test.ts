// Fake-runner tests for Get-HdoIssueLastEditedAt / Test-HdoReadyLabelAuthorization
// ports (GitHub.ps1:92-178). No real network or `gh` binary.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import type { ResolvedHdoConfig } from "../core/contracts/types.ts";
import { GhClient } from "./client.ts";
import { getIssueLastEditedAt, testReadyLabelAuthorization } from "./authorization.ts";

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

function githubConfig(overrides: Partial<{ trustedActors: string[]; ready: string }> = {}): Pick<ResolvedHdoConfig, "github"> {
  return {
    github: {
      labels: {
        ready: overrides.ready ?? "hdo:ready",
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
    },
  };
}

test("getIssueLastEditedAt: throws on a malformed repository slug", async () => {
  const gh = new GhClient({ runner: fakeRunner(() => makeResult()) });
  await assert.rejects(
    () => getIssueLastEditedAt(gh, "not-a-slug", 1, "/repo"),
    (error: unknown) => error instanceof Error && error.message === "Invalid GitHub repository slug 'not-a-slug'.",
  );
});

test("getIssueLastEditedAt: throws when the GraphQL response has no matching issue", async () => {
  const gh = new GhClient({ runner: fakeRunner(() => makeResult({ stdout: JSON.stringify({ data: { repository: { issue: null } } }) })) });
  await assert.rejects(
    () => getIssueLastEditedAt(gh, "o/r", 5, "/repo"),
    (error: unknown) => error instanceof Error && error.message === "GitHub Issue o/r#5 was not found while checking ready authorization.",
  );
});

test("getIssueLastEditedAt: returns lastEditedAt from the GraphQL response", async () => {
  const gh = new GhClient({
    runner: fakeRunner(() => makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "2026-01-01T00:00:00Z" } } } }) })),
  });
  const result = await getIssueLastEditedAt(gh, "o/r", 5, "/repo");
  assert.equal(result, "2026-01-01T00:00:00Z");
});

function eventsResponse(events: unknown[]): string {
  return JSON.stringify([events]);
}

test("testReadyLabelAuthorization: not authorized (enforced) when no ready label event is found", async () => {
  const gh = new GhClient({ runner: fakeRunner(() => makeResult({ stdout: eventsResponse([]) })) });
  const result = await testReadyLabelAuthorization(gh, githubConfig(), "o/r", 1, "/repo");
  assert.equal(result.authorized, false);
  assert.equal(result.enforced, true);
  assert.equal(result.actor, null);
  assert.equal(result.reason, "No label event was found for 'hdo:ready'.");
});

test("testReadyLabelAuthorization: not authorized when the content was edited after the ready event (stale)", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) {
        return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "2026-09-03T01:43:08Z" } } } }) });
      }
      return makeResult({
        stdout: eventsResponse([{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "alice" }, created_at: "2026-09-03T01:43:07Z" }]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig(), "o/r", 1, "/repo");
  assert.equal(result.authorized, false);
  assert.equal(result.enforced, true);
  assert.equal(result.actor, "alice");
});

test("testReadyLabelAuthorization: authorized, unenforced, when trustedActors is empty", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
      return makeResult({
        stdout: eventsResponse([{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "alice" }, created_at: "2026-09-03T01:43:07Z" }]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig({ trustedActors: [] }), "o/r", 1, "/repo");
  assert.equal(result.authorized, true);
  assert.equal(result.enforced, false);
});

test("testReadyLabelAuthorization: authorized when the ready label actor is trusted", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
      return makeResult({
        stdout: eventsResponse([{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "alice" }, created_at: "2026-09-03T01:43:07Z" }]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig({ trustedActors: ["alice"] }), "o/r", 1, "/repo");
  assert.equal(result.authorized, true);
  assert.equal(result.enforced, true);
  assert.equal(result.reason, "Ready label was applied by trusted actor 'alice'.");
});

test("testReadyLabelAuthorization: not authorized when the ready label actor is untrusted", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
      return makeResult({
        stdout: eventsResponse([{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "mallory" }, created_at: "2026-09-03T01:43:07Z" }]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig({ trustedActors: ["alice"] }), "o/r", 1, "/repo");
  assert.equal(result.authorized, false);
  assert.equal(result.enforced, true);
  assert.equal(result.reason, "Ready label actor 'mallory' is not trusted.");
});

test("testReadyLabelAuthorization: matches a label event whose name differs only by case from the configured ready label (PowerShell -eq is case-insensitive)", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
      return makeResult({
        stdout: eventsResponse([{ event: "LABELED", label: { name: "HDO:READY" }, actor: { login: "alice" }, created_at: "2026-09-03T01:43:07Z" }]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig({ trustedActors: [] }), "o/r", 1, "/repo");
  assert.equal(result.authorized, true);
  assert.equal(result.actor, "alice");
});

test("testReadyLabelAuthorization: picks the most recent matching ready label event", async () => {
  const gh = new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args.includes("graphql")) return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
      return makeResult({
        stdout: eventsResponse([
          { event: "labeled", label: { name: "hdo:ready" }, actor: { login: "old-actor" }, created_at: "2026-01-01T00:00:00Z" },
          { event: "labeled", label: { name: "hdo:ready" }, actor: { login: "new-actor" }, created_at: "2026-06-01T00:00:00Z" },
          { event: "labeled", label: { name: "hdo:skip" }, actor: { login: "irrelevant" }, created_at: "2026-12-01T00:00:00Z" },
        ]),
      });
    }),
  });
  const result = await testReadyLabelAuthorization(gh, githubConfig({ trustedActors: [] }), "o/r", 1, "/repo");
  assert.equal(result.actor, "new-actor");
});
