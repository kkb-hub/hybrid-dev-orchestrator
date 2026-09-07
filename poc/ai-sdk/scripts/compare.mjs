#!/usr/bin/env node
// Real-Ollama comparison harness for ADR-0001 Migration strategy phase 8 step (c) - the
// adoption decision for the AI SDK. Runs the zero-dependency baseline worker
// (src/workers/leanWorker/main.ts, step (a)) and the AI SDK PoC worker
// (poc/ai-sdk/src/main.ts, step (b)) against IDENTICAL scenarios on a real local model
// and records the four metrics from Issue #48 that can only be measured against a model:
// token consumption, completion rate, tool-call accuracy, and 32K context stability.
// (Implementation size and security/auditability are measured statically, outside this
// script, and recorded in the ADR amendment.)
//
// NOT a test and NOT a CI gate: it needs a real GPU, takes tens of minutes, and its
// numbers are medians of a handful of runs against a non-deterministic local model. It
// exists to make step (c) empirical rather than speculative, and to be re-runnable when
// someone doubts the recorded numbers.
//
// Deliberate design choices, because a comparison is only worth what its fairness is
// worth:
//
//   - Both workers are launched THE SAME WAY (direct subprocess, same flags). The
//     baseline's smoke test drives scenario 1 through `runAgentStep`; that path is not
//     wired up for the PoC, and routing one worker through an extra HDO layer the other
//     does not go through would measure that layer rather than the workers.
//   - The scenarios, fixtures, prompts and success criteria are LIFTED FROM the already
//     validated `src/workers/leanWorker/smoke.test.ts` rather than invented here. A
//     comparison on fresh ad-hoc prompts would be a comparison of prompt luck.
//   - Within one repetition the two implementations run back to back on the same
//     scenario, so server warm-up and any model/VRAM state drift hit both roughly
//     equally instead of hitting all of one implementation and none of the other.
//   - Every run gets a FRESH workspace built from scratch. A run that edits the fixture
//     must not hand the next run a task that is already done.
//   - Failures are recorded as failures. There is no retry-until-green path: an
//     implementation that only sometimes finishes has a completion rate below 1, and
//     that is exactly the number step (c) needs to see.
//   - Aggregates are MEDIANS, not means: at n=3 against a local model one slow run
//     drags a mean far more than it should.
//
// Usage:
//   node poc/ai-sdk/scripts/compare.mjs [--model NAME] [--repetitions N]
//                                       [--scenarios a,b,c] [--only baseline|poc]
//                                       [--out PATH] [--keep-artifacts]
//                                       [--journal PATH] [--no-resume]
//
// Crash durability: each run is appended to a JSONL journal (default `<out>/../runs.jsonl`)
// the moment it finishes, and a re-run skips any (scenario, implementation, repetition)
// already in the journal for the same model. The full sweep costs tens of minutes of GPU
// time, so an interrupted machine must not cost all of it - just re-run the same command
// and it picks up where it stopped. `--no-resume` forces every run to be executed again
// (the journal is still appended to; stale entries are ignored, not deleted).
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const POC_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(POC_ROOT, "..", "..");

const BASELINE_MAIN = join(REPO_ROOT, "src", "workers", "leanWorker", "main.ts");
const POC_MAIN = join(POC_ROOT, "src", "main.ts");
const SCHEMA_PATH = join(REPO_ROOT, "schemas", "worker-result.schema.json");

const IMPLEMENTATIONS = {
  baseline: { label: "baseline (zero-dep)", main: BASELINE_MAIN },
  poc: { label: "poc (ai sdk)", main: POC_MAIN },
};

// --- argument parsing ---------------------------------------------------------------------

