// Tests for `resolveOllamaContextModel` (Resolve-HdoOllamaContextModel, Runner.ps1:
// 390-414) against a FAKE `ProcessRunner` - no real `ollama` binary is invoked here.
// The real-binary smoke test at the bottom of this file (mirroring
// `tests/run-tests.ps1:565-591`, which spawns an actual `ollama.cmd` shim on PATH)
// used to be skipped: spawning a bare `.cmd` through `NodeProcessRunner` threw
// `EINVAL` synchronously (ADR-0001 phase 5 plan §7 risk 20) until WP-D's cmd.exe
// argument-quoting support (`src/core/process/cmdShim.ts`) landed. WP-G un-skipped it
// once WP-D merged.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../core/process/types.ts";
import { resolveOllamaContextModel } from "./ollamaContextModel.ts";

/** Minimal successful `ProcessResult`, filling in every field the contract requires. */
function successResult(options: ProcessRunOptions): ProcessResult {
  return {
    command: options.command,
    arguments: options.arguments ?? [],
    exitCode: 0,
    timedOut: false,
    outputLimitExceeded: false,
    outputLimitStream: "",
    outputDrainTimedOut: false,
    maximumOutputBytes: 33554432,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: "",
    stderrPath: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 0,
    stdout: "",
    stderr: "",
  };
}

/**
 * Mirrors `NodeProcessRunner`'s own `throwOnError` behavior (`src/process/runner.ts:
 * 591-598`): `Command '<command>' failed with exit code <code>. <detail>`, falling
 * back to trimmed stdout only when stderr is empty.
 */
function formatProcessFailure(command: string, exitCode: number, stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return `Command '${command}' failed with exit code ${exitCode}. ${detail}`;
}

class FakeProcessRunner implements ProcessRunner {
  calls: ProcessRunOptions[] = [];
  /** When set, captured synchronously during `run()`, before the caller can delete anything. */
  modelfileContentDuringRun?: string;
  private readonly behavior: (options: ProcessRunOptions) => Promise<ProcessResult>;

  constructor(behavior: (options: ProcessRunOptions) => Promise<ProcessResult>) {
    this.behavior = behavior;
  }

  async run(options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push(options);
    const modelfilePath = options.arguments?.[3];
    if (modelfilePath) this.modelfileContentDuringRun = readFileSync(modelfilePath, "utf8");
    return this.behavior(options);
  }
}

function makeWorkingDirectory(): string {
  return mkdtempSync(join(tmpdir(), "hdo-ollamaContextModel-test-"));
}

