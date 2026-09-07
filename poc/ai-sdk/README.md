# HDO comparison PoC: AI SDK

> **Outcome (2026-09-07): the AI SDK was NOT adopted. This directory is now frozen.**
>
> Step (c) is decided and recorded in ADR-0003, Amendment "2026-09-07: フェーズ8 (c) 採否決定".
> The zero-dependency baseline (`src/workers/leanWorker/`) is what HDO ships; the repository
> root's `dependencies` were not changed. Across the four model-facing metrics from Issue #48
> the SDK improved nothing (completion rate 9/9 for both, 0 tool failures out of 98 calls for
> both, identical 32K behaviour, and a token difference smaller than the n=3 variance), while
> the two static metrics were pure cost (+25 code lines - the opposite sign to the prediction
> below - and +12 packages, of which 8 load into the process that holds the workspace-write
> capability). Measurements: `results/comparison.md` and `results/comparison.json`.
>
> Frozen means: kept as the evidence for that decision, updated only if one of the
> re-evaluation triggers in that Amendment fires. `scripts/compare.mjs` stays runnable so the
> numbers can be re-checked rather than taken on trust.

Comparison artefact for ADR-0001 Migration strategy phase 8 step (b) and ADR-0003
(`docs/adr/0003-agent-harness-lightweight.md`) Decision D2 (b). **This is NOT a supported
worker.** It exists to make phase 8 step (c) - the adoption decision (AI SDK adopted /
zero-dependency baseline kept / adopted conditionally) - empirical instead of speculative,
by building a second lean-worker implementation on the Vercel AI SDK (`ai` + Ollama
provider) that shares the same tool functions, the same `WorkspaceGuard`, and the same
artifact contract as the zero-dependency baseline (`src/workers/leanWorker/`, phase 8 step
(a)), and can be driven through the same scripted test scenarios and the same real-model
prompts for a side-by-side measurement.

`poc/typescript/` (the Issue #18 runtime-evaluation PoC) stays frozen; this is a separate,
later PoC for a separate ADR and does not touch it.

## Why this exists (ADR-0003 D2 (b))

ADR-0003's Rationale table ("なぜ今すぐ採らず (a) → (b) → (c) にするか") pre-registered a
prediction, made on 2026-09-06 without this PoC existing yet: the AI SDK route would save
roughly 120-140 of the baseline's 1222 PowerShell lines (10-12%), at a cost of about 12
packages and ~18 MB of `node_modules`. This directory is what makes that prediction
checkable rather than asserted. See "Facts measured" below for what actually happened when
the dependencies were installed and the worker was built.

## What is reused from the baseline, unchanged (ADR-0003 D3)

The security boundary and the context/compaction policy are HDO-owned and
framework-independent by design (ADR-0003 D3): whichever harness runs the tool loop, they
stay the same code. This PoC imports the following `src/workers/leanWorker/` modules
directly rather than reimplementing any part of them - **zero lines in `src/` were changed
to make this possible; every symbol below was already exported**:

| Reused from `src/workers/leanWorker/` | Used for |
|---|---|
| `args.ts` (`parseWorkerArgs`) | identical CLI contract to the baseline |
| `tools.ts` (`dispatchTool`) | the only code that ever touches the filesystem; the AI SDK and the model never see a path |
| `toolDefinitions.ts` (`getTools`) | which tools exist - read-only omits `write_file`/`edit_file` as KEYS, not as a filtered/disabled list |
| `session.ts` (`createSession`, `WorkerSession`, `ChatMessage`) | the same session shape and protected-message accounting |
| `compaction.ts` (`testCompactionThresholdCrossed`, `invokeContextCompaction`, `compressFinalContext`) | the compaction policy itself, called from `prepareStep` |
| `verifiedState.ts` (`registerToolOutcome`) | worker-verified state, recorded from inside each tool's `execute` |
| `log.ts` (`warn`) | the same `WARNING: ...` diagnostic format |

`workspaceGuard.ts`'s `resolveWorkerPath`/`isPathInsideWorkspace` are exercised
transitively through `tools.ts`'s `dispatchTool` (which already calls them) rather than
imported a second time here directly: nothing in this PoC's own code touches a path
outside that one call, so importing the guard functions again would add a name without
adding a use. `historySlicing.ts`, `summarizer.ts`, `text.ts`, and `psInt.ts` are likewise
exercised transitively, as internals of the reused `compaction.ts` pipeline.

`src/workers/leanWorker/main.ts`'s own small pure helpers (`normalizeWorkspace`,
`loadResponseSchema`, `buildInitialMessages`) are **duplicated, byte-identical**, in
`src/main.ts` rather than imported: that file runs its own `run(process.argv.slice(2))` as
a top-level side effect on import (by design - it is meant to be launched as a
subprocess), so importing anything from it here would re-execute the baseline worker
against this process's own argv.

