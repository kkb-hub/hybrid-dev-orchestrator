// Port of tests/test-lean-worker-smoke.ps1: the opt-in, REAL-Ollama smoke test for the
// lean worker. NOT a CI gate - skipped by default, the same way
// src/runners/agentStep.integration.test.ts and src/cli/configParity.test.ts skip their
// own environment-dependent cases (a `{ skip: SKIP_REASON }` computed once at module
// load, from an environment check rather than a `pwsh` probe here).
//
// Opt in with `HDO_LEAN_WORKER_SMOKE=1`, e.g.:
//   HDO_LEAN_WORKER_SMOKE=1 node --test src/workers/leanWorker/smoke.test.ts
// Optional overrides (mirroring the PS oracle's own parameters):
//   HDO_LEAN_WORKER_SMOKE_MODEL                    (default: qwen3.8:27b-q4_K_M)
//   HDO_LEAN_WORKER_SMOKE_CONTEXT_TOKENS            (default: 32768)
//   HDO_LEAN_WORKER_SMOKE_COMPACTION_CONTEXT_TOKENS (default: 4096)
//   HDO_LEAN_WORKER_SMOKE_KEEP_ARTIFACTS=1           keeps the scratch directory instead
//                                                     of deleting it on exit
//
// Scenario 1 goes through HDO's real agent-step path: `runAgentStep`
// (src/runners/agentStep.ts) is the TypeScript port of `Invoke-HdoAgentStep`, so this
// exercises the command adapter, schema validation, and credential redaction exactly the
// way `test-lean-worker-smoke.ps1` exercises them through the PS `Invoke-HdoAgentStep`.
// It does NOT go through `config/examples/ollama-lean-worker.json` (that file's
// `ollama-lean-implementer` runner already routes `implement`/`fix` to THIS port -
// `"command": "node"` with `extraArgs` starting `{hdoRoot}/src/workers/leanWorker/main.ts`,
// per ADR-0001 phase 8 exit condition (iii)) or through the config-loading/profile-merging
// layer (`Get-HdoConfig`'s TS counterpart): `buildLeanWorkerConfig` below constructs the
// already-resolved `{steps, runners}` shape directly, so this test does not depend on
// config resolution. `getExecutionPlan` (the pure TS port of `Get-HdoExecutionPlan`) is
// still run over that config, so the same planning/review-stay-cloud and
// implementation-routed-to-a-local-command-worker assertions the PS oracle makes are
// carried across unchanged.
//
// Scenario 2 drives context compaction (issue #47) with a real model, exactly like the
// oracle: the stopping condition depends on model behaviour, so the worker is launched
// directly (not through the agent-step path, whose window comes from the profile) with a
// window no profile would ever declare.
//
// CRITICAL: both scenarios launch the worker with the ASYNC child_process API
// (`execFile`, promisified, always `await`ed) - see testHarness.ts's header comment for
// why a synchronous spawn is unsafe in this suite (it would block the event loop an
// in-process stub server needs); this file has no in-process stub server of its own
// (both scenarios talk to a REAL local Ollama), so the async requirement here is about
// not blocking node:test's own event loop for the many minutes a real model can take,
// not about a deadlock - but the same async-only discipline is kept for consistency and
// because `runAgentStep`'s own `ProcessRunner` is async internally regardless.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../core/contracts/types.ts";
import { SCHEMA_NAMES, SchemaRegistry, type SchemaDocumentMap } from "../../core/contracts/schemas.ts";
import type { SchemaObject } from "../../core/contracts/validate.ts";
import { getExecutionPlan } from "../../core/config/executionPlan.ts";
import { getPlatform } from "../../platform/index.ts";
import { NodeProcessRunner } from "../../process/runner.ts";
import { runAgentStep, type AgentStepRun } from "../../runners/agentStep.ts";
import { SCHEMA_PATH, WORKER_MAIN } from "./testHarness.ts";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SCHEMAS_DIR = join(REPO_ROOT, "schemas");

/** Duplicated (not imported) from `src/cli/schemaLoader.ts`, matching
 * agentStep.integration.test.ts's own duplication of the same helper - see that file's
 * header comment for the boundary rationale (this module lives outside `src/cli/**`
 * too, so the same "don't reach into cli/" discipline applies here by extension). */