test("resolveOllamaContextModel runs 'ollama create <derived> -f <modelfile>' and returns the derived name", async () => {
  const runner = new FakeProcessRunner(async (options) => successResult(options));
  const workingDirectory = makeWorkingDirectory();
  try {
    const derived = await resolveOllamaContextModel({
      runner,
      model: "qwen3.8:27b-q4_K_M",
      contextTokens: 65536,
      workingDirectory,
      timeoutSeconds: 60,
    });

    assert.equal(derived, "hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536");
    assert.equal(runner.calls.length, 1);
    const call = runner.calls[0];
    assert.equal(call.command, "ollama");
    assert.deepEqual(call.arguments?.slice(0, 2), ["create", derived]);
    assert.equal(call.arguments?.[2], "-f");
    assert.ok(call.arguments?.[3]?.endsWith(".txt"), `expected modelfile path to end with .txt, got ${call.arguments?.[3]}`);
    assert.equal(call.workingDirectory, workingDirectory);
    assert.equal(call.timeoutSeconds, 60);
    assert.equal(call.throwOnError, true);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaContextModel writes 'FROM <model>' + 'PARAMETER num_ctx <n>' into the modelfile", async () => {
  const runner = new FakeProcessRunner(async (options) => successResult(options));
  const workingDirectory = makeWorkingDirectory();
  try {
    await resolveOllamaContextModel({
      runner,
      model: "qwen3.8:27b-q4_K_M",
      contextTokens: 65536,
      workingDirectory,
      timeoutSeconds: 60,
    });
    assert.equal(runner.modelfileContentDuringRun, "FROM qwen3.8:27b-q4_K_M\nPARAMETER num_ctx 65536\n");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaContextModel strips secrets from the ambient environment before running ollama", async () => {
  const runner = new FakeProcessRunner(async (options) => successResult(options));
  const workingDirectory = makeWorkingDirectory();
  try {
    await resolveOllamaContextModel({
      runner,
      model: "llama3",
      contextTokens: 4096,
      workingDirectory,
      timeoutSeconds: 30,
      ambientEnvironment: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_should-not-leak", ANTHROPIC_API_KEY: "sk-ant-should-not-leak" },
    });
    const environment = runner.calls[0].environment;
    assert.ok(environment);
    assert.equal(environment?.PATH, "/usr/bin");
    assert.equal(environment?.GITHUB_TOKEN, undefined);
    assert.equal(environment?.ANTHROPIC_API_KEY, undefined);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaContextModel deletes the modelfile after a successful run", async () => {
  const runner = new FakeProcessRunner(async (options) => successResult(options));
  const workingDirectory = makeWorkingDirectory();
  try {
    await resolveOllamaContextModel({
      runner,
      model: "llama3",
      contextTokens: 4096,
      workingDirectory,
      timeoutSeconds: 30,
    });
    const modelfilePath = runner.calls[0].arguments?.[3];
    assert.ok(modelfilePath);
    assert.equal(existsSync(modelfilePath as string), false, "expected the modelfile to be deleted after run() resolves");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

test("resolveOllamaContextModel surfaces the ollama create failure and still deletes the modelfile", async () => {
  // Oracle: tests/run-tests.ps1:577-589, "Resolve-HdoOllamaContextModel surfaces the
  // ollama create failure instead of failing silently" - emulates the real
  // `NodeProcessRunner`'s `throwOnError` throw text (`Command 'ollama' failed with
  // exit code 1. Error: model requires more system memory than is available`), since
  // this test uses a fake runner rather than a real `ollama.cmd` (see the module
  // banner for why the real-binary variant is skipped for now).
  const stderr = "Error: model requires more system memory than is available";
  const runner = new FakeProcessRunner(async (options) => {
    throw new Error(formatProcessFailure(options.command, 1, "", stderr));
  });
  const workingDirectory = makeWorkingDirectory();
  try {
    await assert.rejects(
      () =>
        resolveOllamaContextModel({
          runner,
          model: "qwen3.8:27b-q4_K_M",
          contextTokens: 65536,
          workingDirectory,
          timeoutSeconds: 60,
        }),
      /model requires more system memory/,
    );
    const modelfilePath = runner.calls[0].arguments?.[3];
    assert.ok(modelfilePath);
    assert.equal(existsSync(modelfilePath as string), false, "expected the modelfile to be deleted even when ollama create fails");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
});

// WP-D added `.cmd`/`.bat` spawning support to `NodeProcessRunner` (see
// `src/core/process/cmdShim.ts`, `src/process/runner.ts`); before it landed, spawning
// a bare `ollama.cmd` shim (as this test does, exactly like
// `tests/run-tests.ps1:567-575`) threw `EINVAL` synchronously (ADR-0001 phase 5 plan
// §7 risk 20). WP-G un-skipped this once WP-D was merged.
test(
  "resolveOllamaContextModel against a real ollama.cmd shim via the real NodeProcessRunner",
  async () => {
    const { getPlatform } = await import("../platform/index.ts");
    const { NodeProcessRunner } = await import("../process/runner.ts");
    const platform = getPlatform();
    const realRunner = new NodeProcessRunner({ platform });
    const workingDirectory = makeWorkingDirectory();
    const shimDirectory = mkdtempSync(join(tmpdir(), "hdo-mock-ollama-"));
    const previousPath = process.env.PATH;
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(shimDirectory, "ollama.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
      process.env.PATH = `${shimDirectory};${previousPath ?? ""}`;
      const derived = await resolveOllamaContextModel({
        runner: realRunner,
        model: "qwen3.8:27b-q4_K_M",
        contextTokens: 65536,
        workingDirectory,
        timeoutSeconds: 60,
      });
      assert.equal(derived, "hdo-ctx-qwen3.8-27b-q4_K_M-7382ada3-65536");
    } finally {
      process.env.PATH = previousPath;
      rmSync(workingDirectory, { recursive: true, force: true });
      rmSync(shimDirectory, { recursive: true, force: true });
    }
  },
);
