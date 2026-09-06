// End-to-end tests of `runLabelsCommand` against the REAL environment (real
// filesystem, real config/labels.json, a throwaway temp git repository as
// -RepositoryPath) with a fake `gh` (`ProcessRunner`) - mirrors hdo.ps1's `labels`
// case (hdo.ps1:147-150) and the `statusCommand.test.ts` `-Config` overlay pattern.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { getPlatform } from "../platform/index.ts";
import { GhClient } from "../github/client.ts";
import { GitClient } from "../git/index.ts";
import { NodeProcessRunner } from "../process/runner.ts";
import { runLabelsCommand } from "./labelsCommand.ts";
import { parseArgs } from "./args.ts";
import { loadSchemaRegistry } from "./schemaLoader.ts";

const GIT_AVAILABLE = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const SKIP_REASON = GIT_AVAILABLE ? false : "git is not on PATH";

const platform = getPlatform();
const schemas = loadSchemaRegistry();

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hdo-labelsCommand-test-"));
  runGit(["init", "-q"], dir);
  runGit(["config", "core.autocrlf", "false"], dir);
  writeFileSync(join(dir, "a.txt"), "x", "utf8");
  runGit(["add", "-A"], dir);
  runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], dir);
  return dir;
}

function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

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

/** No labels exist yet on the fake repository; `label create` always succeeds. */
function makeGh(createCalls: string[][]): GhClient {
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") return makeResult({ stdout: JSON.stringify([]) });
      if (args[0] === "label" && args[1] === "create") {
        createCalls.push(args);
        return makeResult({ exitCode: 0 });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  return new GhClient({ runner });
}

test("runLabelsCommand: apply=false (default) reports missing labels without calling gh label create", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  try {
    const createCalls: string[][] = [];
    const gh = makeGh(createCalls);
    const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
    const parsed = parseArgs(["labels", "-Repository", "o/r", "-RepositoryPath", repo]);
    const result = await runLabelsCommand({ parsed, platform, schemas, gh, git });

    assert.equal(result.repository, "o/r");
    assert.equal(result.apply, false);
    assert.equal(createCalls.length, 0);
    assert.ok(result.labels.length > 0);
    assert.ok(result.labels.every((label) => label.applied === false));
  } finally {
    removeTree(repo);
  }
});

test("runLabelsCommand: -Apply creates every missing catalog label via gh label create", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  try {
    const createCalls: string[][] = [];
    const gh = makeGh(createCalls);
    const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
    const parsed = parseArgs(["labels", "-Repository", "o/r", "-RepositoryPath", repo, "-Apply"]);
    const result = await runLabelsCommand({ parsed, platform, schemas, gh, git });

    assert.equal(result.apply, true);
    assert.ok(createCalls.length > 0);
    assert.ok(result.labels.every((label) => label.applied === true));
  } finally {
    removeTree(repo);
  }
});

test("runLabelsCommand: -WhatIf without -Apply is byte-identical to plain labels (no gh label create, no What-if line)", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  try {
    const plainCalls: string[][] = [];
    const ghPlain = makeGh(plainCalls);
    const gitPlain = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
    const parsedPlain = parseArgs(["labels", "-Repository", "o/r", "-RepositoryPath", repo]);
    const plainResult = await runLabelsCommand({ parsed: parsedPlain, platform, schemas, gh: ghPlain, git: gitPlain });

    const whatIfCalls: string[][] = [];
    const ghWhatIf = makeGh(whatIfCalls);
    const gitWhatIf = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
    const lines: string[] = [];
    const parsedWhatIf = parseArgs(["labels", "-Repository", "o/r", "-RepositoryPath", repo, "-WhatIf"]);
    const whatIfResult = await runLabelsCommand({
      parsed: parsedWhatIf,
      platform,
      schemas,
      gh: ghWhatIf,
      git: gitWhatIf,
      shouldProcessSink: (line) => lines.push(line),
    });

    assert.deepEqual(whatIfResult, plainResult);
    assert.equal(whatIfCalls.length, 0);
    assert.deepEqual(lines, []);
  } finally {
    removeTree(repo);
  }
});

test("runLabelsCommand: -Apply -WhatIf writes one ShouldProcess line per label, calls no gh label create, and every applied stays false", { skip: SKIP_REASON }, async () => {
  const repo = initRepo();
  try {
    const createCalls: string[][] = [];
    const gh = makeGh(createCalls);
    const git = new GitClient({ runner: new NodeProcessRunner({ platform }), platform });
    const lines: string[] = [];
    const parsed = parseArgs(["labels", "-Repository", "o/r", "-RepositoryPath", repo, "-Apply", "-WhatIf"]);
    const result = await runLabelsCommand({
      parsed,
      platform,
      schemas,
      gh,
      git,
      shouldProcessSink: (line) => lines.push(line),
    });

    assert.equal(result.apply, true);
    assert.equal(createCalls.length, 0, "gh label create must never be called under -Apply -WhatIf");
    assert.ok(result.labels.every((label) => label.applied === false));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.startsWith('What if: Performing the operation "Create or update" on target "o/r label \'')));
    assert.equal(lines.length, result.labels.length);
  } finally {
    removeTree(repo);
  }
});
