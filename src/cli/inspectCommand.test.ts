// Tests for `runInspectCommand` (hdo.ps1's `inspect` case port, hdo.ps1:84-90). No
// real network or `gh` binary - `GhClient` is constructed over a scripted fake
// `ProcessRunner` (the pattern `src/workflow/selectIssue.test.ts` and
// `src/github/issues.test.ts` already use), while `git` is the REAL repository's own
// `GitClient` (real `git` on PATH, no fixture repo needed - mirrors
// `statusCommand.test.ts`'s "real environment" pattern).
import { strict as assert } from "node:assert";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { GhClient } from "../github/client.ts";
import { getPlatform } from "../platform/index.ts";
import { parseArgs } from "./args.ts";
import { runInspectCommand } from "./inspectCommand.ts";
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

function fakeRunner(handler: (options: ProcessRunOptions) => ProcessResult): ProcessRunner {
  return { async run(options: ProcessRunOptions): Promise<ProcessResult> { return handler(options); } };
}

interface IssueSpec {
  number: number;
  body: string;
  labels?: string[];
}

function issueViewJson(spec: IssueSpec): Record<string, unknown> {
  return {
    number: spec.number,
    title: `Issue ${spec.number}`,
    body: spec.body,
    state: "OPEN",
    labels: (spec.labels ?? ["hdo:ready"]).map((name) => ({ name })),
    assignees: [],
    milestone: null,
    author: { login: "someone" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://example.invalid/${spec.number}`,
    comments: [],
  };
}

function issueBody(gateId: string): string {
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
    gateId,
    "",
    "### Priority",
    "p2",
    "",
    "### Risk",
    "low",
  ].join("\n");
}

function makeGhRunner(spec: IssueSpec): GhClient {
  return new GhClient({
    runner: fakeRunner((options) => {
      const args = options.arguments ?? [];
      if (args[0] === "issue" && args[1] === "view") {
        return makeResult({ stdout: JSON.stringify(issueViewJson(spec)) });
      }
      throw new Error(`inspectCommand.test.ts: unscripted command ${JSON.stringify(args)}`);
    }),
  });
}

test("runInspectCommand: throws 'inspect requires -Issue <number>.' when -Issue is missing", async () => {
  const parsed = parseArgs(["inspect", "-RepositoryPath", REPO_ROOT]);
  await assert.rejects(
    runInspectCommand({ parsed, platform, schemas }),
    (error: unknown) => error instanceof Error && error.message === "inspect requires -Issue <number>.",
  );
});

test("runInspectCommand: throws 'inspect requires -Issue <number>.' when -Issue is 0 or negative", async () => {
  const parsedZero = parseArgs(["inspect", "-Issue", "0", "-RepositoryPath", REPO_ROOT]);
  await assert.rejects(
    runInspectCommand({ parsed: parsedZero, platform, schemas }),
    (error: unknown) => error instanceof Error && error.message === "inspect requires -Issue <number>.",
  );
  const parsedNegative = parseArgs(["inspect", "-Issue", "-3", "-RepositoryPath", REPO_ROOT]);
  await assert.rejects(
    runInspectCommand({ parsed: parsedNegative, platform, schemas }),
    (error: unknown) => error instanceof Error && error.message === "inspect requires -Issue <number>.",
  );
});

test("runInspectCommand: output key order is issue, contract, validation", async () => {
  const gh = makeGhRunner({ number: 7, body: issueBody("tests") });
  const parsed = parseArgs(["inspect", "-Issue", "7", "-Repository", "o/r", "-RepositoryPath", REPO_ROOT]);
  const result = await runInspectCommand({ parsed, platform, schemas, gh });
  assert.deepEqual(Object.keys(result), ["issue", "contract", "validation"]);
  assert.equal(result.issue.number, 7);
  assert.equal(result.contract.issue.title, "Issue 7");
});

test("runInspectCommand: does not pass a project contract to Test-HdoIssueContract (unknown gate id is not rejected)", async () => {
  // If a project contract WERE loaded and passed (this repository's own
  // `.hdo/project.json` only knows gate ids like `tests`/`schemas`), an Issue
  // referencing a made-up gate id would fail with "Issue references unknown
  // validation gate '<id>'." PS's `inspect` case calls `Test-HdoIssueContract`
  // WITHOUT `-ProjectContract` (hdo.ps1:89), so that check must never fire here.
  const gh = makeGhRunner({ number: 9, body: issueBody("this-gate-id-does-not-exist-anywhere") });
  const parsed = parseArgs(["inspect", "-Issue", "9", "-Repository", "o/r", "-RepositoryPath", REPO_ROOT]);
  const result = await runInspectCommand({ parsed, platform, schemas, gh });
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation.errors));
  assert.deepEqual(result.validation.errors, []);
});
