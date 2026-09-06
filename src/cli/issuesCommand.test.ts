// Tests for `runIssuesCommand` (hdo.ps1's `issues` case port, hdo.ps1:77-83). No real
// network or `gh` binary - `GhClient` is constructed over a scripted fake
// `ProcessRunner` (the pattern `src/workflow/selectIssue.test.ts` and
// `src/github/issues.test.ts` already use), while `git` is the REAL repository's own
// `GitClient` (real `git` on PATH, no fixture repo needed - mirrors
// `statusCommand.test.ts`'s "real environment" pattern) so `resolveCliConfig` resolves
// against this repository's own `.hdo/project.json` (gate ids `tests`/`schemas`).
import { strict as assert } from "node:assert";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { GhClient } from "../github/client.ts";
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { runIssuesCommand } from "./issuesCommand.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");

const platform = getPlatform();
const schemas = loadSchemaRegistry();

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

// Level-3 headers matching `src/github/issues.test.ts` / `src/workflow/selectIssue.test.ts`'s
// convention (GitHub's Issue Form rendering, `getMarkdownSections`). References the
// repository's real `tests` validation gate so `testIssueContract` accepts it.
function issueBody(): string {
  return [
    "### Problem / Context",
    "Context text.",
    "",
    "### Goal",
    "Goal text.",
    "",
    "### Acceptance Criteria",
    "AC-01: first",
    "",
    "### In Scope",
    "included",
    "",
    "### Out of Scope",
    "excluded",
    "",
    "### Validation Gate IDs",
    "tests",
    "",
    "### Priority",
    "p2",
    "",
    "### Risk",
    "low",
  ].join("\n");
}

interface IssueSpec {
  number: number;
  createdAt?: string;
  labels?: string[];
}

function issueListJson(spec: IssueSpec): Record<string, unknown> {
  return {
    number: spec.number,
    title: `Issue ${spec.number}`,
    body: issueBody(),
    state: "OPEN",
    labels: (spec.labels ?? ["hdo:ready"]).map((name) => ({ name })),
    assignees: [],
    author: { login: "someone" },
    createdAt: spec.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://example.invalid/${spec.number}`,
  };
}

function fakeRunner(handler: (options: ProcessRunOptions) => ProcessResult): ProcessRunner {
  return { async run(options: ProcessRunOptions): Promise<ProcessResult> { return handler(options); } };
}

/** A ready, authorized, dependency-free, unclaimed fixture: every `gh` call the candidate pipeline needs. */
function makeGhRunner(specs: IssueSpec[]): { runner: ProcessRunner; calls: ProcessRunOptions[] } {
  const calls: ProcessRunOptions[] = [];
  const runner = fakeRunner((options) => {
    calls.push(options);
    const args = options.arguments ?? [];
    if (args[0] === "issue" && args[1] === "list") {
      return makeResult({ stdout: JSON.stringify(specs.map((spec) => issueListJson(spec))) });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/events"))) {
      return makeResult({
        stdout: JSON.stringify([
          [{ event: "labeled", label: { name: "hdo:ready" }, actor: { login: "authorized-actor" }, created_at: "2026-01-01T00:00:00Z" }],
        ]),
      });
    }
    if (args[0] === "api" && args.includes("graphql")) {
      return makeResult({ stdout: JSON.stringify({ data: { repository: { issue: { lastEditedAt: "" } } } }) });
    }
    if (args[0] === "api" && args.includes("--paginate") && args.some((a) => a.includes("/comments"))) {
      return makeResult({ stdout: JSON.stringify([[]]) });
    }
    throw new Error(`issuesCommand.test.ts: unscripted command ${JSON.stringify(args)}`);
  });
  return { runner, calls };
}

test("runIssuesCommand: zero candidates -> exitCode 4 and an empty candidates array", async () => {
  const { runner } = makeGhRunner([]);
  const gh = new GhClient({ runner });
  const parsed = parseArgs(["issues", "-Repository", "o/r", "-RepositoryPath", REPO_ROOT]);
  const result = await runIssuesCommand({ parsed, platform, schemas, gh });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.exitCode, 4);
});

test("runIssuesCommand: non-empty candidates -> exitCode 0, sorted (priorityRank asc, createdAt asc, number asc)", async () => {
  const { runner } = makeGhRunner([
    { number: 20, createdAt: "2026-01-01T00:00:00Z", labels: ["hdo:ready", "hdo:priority/p1"] },
    { number: 10, createdAt: "2026-01-02T00:00:00Z", labels: ["hdo:ready", "hdo:priority/p0"] },
    { number: 30, createdAt: "2025-12-01T00:00:00Z", labels: ["hdo:ready", "hdo:priority/p1"] },
  ]);
  const gh = new GhClient({ runner });
  const parsed = parseArgs(["issues", "-Repository", "o/r", "-RepositoryPath", REPO_ROOT]);
  const result = await runIssuesCommand({ parsed, platform, schemas, gh });
  assert.equal(result.exitCode, 0);
  // #10 (p0) first; then #30/#20 (both p1) ordered by createdAt asc, not by number.
  assert.deepEqual(
    result.candidates.map((c) => c.number),
    [10, 30, 20],
  );
});

test("runIssuesCommand: -Repository is passed through to `gh issue list --repo`", async () => {
  const { runner, calls } = makeGhRunner([{ number: 42 }]);
  const gh = new GhClient({ runner });
  const parsed = parseArgs(["issues", "-Repository", "acme/widgets", "-RepositoryPath", REPO_ROOT]);
  await runIssuesCommand({ parsed, platform, schemas, gh });
  const listCall = calls.find((c) => (c.arguments ?? [])[0] === "issue" && (c.arguments ?? [])[1] === "list");
  assert.ok(listCall, "expected a `gh issue list` call");
  const args = listCall!.arguments ?? [];
  const repoIndex = args.indexOf("--repo");
  assert.ok(repoIndex >= 0, "expected --repo in issue list args");
  assert.equal(args[repoIndex + 1], "acme/widgets");
});
