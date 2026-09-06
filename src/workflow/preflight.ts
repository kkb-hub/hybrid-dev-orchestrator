// Port of `Test-HdoEnvironment` (Workflow.ps1:13-153): the read-write-aware
// environment probe behind both the `doctor` CLI command and the preflight half of
// `run`/`run -DryRun`. `src/workflow/**` is a host module (ADR-0001 phase 5 plan §2
// boundary): everything that touches the filesystem or spawns a process is reached
// only through the injected `PlatformAdapter`/`ProcessRunner`/`GitClient`/`GhClient`,
// never directly (this file itself only touches `node:fs` for the `paths:writable`
// probe and `node:crypto`/`node:path` for its temp filename, exactly like the
// PowerShell original's `New-Item`/`[IO.File]::WriteAllText`/`[guid]::NewGuid()`).
//
// Issue #35 / `-CommandType Application`: every `Get-Command <name> -CommandType
// Application` call in the PowerShell original is ported here as
// `platform.resolveExecutable(name)`, which - like `-CommandType Application` -
// never resolves a `.ps1` shim (see `src/platform/types.ts`'s `resolveExecutable`
// doc comment).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import type { JsonObject, JsonValue } from "../core/contracts/types.ts";
import { getValue } from "../core/config/value.ts";
import { getExecutionPlan } from "../core/config/executionPlan.ts";
import type { SchemaRegistry } from "../core/contracts/schemas.ts";
import { protectText } from "../core/process/redact.ts";
import type { ProcessRunner } from "../core/process/types.ts";
import { asNumber, asString, equalsIgnoreCase, hdoArrayCount, hdoArrayItems, inIgnoreCase } from "../core/runners/psSemantics.ts";
import type { PlatformAdapter } from "../platform/types.ts";
import { GitClient } from "../git/index.ts";
import { GhClient } from "../github/client.ts";
import { resolveOllamaContextModel } from "../runners/ollamaContextModel.ts";
import { loadProjectContract } from "./projectContract.ts";

export interface PreflightOptions {
  /** Resolved config (`repositoryPath`, `resolvedProfile`, `projectContractPath`, `paths.*`, `steps`, `runners`). */
  config: JsonObject;
  readOnly: boolean;
  /** `resolveExecutable` (Get-Command), comparable paths. */
  platform: PlatformAdapter;
  /** `ollama list`/`ollama create` (the latter via `resolveOllamaContextModel`). */
  processRunner: ProcessRunner;
  /** `repositoryRoot` (Get-HdoRepositoryRoot). */
  git: GitClient;
  /** `exec(['auth','status'], repositoryPath, 60)`. */
  gh: GhClient;
  schemas: SchemaRegistry;
  /** `checkedAt`/the execution plan's `generatedAt`; default `new Date().toISOString()`. */
  now?: () => string;
}

export interface PreflightCheck {
  name: string;
  status: "pass" | "fail" | "warning" | "skipped";
  required: boolean;
  message: string;
}

export interface PreflightResult {
  schemaVersion: 1;
  ok: boolean;
  readOnly: boolean;
  profile: JsonValue;
  checkedAt: string;
  checks: PreflightCheck[];
}

/** `Add-HdoPreflightCheck` (Workflow.ps1:1-11): every message is redacted via `protectText` before being recorded. */
function addCheck(
  checks: PreflightCheck[],
  name: string,
  status: PreflightCheck["status"],
  message: string,
  required = true,
): void {
  checks.push({ name, status, required, message: protectText(message) });
}