function loadTestSchemaRegistry(): SchemaRegistry {
  const documents = {} as SchemaDocumentMap;
  for (const name of SCHEMA_NAMES) {
    documents[name] = JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")) as SchemaObject;
  }
  return new SchemaRegistry(documents);
}

const HDO_LEAN_WORKER_SMOKE_ENABLED = process.env.HDO_LEAN_WORKER_SMOKE === "1";
const SKIP_REASON = HDO_LEAN_WORKER_SMOKE_ENABLED
  ? false
  : "opt-in only: requires a real local Ollama server and a loaded model. Run with " +
    "HDO_LEAN_WORKER_SMOKE=1, e.g.: HDO_LEAN_WORKER_SMOKE=1 node --test src/workers/leanWorker/smoke.test.ts";

const MODEL = process.env.HDO_LEAN_WORKER_SMOKE_MODEL ?? "qwen3.8:27b-q4_K_M";
const CONTEXT_TOKENS = Number(process.env.HDO_LEAN_WORKER_SMOKE_CONTEXT_TOKENS ?? "32768");
// Deliberately far below anything an operator would configure. The point is to reach the
// compaction threshold with a task small enough to stay a smoke test: at a realistic
// window the same task finishes in four turns without ever compacting.
const COMPACTION_CONTEXT_TOKENS = Number(process.env.HDO_LEAN_WORKER_SMOKE_COMPACTION_CONTEXT_TOKENS ?? "4096");
const KEEP_ARTIFACTS = process.env.HDO_LEAN_WORKER_SMOKE_KEEP_ARTIFACTS === "1";

// A generous ceiling for a real local model over a multi-turn tool loop plus a
// compaction summarization call; the smoke test is opt-in precisely because it can be
// this slow.
const SMOKE_TIMEOUT_MS = 30 * 60_000;