## What this PoC adds

- `src/toolAdapter.ts` - builds the AI SDK `ToolSet` from `getTools`/`dispatchTool`/
  `registerToolOutcome`. Read-only mode omits `write_file`/`edit_file` as object keys, not
  via `activeTools` or any other framework-level filter (ADR-0003 D3).
- `src/messageBridge.ts` - the ModelMessage ↔ `ChatMessage` bridge described below.
- `src/main.ts` - the entry point: same CLI flags as the baseline, `generateText` +
  `prepareStep` for the tool loop, a separate forced-schema `generateText` call (up to 3
  retries) for the final structured report.

## Facts measured (2026-09-07, Windows 11, Node 24.20.0, `npm` 11.19.0)

**Dependencies.** `npm install` inside this directory (no root `package.json`/
`package-lock.json` change - verified with `git status`) resolved:

- `ai@7.0.93` (unchanged from ADR-0003's 2026-09-06 check), `ollama-ai-provider-v2@4.0.1`.
- **Exactly 12 production packages** (`npm ls --all` scoped to non-dev), matching
  ADR-0003's F5 prediction exactly, same names and versions: `ai`, `@ai-sdk/gateway`,
  `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@standard-schema/spec`, `@vercel/oidc`,
  `@workflow/serde`, `eventsource-parser`, `json-schema`, `undici@7.29.1`,
  `ollama-ai-provider-v2`, and **`zod@4.5.4`** - `zod` is still pulled in as a peer even
  though this PoC uses `jsonSchema()` and never authors a zod schema itself (confirms
  ADR-0003's "HDO が使わないのに入るもの" note). Licenses match ADR-0003's table
  (Apache-2.0 for `ai`/`@ai-sdk/*`/`ollama-ai-provider-v2`/`@vercel/oidc`/`@workflow/serde`,
  MIT for the rest, `(AFL-2.1 OR BSD-3-Clause)` for `json-schema`).
- `node_modules` for just those 12 production packages: **~21.4 MB on disk** (`du -sh`,
  sum of each package's own directory) - somewhat above ADR-0003's ~18 MB (that figure was
  `npm view dist.unpackedSize` summed, i.e. tarball-unpacked size before filesystem block
  overhead; `du` on an actual install is not directly comparable, but the two numbers are
  in the same range and tell the same story). Adding the two devDependencies
  (`typescript`, `@types/node` - already present in the repository root's own
  `node_modules` anyway) brings the full `poc/ai-sdk/node_modules` to ~48 MB, dominated by
  `typescript` itself (~23 MB) rather than anything AI-SDK-specific.

**Lines of code.** Counted with `wc -l`, excluding `*.test.ts` files and this PoC's own
`testHarness.ts` (test-only scaffolding, not shipped code) on both sides:

| | Lines |
|---|---|
| Baseline (`src/workers/leanWorker/*.ts`, excluding tests and its own `testHarness.ts`) | 3511 |
| This PoC's own source (`main.ts` + `toolAdapter.ts` + `messageBridge.ts`) | 476 |

This is **not** the same comparison ADR-0003's 1222-line PowerShell table made: the
zero-dependency TypeScript baseline itself is already a full worker with the reused
modules folded in, not a bare 1222-line script, so "lines saved" cannot be read directly
off this pair. The more precise question ADR-0003's Decision D2 (c) needs is answered
below instead.

**Did the compaction policy reduce to a one-line `prepareStep` call?** No, not quite, and
this is the PoC's single most important empirical finding. ADR-0003's Rationale (point
(d), "compaction は SDK 内で実装できる") predicted `prepareStep` could call the reused
policy "in one line". In practice `prepareStep` here is about a dozen lines, and it needs
a whole extra module to get there:

- `messageBridge.ts` (121 lines total, ~65 of them code once headers/comments are
  excluded) exists **only** because `testCompactionThresholdCrossed`/
  `invokeContextCompaction`/`compressFinalContext` and the pure slicing/measurement
  helpers they call (`historySlicing.ts`) all operate on `WorkerSession.messages:
  ChatMessage[]` - the Ollama-native flat shape the baseline built them against - while
  the AI SDK only ever hands `prepareStep` and receives back `ModelMessage[]`, a
  discriminated union whose assistant/tool roles carry a `content` ARRAY of typed parts
  addressed by `toolCallId` rather than by position. Every `prepareStep` call round-trips
  through this bridge: fold the just-completed step into `ChatMessage[]`
  (`stepToChatMessages`), let the untouched compaction functions rewrite that array
  exactly as they do for the baseline, then re-render it as `ModelMessage[]`
  (`chatMessagesToModelMessages`) for the override the SDK carries forward.
- The step that ends the tool loop - whether by the model's own choice or by hitting the
  turn limit - never gets a following `prepareStep` call, so `main.ts` has to fold it in
  and run the same threshold check by hand right after `generateText` resolves (exactly
  the case ADR-0003's point (c) called out as *not* reachable from `prepareStep`).
- One divergence this PoC's tests surfaced that ADR-0003 did not anticipate: `ai@7.0.93`
  rejects a `{role: "system"}` entry inside `messages`/`prompt` outright ("System messages
  are not allowed in the prompt or messages fields. Use the instructions option instead."
  - a hard validation error, not merely the `system`→`instructions` rename ADR-0003's
  F3 already knew about). Because `session.messages[0]` is always the protected system
  prompt, every render for the AI SDK has to split it out via the top-level `instructions`
  option and convert only the rest - three extra lines in `main.ts`, but a real, provider-
  version-sensitive constraint the reused policy's own code has no way to express.
- Separately, `ollama-ai-provider-v2` validates every HTTP response against a zod schema
  requiring `model`/`created_at`/`done` fields that neither worker's own client code
  (`ollamaClient.ts`'s `invokeOllamaChat`, or this PoC against a real Ollama server) ever
  required - Ollama's real responses do include them, but the test stub server had to be
  taught to add them (`src/testHarness.ts`'s `newAssistantResponse` wrapper) before this
  PoC's otherwise-untouched scripted scenarios would work at all.

**Was the tool-array/security-boundary reuse genuine?** Yes, proven by test rather than
asserted: `src/worker.test.ts` drives this worker through the *same* scripted exchanges
`src/workers/leanWorker/toolLoop.test.ts` and `compaction.test.ts` use against the
baseline (relative/absolute escape, git-metadata rejection, link traversal, the read-only
boundary, the empty-structured-result retry, and one compaction trigger), inspecting the
raw JSON request bodies the AI SDK actually sent to the stub. The workspace-escape,
absolute-path, git-metadata, and link-traversal rejections all produce the reused guard's
EXACT error strings, confirming the reuse is real and not a parallel reimplementation. The
compaction scenario reproduces the baseline's exact 6-request sequence and order
(read → edit → in-loop summarization → final assistant turn → pre-report summarization →
structured report) for the identical scripted input.

**Other observed divergences from the baseline's exact behaviour:**

- The wire shape of a tool-result message differs: the baseline sends
  `{role:'tool', tool_name, content}`; `ollama-ai-provider-v2` sends
  `{role:'tool', tool_call_id, content}` (no `tool_name` field at all). The *content*
  string is identical either way (this PoC's tools always resolve with a plain string,
  never let the AI SDK synthesize a `tool-error` content part), but a byte-for-byte wire
  diff between the two workers' requests would show this.
- The AI SDK sends `think: false` on every request once any call in the run sets it via
  `providerOptions.ollama.think` (`resolveOllamaThinkFlag`'s fallback is `false`, not
  "absent"), whereas the baseline leaves `think` out of its ordinary turn-loop requests
  entirely and only ever sets it on the summarization and final calls. Cosmetic - it does
  not change model behaviour - but visible on a raw request diff.
- `Output.object`'s `jsonSchema()` path performs **no structural JSON Schema validation**
  by default (confirmed by reading `@ai-sdk/provider-utils`'s `safeValidateTypes`: it
  short-circuits to "valid" whenever no custom `validate` function is supplied). A
  malformed-but-parseable final report would pass here exactly as it does in the
  baseline, which also does not validate its own output - so this is not a behavioural
  gap, just worth recording since `Output.object` reads, at a glance, like it validates.

## Running the tests (CI gate, no real Ollama)

```sh
cd poc/ai-sdk
npm ci
npm run typecheck
npm test
```

`npm test` runs `node --test "src/**/*.test.ts"` against a `node:http` stub server bound
to an OS-assigned port (`listen(0)`), exactly like the baseline's own
`src/workers/leanWorker/testHarness.ts` - see that file's header, and this PoC's own
`src/testHarness.ts`, for why the worker is launched with the ASYNC `child_process` API
rather than `execFileSync`/`spawnSync` (a sync spawn would block the same event loop the
stub server needs to answer the child's request, deadlocking both sides). `.github/
workflows/poc-ai-sdk.yml` runs this on `windows-latest` and `ubuntu-latest`.

## Running the real-model measurement (not CI - owner runs this manually)

This worker takes the exact same flags as the baseline
(`src/workers/leanWorker/args.ts`), so the same prompt/schema/workspace can be pointed at
either implementation for a side-by-side run against a real local Ollama server:

```sh
node poc/ai-sdk/src/main.ts \
  -PromptFile <path to a task prompt> \
  -OutputFile <path to write the structured result> \
  -SchemaFile schemas/worker-result.schema.json \
  -WorkingDirectory <a real repository worktree> \
  -Model qwen3.8:27b-q4_K_M \
  -ContextTokens 32768
```

Both implementations emit the same diagnostic line shapes (`turn N: prompt_tokens=...
tool_calls=...`, `compaction: ...`, `final: prompt_tokens=... turns=... num_ctx=...
compactions=...`), so the two transcripts can be diffed directly.

`scripts/compare.mjs` automates exactly that into the measurement the decision rests on -
the four Issue #48 axes that need a real model (token consumption, completion rate,
tool-call accuracy, 32K stability). The other two axes (implementation size,
security/auditability) are static and are covered by "Facts measured" above.

```sh
node poc/ai-sdk/scripts/compare.mjs
```

It runs three scenarios (`offbyone`, `compaction-4k`, `compaction-32k`, all lifted from
`src/workers/leanWorker/smoke.test.ts`) against both implementations for three repetitions
each - 18 runs, tens of minutes on a real GPU - and writes `results/comparison.json` (every
run's raw values) and `results/comparison.md` (aggregate tables, medians with min-max).
Fairness rules are documented in the script header: identical launch method, identical
fixtures, the two implementations run back to back within a repetition, a fresh workspace
per run, and failures recorded as failures with no retry-until-green.

Each run is appended to a JSONL journal (`results/runs.jsonl`) the moment it finishes, and
re-running skips any `(model, scenario, implementation, repetition)` already recorded - so an
interrupted machine costs one run, not the whole sweep. Use `--no-resume` to force every run
to execute again. Other flags: `--model`, `--repetitions`, `--scenarios`, `--only`, `--out`,
`--journal`, `--keep-artifacts`.

`scripts/loaded-modules.mjs` measures the other number the dependency axis needs - not what
`npm ci` writes to disk, but how much third-party code actually loads into the process that
holds the workspace-write capability:

```sh
node poc/ai-sdk/scripts/loaded-modules.mjs ai
```

## Directory contents

```
poc/ai-sdk/
  package.json / package-lock.json   dependencies scoped to this directory only
  tsconfig.json                      same compiler options as poc/typescript and the
                                      repository root, so the code style stays consistent
  src/
    main.ts            entry point - same CLI contract as src/workers/leanWorker/main.ts
    toolAdapter.ts      builds the AI SDK ToolSet from the reused HDO tool functions
    messageBridge.ts    ChatMessage <-> ModelMessage bridge (see "Facts measured" above)
    testHarness.ts      stub-server/child-process test scaffolding, not shipped code
    *.test.ts           the deterministic CI-gate suite
  scripts/
    compare.mjs               real-Ollama comparison harness (the 4 model-facing metrics)
    loaded-modules.mjs        third-party code actually loaded into the process
    loaded-modules-hook.mjs   the ESM load hook it registers
  results/
    comparison.json    every run's raw values, from the sweep the ADR amendment cites
    comparison.md      the aggregate tables (medians with min-max)
```