/**
 * `[regex]::Escape` port (ADR-0001 phase 5 plan §7 risk 7): escapes JS regex
 * metacharacters. .NET additionally escapes whitespace and `#`; irrelevant here
 * since this is only ever used to build `^<model>\s`, which tolerates that gap.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Port of `Test-HdoEnvironment` (Workflow.ps1:13-153). Ports the checks in the exact
 * order and with the exact message strings of the PowerShell original; see the
 * module comment and ADR-0001 phase 5 plan §300-343 for the check-by-check mapping.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const { config, readOnly, platform, processRunner, git, gh, schemas } = options;
  const now = options.now ?? ((): string => new Date().toISOString());
  const checks: PreflightCheck[] = [];
  const repositoryPath = asString(config.repositoryPath);

  // 1: command:git, command:gh
  const gitCommand = platform.resolveExecutable("git");
  addCheck(checks, "command:git", gitCommand ? "pass" : "fail", gitCommand ?? "git was not found.");
  const ghCommand = platform.resolveExecutable("gh");
  addCheck(checks, "command:gh", ghCommand ? "pass" : "fail", ghCommand ?? "gh was not found.");

  // 1b: node-version (ADR-0001 Migration strategy phase 7 plan §1 Q5). ADR-0001's
  // revisit condition #2 already measures "the node-version check's failure rate"
  // from each run's `environment.json` artifact, but no such check was ever
  // implemented - phase 7 is the cut-over that makes `node` the CLI entry point, so
  // this is where it lands. `required: false`: an old/missing `node` does not stop
  // `run` (there is nothing here that depends on it today), it is only a readiness
  // signal, mirrored byte-for-byte in `Test-HdoEnvironment` (Workflow.ps1) so
  // `doctorParity.test.ts` sees the same check from both implementations.
  const nodeCommand = platform.resolveExecutable("node");
  if (!nodeCommand) {
    addCheck(checks, "node-version", "warning", "node was not found.", false);
  } else {
    const nodeVersionResult = await processRunner.run({
      command: "node",
      arguments: ["--version"],
      workingDirectory: repositoryPath,
      timeoutSeconds: 60,
    });
    const nodeVersionOutput = nodeVersionResult.stdout.trim();
    const nodeVersionMatch = nodeVersionResult.exitCode === 0 ? /^v(\d+)\./.exec(nodeVersionOutput) : null;
    if (!nodeVersionMatch) {
      addCheck(checks, "node-version", "warning", "node --version could not be determined.", false);
    } else {
      const nodeMajor = Number(nodeVersionMatch[1]);
      if (nodeMajor >= 24) {
        addCheck(checks, "node-version", "pass", nodeVersionOutput, false);
      } else {
        addCheck(checks, "node-version", "warning", `Node ${nodeVersionOutput} is older than the required 24 LTS.`, false);
      }
    }
  }

  // 2: git:repository (only when git resolved)
  if (gitCommand) {
    try {
      const root = await git.repositoryRoot(repositoryPath);
      addCheck(checks, "git:repository", "pass", root);
    } catch (error) {
      addCheck(checks, "git:repository", "fail", (error as Error).message);
    }
  }

  // 3: github:authentication (only when gh resolved)
  if (ghCommand) {
    const auth = await gh.exec(["auth", "status"], repositoryPath, 60);
    addCheck(
      checks,
      "github:authentication",
      auth.exitCode === 0 ? "pass" : "fail",
      auth.exitCode === 0 ? "GitHub CLI authentication is valid." : auth.stderr.trim(),
    );
  }

  // 4: project-contract, then one `gate:<id>` check per validation gate (Issue #8,
  // Workflow.ps1 new block after :44; WP-P mirrors this in Test-HdoEnvironment).
  // `required: false` / `warning` (not `fail`) is a deliberate orchestrator decision
  // (plan §8 Q1): a `fail` would make `run` stop at PREFLIGHT_FAILED for a gate whose
  // command cannot be resolved, which would (a) change today's behaviour more than
  // the Issue asks for and (b) make the Issue #16 runtime "setup failure" guard
  // unreachable in normal operation (TOCTOU only). `doctor` still surfaces the
  // problem via this check; the run-time classification in `src/core/workflow/
  // gates.ts` is what actually protects a run against a missing gate command.
  try {
    const projectContract = loadProjectContract(asString(config.projectContractPath), schemas);
    const gateCount = hdoArrayCount(getValue(projectContract, "validationGates", []));
    addCheck(checks, "project-contract", "pass", `${gateCount} validation gate(s) defined.`);
    for (const gate of hdoArrayItems(getValue(projectContract, "validationGates", []))) {
      const gateId = asString(getValue(gate, "id"));
      const gateCommand = asString(getValue(gate, "command"));
      const resolvedGateCommand = platform.resolveExecutable(gateCommand);
      addCheck(
        checks,
        `gate:${gateId}`,
        resolvedGateCommand ? "pass" : "warning",
        resolvedGateCommand
          ? `Validation gate '${gateId}' command '${gateCommand}' resolves to ${resolvedGateCommand}.`
          : `Validation gate '${gateId}' command '${gateCommand}' was not found. The gate would be recorded as a setup failure at run time.`,
        false,
      );
    }
  } catch (error) {
    addCheck(checks, "project-contract", "fail", (error as Error).message);
  }

  // 5: execution plan + runner checks
  const plan = getExecutionPlan(config, now());
  let hasOllama = false;
  for (const runnerName of Object.keys(plan.runners)) {
    const runner = plan.runners[runnerName];
    const commandName = asString(runner.command);
    const resolvedCommand = platform.resolveExecutable(commandName);
    addCheck(
      checks,
      `runner:${runnerName}`,
      resolvedCommand ? "pass" : "fail",
      resolvedCommand
        ? `${asString(runner.type)} command '${commandName}' is available.`
        : `Runner command '${commandName}' was not found.`,
    );
    // The Claude adapter passes the normalized JSON schema inline via --json-schema
    // (the CLI accepts no file path there). cmd.exe batch shims re-parse arguments
    // and cap the command line at 8191 characters, so an npm .cmd shim can corrupt
    // or truncate that argument even though a native install works.
    if (
      equalsIgnoreCase(asString(runner.type), "claude") &&
      resolvedCommand &&
      inIgnoreCase(extname(resolvedCommand), [".cmd", ".bat"])
    ) {
      addCheck(
        checks,
        `runner:${runnerName}:shim`,
        "warning",
        `Claude command '${commandName}' resolves to the batch shim '${resolvedCommand}'. cmd.exe argument re-parsing can corrupt the inline --json-schema argument; prefer a native claude install.`,
        false,
      );
    }
    if (equalsIgnoreCase(asString(getValue(runner, "provider", "cloud"), "cloud"), "ollama")) hasOllama = true;
  }

  // 6: Ollama block
  if (hasOllama) {
    const ollamaCommand = platform.resolveExecutable("ollama");
    if (!ollamaCommand) {
      addCheck(
        checks,
        "provider:ollama",
        "fail",
        "Ollama is selected by the active profile but the ollama command was not found.",
      );
    } else {
      const list = await processRunner.run({
        command: "ollama",
        arguments: ["list"],
        workingDirectory: repositoryPath,
        timeoutSeconds: 60,
      });
      if (list.exitCode !== 0) {
        addCheck(checks, "provider:ollama", "fail", `Ollama is selected but unavailable: ${list.stderr.trim()}`);
      } else {
        addCheck(checks, "provider:ollama", "pass", "Ollama is available.");
        for (const runnerName of Object.keys(plan.runners)) {
          const runner = plan.runners[runnerName];
          if (!equalsIgnoreCase(asString(getValue(runner, "provider", "cloud"), "cloud"), "ollama")) continue;
          const model = asString(runner.model);
          const modelPattern = new RegExp(`^${escapeRegExp(model)}\\s`);
          const found = list.stdout.split(/\r?\n/).some((line) => modelPattern.test(line));
          addCheck(
            checks,
            `ollama-model:${model}`,
            found ? "pass" : "fail",
            found ? `Model '${model}' is installed.` : `Model '${model}' is not installed. HDO will not pull it automatically.`,
          );
          // Ollama's runtime context window (commonly far below the model's
          // advertised maximum) is invisible until a real task exceeds it, so a
          // claude+ollama runner that requests contextTokens gets its derived
          // context model built here too: a bad value fails doctor instead of a
          // real implement/fix run. This still writes to the local Ollama model
          // store, so -ReadOnly (a documented no-mutation guarantee for
          // doctor/run -DryRun) must skip it like the paths:writable probe below.
          const contextTokens = asNumber(getValue(runner, "contextTokens", 0), 0);
          if (equalsIgnoreCase(asString(runner.type), "claude") && found && contextTokens <= 0) {
            addCheck(
              checks,
              `ollama-context:${runnerName}`,
              "warning",
              `Claude/Ollama runner '${runnerName}' does not set contextTokens, so HDO cannot bound the conversation to the model's real context window. Short tasks succeed, but longer agentic runs will fail once the transcript outgrows Ollama's default context.`,
              false,
            );
          } else if (equalsIgnoreCase(asString(runner.type), "claude") && found && contextTokens > 0) {
            if (readOnly) {
              addCheck(
                checks,
                `ollama-context:${runnerName}`,
                "skipped",
                `Read-only preflight does not create the ${contextTokens}-token derived Ollama model.`,
                false,
              );
            } else {
              try {
                const derivedModel = await resolveOllamaContextModel({
                  runner: processRunner,
                  model,
                  contextTokens,
                  workingDirectory: repositoryPath,
                  timeoutSeconds: 300,
                });
                // Deliberately narrow wording: declaring the window makes the CLI
                // compact against it, which bounds turn-by-turn growth. It does not
                // bound a single turn whose tool results already exceed the window
                // - compaction cannot evict those, and Ollama truncates them
                // silently. Do not promise otherwise.
                addCheck(
                  checks,
                  `ollama-context:${runnerName}`,
                  "pass",
                  `Derived a ${contextTokens}-token context model '${derivedModel}' from '${model}'; the Claude CLI is told the same window so it compacts against it rather than assuming 200000 tokens.`,
                );
              } catch (error) {
                addCheck(checks, `ollama-context:${runnerName}`, "fail", (error as Error).message);
              }
            }
          }
        }
      }
    }
  } else {
    addCheck(
      checks,
      "provider:ollama",
      "skipped",
      "No active step references Ollama; no Ollama probe was performed.",
      false,
    );
  }

  // 7: paths:writable
  if (readOnly) {
    addCheck(checks, "paths:writable", "skipped", "Read-only preflight does not create probe files.", false);
  } else {
    const entries: Array<{ name: string; path: string }> = [
      { name: "worktreeRoot", path: asString(getValue(config, "paths.worktreeRoot", "")) },
      { name: "artifactRoot", path: asString(getValue(config, "paths.artifactRoot", "")) },
    ];
    for (const entry of entries) {
      try {
        mkdirSync(entry.path, { recursive: true });
        const probe = join(entry.path, `.hdo-write-probe-${randomUUID().replace(/-/g, "")}`);
        writeFileSync(probe, "probe", "utf8");
        rmSync(probe, { force: true });
        addCheck(checks, `paths:${entry.name}`, "pass", entry.path);
      } catch (error) {
        addCheck(checks, `paths:${entry.name}`, "fail", (error as Error).message);
      }
    }
  }

  // 8: ok = no required check failed
  const requiredFailures = checks.filter((check) => check.required && check.status === "fail");
  return {
    schemaVersion: 1,
    ok: requiredFailures.length === 0,
    readOnly,
    profile: config.resolvedProfile ?? null,
    checkedAt: now(),
    checks,
  };
}