function parseArgv(argv) {
  const options = {
    model: "qwen3.8:27b-q4_K_M",
    repetitions: 3,
    scenarios: null,
    only: null,
    out: join(POC_ROOT, "results", "comparison.json"),
    keepArtifacts: false,
    ollamaUri: "http://127.0.0.1:11434",
    timeoutMs: 30 * 60_000,
    journal: null,
    resume: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--model": options.model = value; i++; break;
      case "--repetitions": options.repetitions = Number(value); i++; break;
      case "--scenarios": options.scenarios = value.split(",").map((s) => s.trim()).filter(Boolean); i++; break;
      case "--only": options.only = value; i++; break;
      case "--out": options.out = resolve(value); i++; break;
      case "--ollama-uri": options.ollamaUri = value; i++; break;
      case "--journal": options.journal = resolve(value); i++; break;
      case "--no-resume": options.resume = false; break;
      case "--keep-artifacts": options.keepArtifacts = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  if (options.only !== null && !(options.only in IMPLEMENTATIONS)) {
    throw new Error(`--only must be one of: ${Object.keys(IMPLEMENTATIONS).join(", ")}`);
  }
  if (options.journal === null) options.journal = join(dirname(options.out), "runs.jsonl");
  return options;
}

// --- journal -------------------------------------------------------------------------------
// One JSON object per line, appended as soon as a run finishes. The identity of a run is
// (model, scenario, implementation, repetition): re-running with a different --model must
// not silently reuse numbers measured against another model.

/** Repository-relative POSIX path when the target is inside the repository, so the committed
 * report does not record where one contributor happens to keep their checkout. Absolute paths
 * outside the repository are left as they are - shortening them would be a lie. */
function relativeToRepo(target) {
  const rel = relative(REPO_ROOT, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return target;
  return rel.split("\\").join("/");
}

function runKey(run) {
  return `${run.model} ${run.scenario} ${run.implementation} ${run.repetition}`;
}

/** Reads the journal, keeping the LAST entry for each key so that a `--no-resume` re-run
 * supersedes rather than duplicates. A malformed line (a half-written record from a machine
 * that lost power mid-append) is skipped rather than fatal - that is the exact situation the
 * journal exists for. */
function readJournal(path) {
  if (!existsSync(path)) return new Map();
  const entries = new Map();
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const run = JSON.parse(line);
      entries.set(runKey(run), run);
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) process.stdout.write(`journal: skipped ${skipped} unreadable line(s)\n`);
  return entries;
}

function appendJournal(path, run) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(run) + "\n", "utf8");
}

// --- scenarios -----------------------------------------------------------------------------
// Lifted from src/workers/leanWorker/smoke.test.ts. `build` populates a fresh workspace and
// returns the prompt text plus the worker flags; `succeeded` decides, from the workspace
// state alone, whether the TASK was actually accomplished (as opposed to the worker merely
// exiting zero with a well-formed report about nothing).