function buildLeanWorkerConfig(): JsonObject {
  return {
    steps: {
      plan: "codex-cloud-planner",
      implement: "lean-worker-node",
      review: "codex-cloud-reviewer",
      fix: "lean-worker-node",
    },
    runners: {
      "codex-cloud-planner": {
        type: "codex",
        provider: "cloud",
        command: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sandbox: "read-only",
        timeoutSeconds: 900,
        passEnvironment: [],
        extraArgs: [],
      },
      "lean-worker-node": {
        type: "command",
        provider: "ollama",
        command: process.execPath,
        model: MODEL,
        contextTokens: CONTEXT_TOKENS,
        sandbox: "workspace-write",
        timeoutSeconds: 1800,
        promptTransport: "file",
        passEnvironment: [],
        extraArgs: [
          WORKER_MAIN,
          "-PromptFile",
          "{promptFile}",
          "-OutputFile",
          "{outputFile}",
          "-SchemaFile",
          "{schemaFile}",
          "-WorkingDirectory",
          "{workingDirectory}",
          "-Model",
          "{model}",
          "-ContextTokens",
          "{contextTokens}",
        ],
      },
      "codex-cloud-reviewer": {
        type: "codex",
        provider: "cloud",
        command: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sandbox: "read-only",
        timeoutSeconds: 1200,
        passEnvironment: [],
        extraArgs: [],
      },
    },
  };
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// --- scenario 1: the real agent-step path fixes a real off-by-one bug ----------------------
// Oracle: tests/test-lean-worker-smoke.ps1:57-118.
test(
  "lean worker smoke: the agent-step path fixes a real off-by-one bug through a real local model",
  { skip: SKIP_REASON, timeout: SMOKE_TIMEOUT_MS },
  async () => {
    const schemas = loadTestSchemaRegistry();
    const smokeRoot = mkdtempSync(join(tmpdir(), "hdo-lean-worker-smoke-"));
    const smokeRepository = join(smokeRoot, "repository");
    const artifactDirectory = join(smokeRoot, "artifacts");
    try {
      mkdirSync(smokeRepository, { recursive: true });
      mkdirSync(artifactDirectory, { recursive: true });
      runGit(["init", "--quiet"], smokeRepository);
      runGit(["config", "user.email", "hdo-tests@example.invalid"], smokeRepository);
      runGit(["config", "user.name", "HDO Tests"], smokeRepository);
      runGit(["config", "commit.gpgSign", "false"], smokeRepository);

      // A real off-by-one so the worker has to read before it edits rather than being
      // able to produce a correct file from the prompt alone.
      writeFileSync(
        join(smokeRepository, "calc.ps1"),
        [
          "function Get-Sum {",
          "    param([int[]]$Values)",
          "    $total = 0",
          "    for ($i = 0; $i -lt $Values.Count - 1; $i++) { $total += $Values[$i] }",
          "    return $total",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      runGit(["add", "--", "calc.ps1"], smokeRepository);
      runGit(["commit", "--quiet", "-m", "baseline"], smokeRepository);

      const config = buildLeanWorkerConfig();
      const plan = getExecutionPlan(config, new Date().toISOString());
      assert.ok(plan.steps.plan.provider === "cloud" && plan.steps.review.provider === "cloud", "planning and review stay on the cloud provider");
      assert.ok(
        plan.steps.implement.provider === "ollama" && plan.steps.implement.type === "command",
        "implementation is routed to the local command worker",
      );
      assert.equal(Number(plan.steps.implement.contextTokens), CONTEXT_TOKENS, `the profile requests the VRAM-friendly ${CONTEXT_TOKENS}-token window`);

      const platform = getPlatform();
      const processRunner = new NodeProcessRunner({ platform });
      const run: AgentStepRun = { id: `lean-worker-smoke-${Date.now()}`, state: "IMPLEMENTING" };
      const result = await runAgentStep({
        config,
        run,
        step: "implement",
        iteration: 1,
        workingDirectory: smokeRepository,
        prompt:
          "The function Get-Sum in calc.ps1 has an off-by-one bug: the loop stops one element early, so the last value is never added. Read the file, fix the loop bound, and save it.",
        artifactDirectory,
        outputSchema: "worker-result",
        schemas,
        schemasDir: SCHEMAS_DIR,
        hdoRoot: REPO_ROOT,
        platform,
        processRunner,
      });

      assert.equal(result.status, "succeeded", "the agent step reports success");
      assert.equal(result.process.exitCode, 0, "the worker process exits zero");

      const fixed = readFileSync(join(smokeRepository, "calc.ps1"), "utf8");
      assert.ok(!/\$Values\.Count - 1/.test(fixed), "the off-by-one loop bound is gone");
      assert.ok(/\$i -lt \$Values\.Count/.test(fixed), "the loop bound now covers the final element");

      // runAgentStep already schema-validates before returning, so reaching here with a
      // populated output means the structured contract held end to end.
      const output = result.output as { schemaVersion: number; summary: string };
      assert.equal(output.schemaVersion, 1, "the worker returns a schema-valid structured result");
      assert.notEqual(output.summary, "", "the structured result carries a summary");

      const diffNames = execFileSync("git", ["diff", "--name-only"], { cwd: smokeRepository, encoding: "utf8" }).trim();
      assert.ok(diffNames.includes("calc.ps1"), "git sees exactly the expected file change");
      const statusLines = execFileSync("git", ["status", "--porcelain"], { cwd: smokeRepository, encoding: "utf8" })
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      assert.equal(statusLines.length, 1, "the worker did not touch any other file");
    } finally {
      if (KEEP_ARTIFACTS) process.stdout.write(`artifacts retained at ${smokeRoot}\n`);
      else rmSync(smokeRoot, { recursive: true, force: true });
    }
  },
);

// --- scenario 2: context compaction against a real model ------------------------------------
// Oracle: tests/test-lean-worker-smoke.ps1:120-178. Three files rather than one, so the
// tool loop cannot finish inside a single exchange, and a window small enough that the
// threshold is crossed while the work is unfinished. The worker is started directly here:
// the agent step takes its window from the profile, and the whole point of this scenario
// is a window no profile would ever declare.
test(
  "lean worker smoke: context compaction against a real model keeps making progress after a mid-task history rewrite",
  { skip: SKIP_REASON, timeout: SMOKE_TIMEOUT_MS },
  async () => {
    const smokeRoot = mkdtempSync(join(tmpdir(), "hdo-lean-worker-smoke-compaction-"));
    try {
      const compactionWorkspace = join(smokeRoot, "compaction");
      mkdirSync(compactionWorkspace, { recursive: true });
      for (const moduleName of ["a", "b", "c"]) {
        const upper = moduleName.toUpperCase();
        const lines: string[] = [`# Module ${upper} - numeric helpers for the reporting pipeline.`, ""];
        // Padding, so reading a whole file costs real context and the model is pushed
        // toward the narrow reads the system prompt asks for.
        for (let i = 1; i <= 25; i++) lines.push(`function Get-${upper}Constant${i} { return ${i * 7} }`);
        lines.push(
          "",
          `function Get-${upper}Total {`,
          "    param([int[]]$Values)",
          "    $total = 0",
          "    for ($i = 0; $i -lt $Values.Count - 1; $i++) { $total += $Values[$i] }",
          "    return $total",
          "}",
          "",
        );
        for (let i = 1; i <= 25; i++) lines.push(`function Get-${upper}Label${i} { return '${moduleName}-label-${i}' }`);
        writeFileSync(join(compactionWorkspace, `module-${moduleName}.ps1`), lines.join("\n") + "\n", "utf8");
      }

      const compactionPrompt = join(smokeRoot, "compaction-prompt.md");
      const compactionOutput = join(smokeRoot, "compaction-result.json");
      writeFileSync(
        compactionPrompt,
        [
          'Three files in this workspace each define a Get-*Total function whose for-loop bound is',
          'off by one: it uses "$i -lt $Values.Count - 1", so the last element is never added.',
          "",
          "Fix all three files: module-a.ps1, module-b.ps1, module-c.ps1. In each one, change the",
          'loop bound to "$i -lt $Values.Count". Change nothing else.',
        ].join("\n"),
        "utf8",
      );

      const argv = [
        WORKER_MAIN,
        "-PromptFile",
        compactionPrompt,
        "-OutputFile",
        compactionOutput,
        "-SchemaFile",
        SCHEMA_PATH,
        "-WorkingDirectory",
        compactionWorkspace,
        "-Model",
        MODEL,
        "-ContextTokens",
        String(COMPACTION_CONTEXT_TOKENS),
        "-CompactAtPercent",
        "35",
        "-KeepRecentMessages",
        "4",
        "-MaxTurns",
        "20",
      ];

      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      try {
        const result = await execFileAsync(process.execPath, argv, {
          encoding: "utf8",
          timeout: SMOKE_TIMEOUT_MS - 60_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const execError = error as { code?: number; stdout?: string; stderr?: string };
        exitCode = typeof execError.code === "number" ? execError.code : 1;
        stdout = execError.stdout ?? "";
        stderr = execError.stderr ?? "";
      }
      process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);

      const thresholdMatch = stdout.match(
        /compaction: turn=(\d+) reason=threshold prompt_tokens_before~\d+ prompt_tokens_after~\d+ messages=\d+->\d+/,
      );
      const finalMatch = stdout.match(/final: .*turns=(\d+) .*compactions=(\d+)/);

      assert.equal(exitCode, 0, "the worker completes a multi-file task inside a window too small to hold its history");
      assert.ok(thresholdMatch, "the reported prompt token count triggers a compaction, with the turn and both token counts in the diagnostic");
      assert.ok(
        Boolean(finalMatch) && Boolean(thresholdMatch) && Number(finalMatch?.[1]) > Number(thresholdMatch?.[1]),
        "the tool loop keeps making progress after its history was rewritten",
      );
      assert.ok(Boolean(finalMatch) && Number(finalMatch?.[2]) >= 1, "the final line reports how many compactions the run needed");

      for (const moduleName of ["a", "b", "c"]) {
        const content = readFileSync(join(compactionWorkspace, `module-${moduleName}.ps1`), "utf8");
        assert.ok(!content.includes("$Values.Count - 1"), `every file is fixed even though the history was compacted mid-task (module-${moduleName}.ps1)`);
      }
      const compactionResult = JSON.parse(readFileSync(compactionOutput, "utf8")) as { schemaVersion: number; summary: string };
      assert.equal(compactionResult.schemaVersion, 1, "the final report is still schema-shaped after the history was reduced");
      assert.notEqual(compactionResult.summary, "", "the final report carries a summary written from the compacted state");
    } finally {
      if (KEEP_ARTIFACTS) process.stdout.write(`artifacts retained at ${smokeRoot}\n`);
      else rmSync(smokeRoot, { recursive: true, force: true });
    }
  },
);
