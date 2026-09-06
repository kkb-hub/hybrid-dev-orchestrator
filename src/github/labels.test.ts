// Fake-runner tests for the Sync-HdoLabels port (GitHub.ps1:640-697). No real network
// or `gh`/`git` binary.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import type { JsonObject } from "../core/contracts/types.ts";
import type { ConfigHost } from "../core/config/validate.ts";
import { deepMergeConfig } from "../core/config/merge.ts";
import type { LabelCatalog, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { getPlatform } from "../platform/index.ts";
import { GitClient } from "../git/index.ts";
import { GhClient } from "./client.ts";
import { syncLabels } from "./labels.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..", "..");
const DEFAULT_CONFIG_PATH = resolvePath(REPO_ROOT, "config", "hdo.default.json");

function loadDefaultConfig(): JsonObject {
  return JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as JsonObject;
}

/**
 * A minimal, resolved-looking valid config for `validateConfiguration` (same
 * strategy as `src/core/config/validate.test.ts`'s `buildValidConfig`): the real
 * `config/hdo.default.json` with its own active profile ("claude-only") merged in,
 * plus test-friendly absolute paths. `profiles` keeps the one real profile so the
 * dynamic route-label generation ("hdo:route/claude-only") has something to iterate.
 */
function validConfig(): ResolvedHdoConfig {
  const raw = loadDefaultConfig();
  const profileName = raw.activeProfile as string;
  const profiles = raw.profiles as JsonObject;
  const merged = deepMergeConfig(raw, profiles[profileName] as JsonObject);
  return {
    ...merged,
    repositoryPath: "/repo",
    projectContractPath: "/repo/.hdo/project.json",
    paths: { worktreeRoot: "/data/worktrees", artifactRoot: "/data/runs" },
  } as unknown as ResolvedHdoConfig;
}

// Fails validateConfiguration: paths.worktreeRoot is required and left empty here.
function invalidConfig(): ResolvedHdoConfig {
  const config = validConfig();
  config.paths.worktreeRoot = "";
  return config;
}

const permissiveHost: ConfigHost = {
  pathEquals: (a, b) => a === b,
  isPathWithinRoot: (child, root) => {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return child !== root && child.startsWith(prefix);
  },
};

const smallCatalog: LabelCatalog = {
  staticLabels: [
    { name: "hdo:ready", color: "1F883D", description: "ready" },
    { name: "hdo:skip", color: "6E7781", description: "skip" },
  ],
  dynamicLabels: [{ prefix: "hdo:route/", color: "5319E7", descriptionTemplate: "Route: {value}" }],
};

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

function makeGitAndGh(runner: ProcessRunner): { gh: GhClient; git: GitClient } {
  const platform = getPlatform();
  return { gh: new GhClient({ runner }), git: new GitClient({ runner, platform }) };
}

test("the valid config fixture itself passes validateConfiguration (sanity check for the tests below)", async () => {
  // Same "no gh calls happen unless configuration is valid" property, run in reverse:
  // this must NOT throw, proving the fixture is not accidentally exercising the
  // invalid-configuration short-circuit for every test below.
  const runner: ProcessRunner = { async run() { return makeResult({ stdout: JSON.stringify([]) }); } };
  const { gh, git } = makeGitAndGh(runner);
  await syncLabels(gh, git, validConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r" });
});

test("syncLabels: rejects an invalid configuration before contacting GitHub at all", async () => {
  let callCount = 0;
  const runner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      callCount++;
      return makeResult();
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  await assert.rejects(
    () => syncLabels(gh, git, invalidConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r" }),
    (error: unknown) => error instanceof Error && error.message.startsWith("Cannot synchronize labels with invalid configuration: "),
  );
  assert.equal(callCount, 0, "no gh call should have been made once configuration validation failed");
});

test("syncLabels: apply=true creates every missing catalog + dynamic-route label with the right color/description/--force", async () => {
  const createCalls: string[][] = [];
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") {
        return makeResult({ stdout: JSON.stringify([]) });
      }
      if (args[0] === "label" && args[1] === "create") {
        createCalls.push(args);
        return makeResult({ exitCode: 0 });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  const result = await syncLabels(gh, git, validConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r", apply: true });

  assert.equal(result.repository, "o/r");
  assert.equal(result.apply, true);
  // 2 static labels + 1 dynamic route label (one profile: "claude-only").
  assert.equal(result.labels.length, 3);
  assert.ok(result.labels.every((label) => label.missing && label.applied));
  assert.equal(createCalls.length, 3);

  const readyCall = createCalls.find((call) => call[2] === "hdo:ready");
  assert.ok(readyCall);
  assert.equal(readyCall![readyCall!.indexOf("--color") + 1], "1F883D");
  assert.equal(readyCall![readyCall!.indexOf("--description") + 1], "ready");
  assert.ok(readyCall!.includes("--force"));

  const routeCall = createCalls.find((call) => call[2] === "hdo:route/claude-only");
  assert.ok(routeCall);
  assert.equal(routeCall![routeCall!.indexOf("--description") + 1], "Route: claude-only");
});

test("syncLabels: apply=false (default) reports missing labels without calling gh label create", async () => {
  let createCalls = 0;
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") return makeResult({ stdout: JSON.stringify([]) });
      if (args[0] === "label" && args[1] === "create") {
        createCalls++;
        return makeResult({ exitCode: 0 });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  const result = await syncLabels(gh, git, validConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r" });
  assert.equal(result.apply, false);
  assert.equal(createCalls, 0);
  assert.ok(result.labels.every((label) => label.applied === false));
  assert.ok(result.labels.every((label) => label.missing === true));
});

test("syncLabels: a label that already exists on the repository is reported as not missing", async () => {
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") {
        return makeResult({ stdout: JSON.stringify([{ name: "hdo:ready", color: "1F883D", description: "ready" }]) });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  const result = await syncLabels(gh, git, validConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r" });
  const ready = result.labels.find((label) => label.name === "hdo:ready");
  assert.ok(ready);
  assert.equal(ready!.missing, false);
});

test("syncLabels: an existing label differing only by case is still reported as not missing (PowerShell -notcontains is case-insensitive)", async () => {
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") {
        return makeResult({ stdout: JSON.stringify([{ name: "HDO:READY", color: "1F883D", description: "ready" }]) });
      }
      return makeResult({ exitCode: 1, stderr: `unhandled: ${args.join(" ")}` });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  const result = await syncLabels(gh, git, validConfig(), permissiveHost, smallCatalog, "/repo", { repository: "o/r" });
  const ready = result.labels.find((label) => label.name === "hdo:ready");
  assert.ok(ready);
  assert.equal(ready!.missing, false);
});

test("syncLabels: catalog label names are renamed to their configured github.labels.* override", async () => {
  const config = validConfig();
  config.github.labels.ready = "hdo:custom-ready";
  const runner: ProcessRunner = {
    async run(options: ProcessRunOptions): Promise<ProcessResult> {
      const args = options.arguments ?? [];
      if (args[0] === "label" && args[1] === "list") return makeResult({ stdout: JSON.stringify([]) });
      return makeResult({ exitCode: 0 });
    },
  };
  const { gh, git } = makeGitAndGh(runner);
  const result = await syncLabels(gh, git, config, permissiveHost, smallCatalog, "/repo", { repository: "o/r" });
  assert.ok(result.labels.some((label) => label.name === "hdo:custom-ready"));
  assert.ok(!result.labels.some((label) => label.name === "hdo:ready"));
});