/** smoke.test.ts scenario 1: a real off-by-one the model has to read before it can fix. */
function buildOffByOne(workspace) {
  writeFileSync(
    join(workspace, "calc.ps1"),
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
  return [
    "The function Get-Sum in calc.ps1 has an off-by-one bug: the loop stops one element",
    "early, so the last value is never added. Read the file, fix the loop bound, and save it.",
  ].join("\n");
}

/** smoke.test.ts scenario 2's fixture: three padded modules, so the loop cannot finish
 * inside one exchange and reading a whole file costs real context. */
function buildThreeModules(workspace) {
  for (const moduleName of ["a", "b", "c"]) {
    const upper = moduleName.toUpperCase();
    const lines = [`# Module ${upper} - numeric helpers for the reporting pipeline.`, ""];
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
    writeFileSync(join(workspace, `module-${moduleName}.ps1`), lines.join("\n") + "\n", "utf8");
  }
  return [
    'Three files in this workspace each define a Get-*Total function whose for-loop bound is',
    'off by one: it uses "$i -lt $Values.Count - 1", so the last element is never added.',
    "",
    "Fix all three files: module-a.ps1, module-b.ps1, module-c.ps1. In each one, change the",
    'loop bound to "$i -lt $Values.Count". Change nothing else.',
  ].join("\n");
}

function offByOneFixed(workspace, file) {
  const content = readFileSync(join(workspace, file), "utf8");
  return !content.includes("$Values.Count - 1") && /\$i -lt \$Values\.Count/.test(content);
}

const SCENARIOS = [
  {
    id: "offbyone",
    title: "single-file off-by-one fix at the production 32K window",
    build: buildOffByOne,
    flags: ["-ContextTokens", "32768"],
    succeeded: (workspace) => offByOneFixed(workspace, "calc.ps1"),
    // No compaction is expected here: the whole point is the ordinary, cheap path.
    expectCompaction: false,
  },
  {
    id: "compaction-4k",
    title: "three-file fix at a 4K window that forces mid-task history rewrites",
    build: buildThreeModules,
    flags: ["-ContextTokens", "4096", "-CompactAtPercent", "35", "-KeepRecentMessages", "4", "-MaxTurns", "20"],
    succeeded: (workspace) => ["a", "b", "c"].every((m) => offByOneFixed(workspace, `module-${m}.ps1`)),
    expectCompaction: true,
  },
  {
    id: "compaction-32k",
    title: "the same three-file task at the production 32K window (32K stability)",
    build: buildThreeModules,
    flags: ["-ContextTokens", "32768", "-MaxTurns", "20"],
    succeeded: (workspace) => ["a", "b", "c"].every((m) => offByOneFixed(workspace, `module-${m}.ps1`)),
    expectCompaction: false,
  },
];

// --- stdout diagnostics parsing -------------------------------------------------------------
// Both workers emit the same three line shapes by design (the PoC reproduces the
// baseline's format so this comparison is possible at all). If a shape ever stops
// matching for one implementation, that is a FINDING, not something to paper over - the
// per-run record keeps the raw log, and `diagnosticsParsed` says whether the final line
// was found at all.

function parseDiagnostics(stdout) {
  const turns = [...stdout.matchAll(/^turn (\d+): prompt_tokens=(\d+) tool_calls=(\d+)$/gm)].map((m) => ({
    turn: Number(m[1]),
    promptTokens: Number(m[2]),
    toolCalls: Number(m[3]),
  }));
  const compactions = [...stdout.matchAll(/^compaction: turn=(\d+) (.+)$/gm)].map((m) => ({
    turn: Number(m[1]),
    detail: m[2],
  }));
  const finalMatch = stdout.match(/^final: prompt_tokens=(\d+) turns=(\d+) num_ctx=(\d+) compactions=(\d+)$/m);
  const final = finalMatch
    ? {
        promptTokens: Number(finalMatch[1]),
        turns: Number(finalMatch[2]),
        numCtx: Number(finalMatch[3]),
        compactions: Number(finalMatch[4]),
      }
    : null;
  return { turns, compactions, final };
}

/** Every `WARNING: tool '<name>' failed: <message>` the worker wrote to stderr. Both
 * implementations report a rejected or failed tool call this way (the PoC's toolAdapter
 * calls the same `warn`), and the DISTINCT messages matter more than the count: a run
 * that burned three calls on `path escapes the workspace` is a different failure from one
 * that burned three on `no unique match for old_text`. */
function parseToolFailures(stderr) {
  return [...stderr.matchAll(/^WARNING: tool '([^']+)' failed: (.+)$/gm)].map((m) => ({
    tool: m[1],
    message: m[2],
  }));
}

// --- one run --------------------------------------------------------------------------------

async function runOnce(options, implementationKey, scenario, repetition, artifactRoot) {
  const implementation = IMPLEMENTATIONS[implementationKey];
  const runId = `${scenario.id}--${implementationKey}--rep${repetition}`;
  const runRoot = join(artifactRoot, runId);
  const workspace = join(runRoot, "workspace");
  mkdirSync(workspace, { recursive: true });

  const promptText = scenario.build(workspace);
  const promptFile = join(runRoot, "prompt.md");
  const outputFile = join(runRoot, "result.json");
  writeFileSync(promptFile, promptText, "utf8");

  const argv = [
    implementation.main,
    "-PromptFile", promptFile,
    "-OutputFile", outputFile,
    "-SchemaFile", SCHEMA_PATH,
    "-WorkingDirectory", workspace,
    "-Model", options.model,
    "-OllamaUri", `${options.ollamaUri}/api/chat`,
    ...scenario.flags,
  ];

  const startedAt = Date.now();
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.execPath, argv, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    if (error.killed) stderr += `\n[harness] process killed after ${options.timeoutMs}ms\n`;
  }
  const wallMs = Date.now() - startedAt;

  writeFileSync(join(runRoot, "stdout.log"), stdout, "utf8");
  writeFileSync(join(runRoot, "stderr.log"), stderr, "utf8");

  const diagnostics = parseDiagnostics(stdout);
  const toolFailures = parseToolFailures(stderr);

  // "Produced a usable report" - the structured contract the orchestrator depends on.
  // Deliberately NOT full Ajv validation: this script must not depend on the repository
  // root's runtime dependencies, and the workers themselves already validate against
  // -SchemaFile before writing. What is checked here is that the file exists, parses, and
  // carries the two fields every consumer reads.
  let outputValid = false;
  let outputError = null;
  try {
    const parsed = JSON.parse(readFileSync(outputFile, "utf8"));
    outputValid = parsed.schemaVersion === 1 && typeof parsed.summary === "string" && parsed.summary.length > 0;
    if (!outputValid) outputError = "parsed but schemaVersion/summary missing or empty";
  } catch (error) {
    outputError = error.message;
  }

  let taskDone = false;
  try {
    taskDone = scenario.succeeded(workspace);
  } catch (error) {
    outputError = (outputError ? `${outputError}; ` : "") + `success check failed: ${error.message}`;
  }

  const totalToolCalls = diagnostics.turns.reduce((sum, t) => sum + t.toolCalls, 0);
  // The sum of every prompt the server actually had to evaluate across the run, including
  // the final schema-forced turn. This is cumulative on purpose: a worker that keeps a
  // fatter history pays for it on EVERY turn, and that recurring cost is precisely what
  // context management exists to control. It is NOT the size of any single request.
  const promptTokensTotal =
    diagnostics.turns.reduce((sum, t) => sum + t.promptTokens, 0) + (diagnostics.final?.promptTokens ?? 0);

  return {
    runId,
    // Part of the run's identity in the journal: numbers measured against one model must
    // never be resumed into a sweep for another.
    model: options.model,
    implementation: implementationKey,
    scenario: scenario.id,
    repetition,
    wallMs,
    exitCode,
    // A run "completed" only if it exited zero AND produced a usable report AND actually
    // did the work. Any weaker definition would let a confident empty report count.
    completed: exitCode === 0 && outputValid && taskDone,
    outputValid,
    outputError,
    taskDone,
    diagnosticsParsed: diagnostics.final !== null,
    turns: diagnostics.final?.turns ?? diagnostics.turns.length,
    compactions: diagnostics.final?.compactions ?? diagnostics.compactions.length,
    numCtx: diagnostics.final?.numCtx ?? null,
    promptTokensTotal,
    finalPromptTokens: diagnostics.final?.promptTokens ?? null,
    toolCalls: totalToolCalls,
    toolFailures: toolFailures.length,
    toolFailureMessages: [...new Set(toolFailures.map((f) => `${f.tool}: ${f.message}`))],
    logDirectory: runRoot,
  };
}

// --- aggregation ------------------------------------------------------------------------------

function median(values) {
  const sorted = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(values) {
  const numeric = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (numeric.length === 0) return null;
  return { median: median(numeric), min: Math.min(...numeric), max: Math.max(...numeric), n: numeric.length };
}

function aggregate(runs) {
  const out = [];
  for (const scenario of SCENARIOS) {
    for (const key of Object.keys(IMPLEMENTATIONS)) {
      const subset = runs.filter((r) => r.scenario === scenario.id && r.implementation === key);
      if (subset.length === 0) continue;
      out.push({
        scenario: scenario.id,
        implementation: key,
        n: subset.length,
        completed: subset.filter((r) => r.completed).length,
        exitedZero: subset.filter((r) => r.exitCode === 0).length,
        outputValid: subset.filter((r) => r.outputValid).length,
        taskDone: subset.filter((r) => r.taskDone).length,
        diagnosticsParsed: subset.filter((r) => r.diagnosticsParsed).length,
        promptTokensTotal: summarize(subset.map((r) => r.promptTokensTotal)),
        turns: summarize(subset.map((r) => r.turns)),
        toolCalls: summarize(subset.map((r) => r.toolCalls)),
        toolFailures: summarize(subset.map((r) => r.toolFailures)),
        compactions: summarize(subset.map((r) => r.compactions)),
        wallMs: summarize(subset.map((r) => r.wallMs)),
        // Union across repetitions: which rejections happened at all is the interesting
        // fact, and a message that appeared in only one run still tells you something.
        distinctToolFailures: [...new Set(subset.flatMap((r) => r.toolFailureMessages))].sort(),
      });
    }
  }
  return out;
}

// --- markdown report ----------------------------------------------------------------------------

function formatCell(summary, digits = 0) {
  if (summary === null) return "-";
  const f = (v) => (digits === 0 ? String(Math.round(v)) : v.toFixed(digits));
  if (summary.min === summary.max) return f(summary.median);
  return `${f(summary.median)} (${f(summary.min)}-${f(summary.max)})`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# lean worker 比較: 依存 0 ベースライン vs AI SDK PoC");
  lines.push("");
  lines.push(
    "ADR-0001 Migration strategy 項目8 step (c) の採否判断のための実測。" +
      "`poc/ai-sdk/scripts/compare.mjs` が生成する。数値は再現可能だが、" +
      "**ローカルモデルは非決定的であり、下表はいずれも n=" + report.environment.repetitions + " の中央値（括弧内は min-max）である**。" +
      "少数試行の中央値を精密な測定値として読まないこと。",
  );
  lines.push("");
  lines.push("## 実行環境");
  lines.push("");
  lines.push("| 項目 | 値 |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(report.environment)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## 指標の定義");
  lines.push("");
  lines.push("- **prompt_tokens 合計**: 各 turn の `prompt_tokens` と最終 schema 強制 turn の `prompt_tokens` の総和。");
  lines.push("  1回の request のサイズではなく、run 全体でサーバが評価した prompt の累計である。履歴を厚く持つ実装は毎 turn その分を払うため、この累計が context 管理の良否を映す。");
  lines.push("- **completed**: exit 0 かつ `-OutputFile` が `schemaVersion=1` と非空の `summary` を持ち、かつ **workspace 上で実際にタスクが達成されている**（全対象ファイルの off-by-one が直っている）ことの全てを満たす run の数。空の報告書を書いて 0 で終了した run は completed に数えない。");
  lines.push("- **tool 失敗**: worker が stderr に書いた `WARNING: tool '<name>' failed: ...` の件数。tool call 総数に対する比率が tool call 精度に当たる。");
  lines.push("- **compactions**: `final:` 行が報告した compaction 回数。");
  lines.push("");
  for (const scenario of SCENARIOS) {
    const rows = report.aggregates.filter((a) => a.scenario === scenario.id);
    if (rows.length === 0) continue;
    lines.push(`## シナリオ \`${scenario.id}\` — ${scenario.title}`);
    lines.push("");
    lines.push("| 実装 | completed | exit 0 | 出力妥当 | タスク達成 | prompt_tokens 合計 | turns | tool calls | tool 失敗 | compactions | 実時間 (s) |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(
        `| ${IMPLEMENTATIONS[row.implementation].label} | ${row.completed}/${row.n} | ${row.exitedZero}/${row.n} | ` +
          `${row.outputValid}/${row.n} | ${row.taskDone}/${row.n} | ${formatCell(row.promptTokensTotal)} | ` +
          `${formatCell(row.turns)} | ${formatCell(row.toolCalls)} | ${formatCell(row.toolFailures)} | ` +
          `${formatCell(row.compactions)} | ${formatCell({ ...row.wallMs, median: row.wallMs.median / 1000, min: row.wallMs.min / 1000, max: row.wallMs.max / 1000 }, 1)} |`,
      );
    }
    lines.push("");
    for (const row of rows) {
      if (row.distinctToolFailures.length === 0) continue;
      lines.push(`**${IMPLEMENTATIONS[row.implementation].label} で観測した tool 失敗（重複除去、全 repetition の和集合）**:`);
      lines.push("");
      for (const message of row.distinctToolFailures) lines.push(`- \`${message}\``);
      lines.push("");
    }
    const unparsed = report.aggregates.filter((a) => a.scenario === scenario.id && a.diagnosticsParsed < a.n);
    for (const row of unparsed) {
      lines.push(
        `> 注意: ${IMPLEMENTATIONS[row.implementation].label} の ${row.n - row.diagnosticsParsed}/${row.n} run で ` +
          "`final:` 診断行を解析できなかった。その run の token/turn 集計は不完全である。",
      );
      lines.push("");
    }
  }
  lines.push("## 個別 run");
  lines.push("");
  lines.push("| run | completed | exit | prompt_tokens | turns | tool calls | 失敗 | compactions | 実時間 (s) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const run of report.runs) {
    lines.push(
      `| \`${run.runId}\` | ${run.completed ? "yes" : "**no**"} | ${run.exitCode} | ${run.promptTokensTotal} | ` +
        `${run.turns} | ${run.toolCalls} | ${run.toolFailures} | ${run.compactions} | ${(run.wallMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

// --- preflight --------------------------------------------------------------------------------

async function preflight(options) {
  let version;
  try {
    const response = await fetch(`${options.ollamaUri}/api/version`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    version = (await response.json()).version;
  } catch (error) {
    throw new Error(
      `Ollama is not reachable at ${options.ollamaUri} (${error.message}). ` +
        "Start it, or point the harness elsewhere with --ollama-uri.",
    );
  }
  let tags;
  try {
    const response = await fetch(`${options.ollamaUri}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    tags = (await response.json()).models ?? [];
  } catch (error) {
    throw new Error(`could not list Ollama models: ${error.message}`);
  }
  const names = tags.map((m) => m.name);
  if (!names.includes(options.model)) {
    throw new Error(
      `model '${options.model}' is not pulled. Available: ${names.join(", ") || "(none)"}. ` +
        `Pull it with: ollama pull ${options.model}`,
    );
  }
  return version;
}

// --- main --------------------------------------------------------------------------------------

async function main() {
  const options = parseArgv(process.argv.slice(2));
  const ollamaVersion = await preflight(options);

  const scenarios = options.scenarios
    ? SCENARIOS.filter((s) => options.scenarios.includes(s.id))
    : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenario matched --scenarios (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
  const implementationKeys = options.only ? [options.only] : Object.keys(IMPLEMENTATIONS);

  const journal = options.resume ? readJournal(options.journal) : new Map();
  if (journal.size > 0) process.stdout.write(`journal: ${journal.size} run(s) already recorded in ${options.journal}\n`);

  const artifactRoot = mkdtempSync(join(tmpdir(), "hdo-worker-comparison-"));
  const runs = [];
  const total = scenarios.length * implementationKeys.length * options.repetitions;
  let index = 0;
  try {
    for (const scenario of scenarios) {
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        // Back to back within a repetition, so drift hits both implementations equally.
        for (const key of implementationKeys) {
          index++;
          const label = `[${index}/${total}] ${scenario.id} / ${key} / rep ${repetition}`;
          // Built through runKey() rather than re-spelling the format, so the lookup side
          // cannot drift from the write side.
          const recorded = journal.get(
            runKey({ model: options.model, scenario: scenario.id, implementation: key, repetition }),
          );
          if (recorded) {
            runs.push(recorded);
            process.stdout.write(`${label} ... resumed from journal\n`);
            continue;
          }
          process.stdout.write(`${label} ... `);
          const run = await runOnce(options, key, scenario, repetition, artifactRoot);
          runs.push(run);
          // Appended BEFORE anything else can fail, so an interrupted sweep keeps this run.
          appendJournal(options.journal, run);
          process.stdout.write(
            `${run.completed ? "completed" : "NOT COMPLETED"} ` +
              `(exit=${run.exitCode} turns=${run.turns} tokens=${run.promptTokensTotal} ` +
              `toolFail=${run.toolFailures}/${run.toolCalls} compactions=${run.compactions} ${(run.wallMs / 1000).toFixed(1)}s)\n`,
          );
        }
      }
    }

    const report = {
      environment: {
        date: new Date().toISOString(),
        model: options.model,
        ollamaVersion,
        ollamaUri: options.ollamaUri,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        repetitions: options.repetitions,
        baselineEntry: "src/workers/leanWorker/main.ts",
        pocEntry: "poc/ai-sdk/src/main.ts",
        journal: relativeToRepo(options.journal),
        // A resumed run's `logDirectory` names a temp directory from the earlier process,
        // which has already been cleaned up. The numbers are the journal's; the per-run
        // logs only exist for runs executed by the process that wrote this report.
        resumedRuns: runs.filter((r) => !r.logDirectory || !existsSync(r.logDirectory)).length,
      },
      scenarios: scenarios.map((s) => ({ id: s.id, title: s.title, flags: s.flags })),
      // `logDirectory` is dropped from the committed report on purpose: it names a temp
      // directory belonging to one machine and one process, it is deleted when that process
      // exits (unless --keep-artifacts), and this file is checked in as the evidence an ADR
      // cites. `runId` identifies a run without pinning it to somebody's filesystem.
      runs: runs.map(({ logDirectory, ...run }) => run),
      aggregates: aggregate(runs),
    };

    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n", "utf8");
    const markdownPath = options.out.replace(/\.json$/, ".md");
    writeFileSync(markdownPath, renderMarkdown(report), "utf8");
    process.stdout.write(`\nwrote ${options.out}\nwrote ${markdownPath}\n`);

    const incomplete = runs.filter((r) => !r.completed).length;
    if (incomplete > 0) process.stdout.write(`\n${incomplete}/${runs.length} run(s) did not complete - see the per-run logs.\n`);
  } finally {
    if (options.keepArtifacts) process.stdout.write(`run artifacts retained at ${artifactRoot}\n`);
    else rmSync(artifactRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
