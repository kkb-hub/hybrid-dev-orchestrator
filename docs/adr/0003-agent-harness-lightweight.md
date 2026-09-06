# ADR-0003: エージェントハーネスの構成（outer workflow / inner tool loop）

## Status

Accepted (2026-09-06)。Proposed として PR #66 で起票し、同日 repository owner が承認した。

本 ADR は Issue #48「エージェントハーネス軽量化の検討: AI SDK + XState を LangGraph 代替として評価する」の AC「現行独自実装 / AI SDK + XState / LangGraph の trade-off を ADR または docs に記録する」に対する回答である。Issue #48 の PoC 系 AC（AI SDK PoC、XState PoC、本採用判断）は本 ADR では閉じず、Decision D2 の (b)(c) と D4 に期限を切らずに残す。

Issue #37 の AC-01（Ollama 2経路と doctor preflight のフェーズ）/ AC-02（`workers/hdo-ollama-worker.ps1` の扱い）は ADR-0001 の Amendment「2026-09-06: Ollama 対応の移行スコープ（Issue #37）」で回答済みであり、本 ADR は同 Amendment が「フェーズ7より後の別 Issue で扱う」とした worker の TypeScript 移植を、ADR-0001 の新しい Migration strategy **フェーズ8（workers）** として確定する（ADR-0001 Amendment「2026-09-06: フェーズ8（workers）の追加と lean worker 移植の位置づけ」と対で読む）。

## Context

### 現状（`origin/main` = `5748aea`、フェーズ5完了時点）

- **outer workflow の状態表**: `src/core/state/index.ts`（117行）が `RunState` union、`EXPLICIT_TRANSITIONS`（`Record<RunState, readonly RunState[]>`、module-private の `const`）、`transition(from, to)`（不正遷移で `IllegalStateTransitionError` を throw）、`isTerminalState()` を持つ。`Test-HdoStateTransition` の大文字化・非 throw 判定までテストで `State.ps1:65` の throw 文言と一致させている。
- **outer workflow の oracle**: `Workflow.ps1` の `Invoke-HdoRun`（211-544行）は `Set-HdoRunState` を直列に呼ぶ手続き型ループであり、`events.jsonl` に `{type:'state.transition', from, to, reason, iteration}` を書く。`reason` は遷移ごとに固有文言を持つ（CHANGES_REQUESTED だけで4種: "Implementation produced no diff." / "Required validation did not pass." / "Reviewer requested changes at the fix limit." / "Reviewer returned actionable findings."）。ADR-0001 フェーズ6の終了条件は「`NoWriteBack` full run が両実装で同じ state 遷移・同じ diff・同じ review 判定に到達する（決定論的 mock runner で測定）」であり、**PowerShell 側の `events.jsonl` がフェーズ6の oracle** になる。
- **inner tool loop の現物**: `workers/hdo-ollama-worker.ps1`（評価時点 `a4fa523` で1222行。`5748aea` では PR #58 の修正を含め1240行）。route 2（`type: command` / `provider: ollama`）の lean worker で、Ollama native `/api/chat` にリクエスト単位の `options.num_ctx` を渡し、tool calling loop と `read_file`/`list_files`/`search_files`/`write_file`/`edit_file` を自前実装する。専用テスト `tests/test-lean-worker.ps1`（715行、mock Ollama）と opt-in smoke `tests/test-lean-worker-smoke.ps1`（192行、実 Ollama）を持つ。PR #55 で token-aware な automatic context compaction が追加された。責務の内訳（`a4fa523` の行番号、概算）:

| 区画 | 行 | 概算行数 | 性質 |
|---|---|---:|---|
| param / setup / helper | 1-126, 176-188 | ~140 | HDO 固有 |
| workspace boundary（`Resolve-WorkerPath`: 相対必須・prefix 比較・`.git` 拒否・全祖先の link 検査） | 127-175 | ~50 | **security、HDO 固有** |
| tool 定義（read/list/search/write/edit の JSON schema） | 189-237 | ~50 | 形が変わるだけ |
| worker-verified state（`Register-ToolOutcome`, `Get-VerifiedStateBlock`） | 238-379 | ~140 | HDO 固有（compaction の一部） |
| Ollama HTTP client + tool_call の marshalling | 380-449 | ~70 | **SDK が吸収** |
| tool 実装（`Invoke-WorkerTool`） | 450-593 | ~145 | HDO 固有 |
| context accounting / compaction（PR #55） | 594-1095 | ~500 | HDO 固有 |
| schema 読込・system prompt | 1096-1140 | ~45 | HDO 固有 |
| main loop | 1141-1197 | ~57 | **SDK が吸収（骨格のみ）** |
| 最終 forced-schema turn（3回 retry） | 1198-1222 | ~25 | 一部吸収 |

framework が置き換えうるのは太字の ~120-140行（全体の 10-12%）であり、残りは Issue #48 自身が「HDO 独自で維持する」と列挙した責務である。

- **worker と runner の関係**: worker は `command` runner の token 契約（`{hdoRoot}`/`{promptFile}`/`{outputFile}`/`{schemaFile}`/`{model}`/`{contextTokens}`、`config/examples/ollama-lean-worker.json`: `"command": "pwsh"`, `"args": ["-File", "{hdoRoot}/workers/hdo-ollama-worker.ps1", ...]`）の向こう側にいる。フェーズ5の parity（execution plan）とフェーズ6の parity（mock runner による `NoWriteBack` full run）のどちらにも worker の実装言語は現れない。フェーズ5の `src/runners/agentStep.ts`（`runAgentStep`）は codex/claude/command の分岐の手前に「将来の in-process runner（Issue #48）はここに差し込む」というコメントを1行置くに留めた（PR #60）。
- **依存方針**: 直接依存は `ajv`/`ajv-formats`/`koffi`（`koffi` は exact pin、ADR-0002 で owner 承認）。`src/core/boundary.test.ts` は core が import できる非相対 specifier を allow-list（`node:path`, `ajv`, `ajv/dist/2020.js`, `ajv-formats`）で機械的に制限している。`poc/typescript/` は評価時点の実証根拠として凍結済み（`docs/architecture.md` 16.3）。
- **Issue #48 の提案**: outer harness に XState、inner Qwen loop に Vercel AI SDK（`ToolLoopAgent` 等）、HDO 固有の security / validation / runner abstraction は独自実装を維持し、「XState = 次に何をするか、AI SDK = LLM がどう tool を使うか、HDO = 何を許可するか」と責務を分ける構成。LangGraph は durable execution / HITL / parallel が実要件になった時に再評価する。非目標に「security boundary を agent framework に移譲すること」「TypeScript migration と同時に全 orchestration を一括 rewrite すること」を含む。

### 2026-09-06 の owner 決定

評価文書（`issue-48-assessment.md`、2026-09-06、Facts checked は本 ADR 末尾の付録）が owner の判断事項として残した3点に対し、owner は同日次のとおり決定した。本 ADR はこれを決定として記録する。

1. ADR-0003 は docs-only PR として今起票し、Status は `Proposed`（owner が承認したら `Accepted`）とする。
2. lean worker の TypeScript 移植は、フェーズ7と並行ではなく、フェーズ7の**後**に置く新しい Migration strategy **フェーズ8（workers）**とする。
3. 比較 PoC のための依存追加（`ai` + Ollama provider の約12 package）を**認める**。ただし `poc/typescript/` は凍結のまま、新ディレクトリ `poc/ai-sdk/` に置く。

## Decision

### D1. フェーズ6の outer workflow は自作の typed dispatch loop で書く（XState は今は採らない）

`src/core/state/index.ts` の `transition()` を土台に、非終端 state ごとに1つの async handler を持つ `Record<RunState, StepHandler>`（終端 state を `Exclude` した exhaustive record。コンパイラがキー網羅を検査する）を `drive()` が回す。handler は `{ to: RunState; reason: string }` を返し、`drive()` が `transition(state, outcome.to)` で合法性を検査してから `events.jsonl` に `state.transition` event（`from`/`to`/`reason`/`iteration`）を書く。

- **`reason` 文言は遷移を決めた行の隣に置く**（handler の返り値）。oracle（PowerShell の `events.jsonl`）との差分は「どの handler のどの行か」で追える。
- 失敗の集約（任意の throw → FAILED、`PREFLIGHT_FAILED`/`RUN_FAILED` の category 付け、claim の finalize）は `drive()` を包む try/catch 1つで行い、`Invoke-HdoRun` の catch 節と 1:1 に対応させる。
- 遷移図は `EXPLICIT_TRANSITIONS` から Mermaid を生成する（同 module に生成関数を置くか `EXPLICIT_TRANSITIONS` を export する。「図 = 表」をテストで保証する）。手書きの図は持たない。
- `src/core/boundary.test.ts` の allow-list は変更しない。`xstate` を含む state machine ライブラリを `dependencies` に追加しない。
- 得ないもの: actor、snapshot 復元（`run.json` が既にその役）、Stately の GUI。これらは D4 の再評価トリガーに送る。

### D2. inner tool loop はフェーズ8で (a) → (b) → (c) の順に決める

ADR-0001 Migration strategy にフェーズ8（workers）を追加し（同 ADR の Amendment 2026-09-06 参照）、その中で次を順に行う。

- **(a) ベースライン: 依存 0 の `node` 版 worker**。Node 24 native `fetch` で Ollama `/api/chat` を呼ぶ `workers/hdo-ollama-worker.ps1` の 1:1 移植。`command` runner の token 契約と `schemas/*.json` は変更せず、`config/examples/ollama-lean-worker.json` の `command`/`args` の差し替えだけで起動できる形にする。parity は `tests/test-lean-worker.ps1`（715行）を TypeScript へ移植したテスト（mock Ollama、CI gate）で測り、`tests/test-lean-worker-smoke.ps1` の TypeScript 相当（実 Ollama、opt-in、CI gate にしない）で実機確認する。PR #55 の compaction もこの範囲に含める。
- **(b) 比較 PoC: `poc/ai-sdk/`**。`ai`（v7 系）+ Ollama provider（第一候補 `ollama-ai-provider-v2`。`@ai-sdk/openai-compatible` は per-request `num_ctx` を渡せないため route 2 の存在理由を打ち消す - Rationale 参照）を使った `ToolLoopAgent` 版 worker を (a) と**同じ tool 関数・同じ `WorkspaceGuard`・同じ artifact 契約**で組み、Issue #48 の指標（token 消費、completion rate、tool call 精度、32K context での安定性、実装量、security/auditability）で (a) と比較する。依存は `poc/ai-sdk/` 配下の `package.json` に閉じ、repository root の `dependencies` には入れない。`poc/typescript/` は凍結のまま触らない。
- **(c) 採否の記録**。(b) の結果に基づく採否（AI SDK 採用 / ベースライン継続 / 条件付き）を、本 ADR の Amendment または新 ADR として記録する。採用する場合も、root `dependencies` への追加は (c) の決定を経てからにする。

フェーズ8の終了条件 (i)〜(iv)（(a) の parity テスト、opt-in smoke、`config/examples/ollama-lean-worker.json` の `node` 版への更新、(b)(c) の記録）は ADR-0001 Migration strategy の項目8に置く。この4条件を満たした時点で `pwsh` を TypeScript runtime の route 2 要件から外し、PowerShell worker は maintenance mode へ移行する。

### D3. security boundary はどの構成でも framework に委譲しない

Issue #48 の非目標を再確認し、配置を具体化する。

- **workspace boundary は HDO 所有の `WorkspaceGuard`** に置く（`cwd` + `sandbox` から構築。相対 path 必須、prefix 比較、`.git` 拒否、全祖先の reparse point 検査 = `Resolve-WorkerPath` の移植。部品となる `isPathWithinRoot`（`src/platform/paths.ts`）と `PlatformAdapter.isReparsePointInPath`（`src/platform/windows.ts`/`posix.ts`）はフェーズ2で実装済み）。workspace tool（read/list/search/write/edit）は `WorkspaceGuard` を閉じ込めた HDO 製の `execute` 関数として export し、framework にはこの関数を tool として渡すだけで path も fs も渡さない。
- **read-only sandbox では write tool を構造的に存在させない**。`activeTools` のような framework 側の隠し方ではなく、tool の配列自体に `write_file`/`edit_file` を入れない（現行 `-ReadOnly` の `$script:Tools = if ($ReadOnly) { $script:ReadTools } else { ... }` と同じ形）。prompt で解除できない形を維持する。
- **shell / git / build / test を worker から実行しない**（tool を定義しない）。
- **validation / redaction / artifact は呼び出し側が持つ**。workflow から呼ばれる唯一の入口（フェーズ5の `runAgentStep`。評価文書では `invokeAgentStep` と仮称）が、runner 実装がどれであっても runner の外で次を行う: `prompt.md` の書き出し（redacted）と artifact layout（`docs/architecture.md` 12節、両実装共通契約）、`timeoutSeconds` の強制（subprocess は Job Object / `killProcessTree`、in-process は `AbortSignal`）、`stdout`/`stderr`/`final.json` の redaction、`final.json` の Ajv 検証 → redaction → 再検証（現行 `Runner.ps1:717-722` と同じ2回検証）、`run.json.activity` の heartbeat 反映。worktree integrity と diff は workflow 側（現行通り）。
- **`num_ctx` 予算の値・閾値・推定はすべて HDO が決める**。framework は値を渡す口（`providerOptions.ollama.options.num_ctx`）に過ぎない。
- worker の実行形態（`type: command` による out-of-process、または `AgentRunner` を直接実装する in-process）はフェーズ8で決めるが、どちらでも上記の配置は変わらない。out-of-process は契約変更なし・Job Object による確実な kill・クラッシュ隔離をそのまま享受でき、in-process は heartbeat/abort の統合が素直になる代わりに無限ループや巨大 tool result で HDO 本体の memory を巻き込む。

### D4. XState / LangGraph / Mastra の再評価トリガー

次のいずれかが**実要件**（Issue または `.hdo/project.json` で要求される機能）になった時点で、XState・LangGraph・Mastra を同じ表で再評価する。それまでは評価しない。

- actor model が必要になる（planner / implementer / validator / reviewer を独立した actor として invoke し、`onDone`/`onError` を遷移として扱いたい）。
- 並列 reviewer（複数 reviewer の同時実行と集約）。
- human-in-the-loop（run の途中で人の承認を待つ）。
- pause / resume（`run.json` の再読込では足りない、interpreter snapshot の永続化・復元）。

これは Issue #48 が LangGraph を退けた理由（durable execution / HITL / parallel が必要になったら再評価する、推奨導入順序 7）と同じトリガーであり、XState の actor 機能にも同じ形で当てはまる。

## Alternatives

### XState v5 をフェーズ6で採る（不採用）

`xstate@5.32.6`（2026-08-25 公開、MIT、`dependencies` 0、unpacked 2.3 MB、v5.0.0 = 2023-12-01 以後 major なし）は supply-chain としては koffi より軽い。宣言的 machine、`toDirectedGraph()`、`fromPromise` による actor invoke、`getPersistedSnapshot()` を持つ。採らない理由は footprint ではなく parity と抽象化の方向にある（Rationale「XState を今採らない理由」）。

### LangGraph（不採用、再評価トリガー付き）

Issue #48 の整理どおり、durable execution / checkpoint / HITL / parallel が必要になった時に有力。現在の HDO に入れると workflow / state / persistence / agent execution が LangGraph の概念に強く依存し、GitHub label/claim・worktree・file 書き込みという副作用の多い node に idempotency 設計を要求する。D4 のトリガーで再評価する。

### AI SDK を今採り、tool loop を framework に吸収する（不採用）

フェーズ5に AI SDK の in-process runner を含める、あるいはフェーズ8の最初から AI SDK 版を正とする案。不採用の理由: (1) worker の TypeScript 移植そのものがまだ無く、比較対象のベースラインが存在しない。(2) Issue #48 の AC が求める比較指標（token 消費、completion rate、32K 安定性）は実 Ollama で複数回走らせないと出ず、フェーズ5-7の parity 作業とは時間軸も検証手段も違う。(3) 12 package の追加は owner の依存承認事項であり、フェーズ5-7の PR に混ぜると「コード parity の review」と「依存方針の承認」が1つの PR で混ざる。owner は PoC としての依存追加を認めた（Context）ため、(b) の比較 PoC として行う。

### PowerShell worker を恒久的に維持する（不採用）

`command` runner は `command`/`args` の差し替えだけで worker 実装を入れ替えられるため、PowerShell worker を残しても契約上は動く。しかし TypeScript runtime 上で route 2 を使うために `pwsh` が PATH 上に必要という状態が恒久化し、ADR-0001 が Hybrid 永続を退けた理由（2言語での security boundary の重複実装、収束点の不在）がこの1コンポーネントに残る。compaction（PR #55）のような worker 側の機能追加も PowerShell で続けることになる。フェーズ8で移植する。

## Rationale

### XState を今採らない理由（評価文書 §1.3-1.5）

1. **oracle との parity が「機械の中」で決まる**。フェーズ6の合否は `events.jsonl` の `state.transition` 列（`from`/`to`/`reason`/`iteration`）と `run.json` の一致で測る。自作 loop では `transition(from, to)` を呼んだ場所がそのまま event になり、oracle との差分は行で追える。XState では遷移は interpreter が決め、`reason` 文言は event payload か `context` から entry action で組み立て直す必要がある（CHANGES_REQUESTED の4文言、IMPLEMENTING の "Initial"/"Fix" 分岐、PREFLIGHT 失敗時の `PREFLIGHT_FAILED` category など）。表現できないわけではないが、parity test の失敗を「機械定義のどこか」まで掘る1段が増える。これは PowerShell が正典である移行期には純コストで、移行完了後にしか価値に転じない。
2. **`Set-HdoRunState` の副作用順序**。PowerShell は `Save-HdoRun` → `Set-HdoRunState`（内部で `Add-HdoRunEvent` → `Save-HdoRun`）の順で書き、活動 heartbeat が `run.json` を途中更新する。XState の action は同期・fire-and-forget が基本で、file I/O を伴う action の順序保証には `enqueueActions` か invoke への押し込みが要る。oracle 一致に直結する細部である。
3. **boundary の変更**。machine を `src/core/state` に置くなら `boundary.test.ts` の allow-list に `xstate` を追加する = 「core は pure」を「core は pure + xstate」に広げる決定になる。`src/workflow/`（core 外）に置くなら core の表と machine の二重定義になり、両者の一致テストがまた必要になる。
4. **学習曲線と lock-in**。v5 の `setup()` / `assign` / `enqueueActions` / actor system は独自語彙が多い。contributor は owner 1人 + agent であり、review する owner が machine 定義を読んで oracle との等価性を確信できるかが実質のコスト。撤退時は guard/action の中身を手続きへ書き戻す必要がある。
5. **現時点で actor が要らない**。step は直列で1つずつ走り、並列 reviewer も pause/resume も今の要件に無い。

| 観点 | XState v5 | 自作 dispatch loop（D1） |
|---|---|---|
| 依存 | +1 package（0 transitive、MIT、2.3 MB） | 0 |
| フェーズ6 parity（`events.jsonl` 一致） | 表現可能だが interpreter 越し、`reason` は再構成 | 遷移点 = 文言の位置、直接 |
| `boundary.test.ts` | allow-list 拡張 or 二重定義 | 変更なし |
| 可視化 | Stately / `toDirectedGraph` | `EXPLICIT_TRANSITIONS` から Mermaid 生成 |
| 将来の actor / pause-resume | ある | ない（D4 のトリガーで評価） |
| 撤退コスト | guard/action を手続きへ書き戻し | なし |

「80% の価値を0依存で」は妥当であり、移行期には自作案の方が parity テストで有利である。

### AI SDK の事実（評価文書 §2.1、確認日 2026-09-06）

| 項目 | 値 |
|---|---|
| `ai` 最新 | **7.0.93**（2026-09-04）。Issue #48 起票時の想定（`ToolLoopAgent` = v6 導入）より1 major 進んでいる |
| major の間隔 | 4.0.0 2024-11-18 → 5.0.0 2025-07-31 → 6.0.0 2025-12-22 → 7.0.0 2026-06-25（**19か月で4 major**） |
| v7 での改名例 | `stepCountIs` → `isStepCount`、`experimental_output` → `output`、`system` → `instructions`（旧名は `@deprecated`）、`experimental_context` → `runtimeContext`。`index.d.ts` に `@deprecated` が122箇所 |
| ライセンス | Apache-2.0（`ai`, `@ai-sdk/*`, `ollama-ai-provider-v2`）。推移的に `json-schema@0.4.0` が `(AFL-2.1 OR BSD-3-Clause)`、他は MIT |
| engines | `node >= 22`、`"type": "module"` |
| 推移的依存（`ai` + `ollama-ai-provider-v2`、zod 未指定） | **12 packages**: `ai`, `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@standard-schema/spec`, `@vercel/oidc`, `@workflow/serde`, `eventsource-parser`, `json-schema`, `undici@7.29.1`, `ollama-ai-provider-v2`, **`zod@4.5.4`（peer、npm が自動導入）** |
| unpacked 合計 | 約18 MB（`ai` 7.0 MB、`zod` 5.8 MB、`undici` 1.65 MB、`provider-utils` 0.95 MB、`gateway` 0.8 MB、他） |
| HDO が使わないのに入るもの | `@ai-sdk/gateway` + `@vercel/oidc`（Vercel AI Gateway 認証）、`undici`（Node 24 の native fetch と重複）、`zod`（`jsonSchema()` helper で回避できるが peer として入る） |
| 公式 Ollama provider | **存在しない**（`@ai-sdk/ollama` は E404） |
| community provider A | `ollama-ai-provider-v2@4.0.1`（Apache-2.0、maintainer nordwestt 単独、2026-07-08 更新、peer `ai ^7`）。native `/api/chat`、`providerOptions.ollama.options.num_ctx`、`think` on/off、`format` に JSON schema、`prompt_eval_count` → `usage.inputTokens` を実装 |
| community provider B | `ai-sdk-ollama@4.2.0`（MIT、7.6 MB、公式 `ollama` JS client + `jsonrepair` に依存） |
| `@ai-sdk/openai-compatible` 経由 | tools / `response_format` は使えるが、**Ollama の OpenAI 互換 endpoint は per-request の `num_ctx` を受け付けない**（Modelfile + `ollama create` が必要 = route 1 と同じ回避策）。route 2 の存在理由（派生モデル不要）を打ち消す |

### SDK が吸収する責務と HDO に残る責務（評価文書 §2.3）

| 責務 | SDK（`ToolLoopAgent` / `generateText`） | HDO に残る | 備考 |
|---|---|---|---|
| Ollama HTTP 呼び出し、message 形式変換、`tool_calls` の marshalling | 吸収 | - | worker 380-449行相当 |
| tool loop（model → tool_calls → execute → tool result → model） | 吸収 | - | 1141-1197行の骨格 |
| 停止条件（MaxTurns） | `stopWhen: isStepCount(maxTurns)` | 「turn 切れ時に blockers を書けと促す user message」は HDO | `stopWhen` は「最後の step に tool result がある時」だけ評価される。無 tool 終了は SDK が自動停止 |
| tool 入力の schema 検証 | `jsonSchema()` + 任意 validate | Ajv は HDO が持っている | zod 不要だが peer で入る |
| tool 実行エラーの返却 | `tool-error` content part として model に返す（v5 以降） | worker は `ERROR: ...` 文字列で返す | 文言 / 挙動差は PoC で確認 |
| structured final output | `output: Output.object({ schema })` の parse | **順序制御は HDO**: `output.responseFormat` は**全 step に** `tools` と一緒に送られる（ai@7.0.93 `index.js` 5900-5945行）。Ollama native では `format` が全 turn を JSON に拘束し tool 呼び出しと衝突しうるので、現行 worker と同じ「tool loop → 別呼び出しで forced-schema 最終 turn（`think:false`、3回 retry）」の2段構成を HDO が組む | `Output.object` は最終呼び出しでのみ使う |
| step ごとの hook（compaction 差し込み） | `prepareStep`（async、`steps`/`messages`/`stepNumber` を受け取り `messages` を返せる） | policy 本体 | 下記 |
| `num_ctx` 予算 | `providerOptions.ollama.options.num_ctx` を渡す口 | 値の決定・閾値・推定はすべて HDO | provider A のみ。openai-compatible では不可 |
| workspace boundary / read-only 時の write tool 除去 / shell・git・build・test の不実行 / audit artifacts / redaction・schema 再検証・worktree integrity | - | **HDO**（D3） | |

### compaction は SDK 内で実装できる（blocker ではない。評価文書 §2.4）

PR #55 の方針が AI SDK の loop 内で再現できるかを検証した結果、blocker ではない:

1. **history の書き換えが後続 step に持ち越される**（最重要）。ai@7.0.93 `index.d.ts` の `PrepareStepResult.messages` の doc comment: "Optionally override the full set of messages sent to the model for this step. **The override carries forward to later steps.**" loop-control docs: "Returned messages carry forward to later steps, so later `messages` values include your transformed messages plus the assistant/tool response messages from completed steps." したがって `Invoke-ContextCompaction` の「system + task + 圧縮 block + 直近 N 通」への in-place 再構築を、`prepareStep` が返す `messages` で再現でき、毎 step で全履歴を再計算する必要はない。
2. **`prompt_eval_count` が読める**。`prepareStep({ steps })` の `steps.at(-1)?.usage.inputTokens` に provider A は `prompt_eval_count` を入れる。`Test-CompactionThresholdCrossed` の「前回 request の実測 + 追加 message の推定」という射影式はそのまま書ける。
3. **要約のための別 model 呼び出しができる**。`prepareStep` は `Promise` を返せるので、`Update-WorkingSummary` の「新規2 message 会話で schema 強制の要約を取る」を中で `generateText({ output: Output.object })` として呼べる。
4. **worker-verified state は tool の `execute` 内で記録できる**（`Register-ToolOutcome` 相当）。SDK は関与しない。
5. 注意点: (a) `messages` は AI SDK の `ModelMessage` 形式で Ollama native の `{role:'tool', tool_name, content}` と形が違うため、`Measure-MessageTokens`（UTF-8 bytes / 3）の推定値が現行と数 % ずれる（推定は元から保守的で実害は小さいが PoC で実測とのずれを見る）。(b) `Compress-FinalContext`（loop 終了後、最終 turn の前の縮約）は loop の外なので `prepareStep` の対象外。最終 turn は HDO が別呼び出しで組むため現行と同じ場所に置ける。(c) 無 tool の終了 turn での閾値判定（worker 1158-1163行）は `prepareStep` が次 step の前にしか呼ばれないため、loop 終了後に `result.response.messages` を見て HDO が行う。(d) v7 で `prepareStep` 周辺の型（`runtimeContext`, `toolsContext`, `experimental_sandbox`）が増えており次 major でまた動く可能性が高い。compaction policy は SDK の型に直接書かず、`(history, lastInputTokens) => history` という HDO 純関数にして `prepareStep` からは1行で呼ぶ形にすれば SDK 側の変化から隔離できる。

### なぜ今すぐ採らず (a) → (b) → (c) にするか（評価文書 §2.5）

| 観点 | AI SDK + `ollama-ai-provider-v2` | 0依存 `fetch` 移植（(a)） |
|---|---|---|
| 削れる行数（1222行中） | ~120-140（10-12%） | 0（ただし PS→TS の 1:1 移植で自然に短くなる） |
| 依存 | +12 packages / ~18 MB、Apache-2.0 主体、peer `zod` 自動導入、Vercel 固有コード同梱 | 0（`ajv` は既存） |
| 変化速度 | 19か月で4 major、deprecated 122箇所 | Ollama `/api/chat` の JSON 契約のみ |
| Ollama provider の bus factor | 公式なし、community 単独 maintainer | 該当なし |
| compaction 実装可否 | 可（`prepareStep` carries forward） | 可（現行そのまま） |
| structured output | `Output.object` の parse は楽。ただし2段構成は自前 | `format` + Ajv（既にある） |
| 将来 provider を増やす（OpenAI / Anthropic 直叩き worker） | 強い（provider 差分を吸収） | provider ごとに client を書く |
| security boundary | どちらも HDO 側。差なし | 同左 |

今の要件（Ollama 1 provider、32K 安定運用）では、SDK が吸収する 10-12% の見返りに 12 package と major 追随を受け入れる釣り合いは取れていない。一方で「Qwen 以外の provider を worker 経由で使いたい」「tool loop の provider 差分を吸収したい」という要件が出れば釣り合いは変わる。owner は比較 PoC の依存追加を認めたので、この判断を推測ではなく Issue #48 の指標で測って (c) で決める。ベースライン (a) 無しに PoC を作っても比較にならないため順序は (a) → (b) → (c) とする。

### フェーズ8をフェーズ7の後に置く理由（owner 決定）

- フェーズ7は cut-over の瞬間（`commands/*.md`・`skills/*/SKILL.md` の呼び出し経路が `pwsh` から `node` へ切り替わる）であり、7コマンド parity に注意を集中させたい。
- worker は `command` adapter の向こう側にいてフェーズ6/7の parity に現れない（Context）。並行させてもフェーズ7の parity を助けず、review の焦点だけが割れる。
- 移植は大きい（1222行 + 715行の `tests/test-lean-worker.ps1` + PR #55 の compaction）うえ、完了判定に実 Ollama の smoke という、フェーズ6/7の mock ベース parity とは異なる検証方法を要する。
- 帰結: フェーズ7の cut-over からフェーズ8完了までの間、TypeScript runtime 上で route 2 を使うには `pwsh` が PATH 上に必要である（既知の制限、opt-in の経路に限る。Consequences）。

## Consequences

**Positive**:

- フェーズ6の outer workflow は依存 0・`boundary.test.ts` 不変で書け、`events.jsonl` の oracle と行単位で比較できる。
- inner loop の framework 採否が推測ではなく実測（Issue #48 の指標）で決まり、その決定が Amendment / 新 ADR として残る。
- security boundary の置き場所（`WorkspaceGuard`、tool 配列、`runAgentStep`）が framework の採否に依存しないため、(b) の PoC は (a) と tool 関数・artifact 契約を共有でき、比較が公平になる。
- Issue #48 の「trade-off を記録する」AC と、Issue #37 が残した「worker 移植のフェーズ」が同日の ADR-0001 Amendment と本 ADR で閉じる。

**Negative**:

- **`pwsh` が route 2 に残る窓**: フェーズ7の cut-over からフェーズ8完了までの間、TypeScript runtime の route 2（`config/examples/ollama-lean-worker.json`）は引き続き `pwsh` を PATH 上に要求する。`pwsh` が無い環境では `doctor` の `runner:<name>` 検査（`src/workflow/preflight.ts`）が `Runner command 'pwsh' was not found.` で fail する形で表面化する。route 1（claude+ollama）と cloud route には影響しない。
- **`ai` v7 の version churn**: 19か月で4 major、`@deprecated` 122箇所という変化速度は、(c) で採用する場合に継続的な追随コストになる。(b) の PoC は `ai` と provider を exact pin し、compaction policy を SDK 型から隔離した純関数として書く。
- **`poc/ai-sdk/` の依存は PoC 限定**: 約12 package（`zod` 含む）は `poc/ai-sdk/package.json` に閉じ、(c) の決定まで repository root の `dependencies` に入れない。`npm ci` の対象にも CI gate にもしない。新ディレクトリの追加は「`poc/typescript/` は凍結」の意味を弱めうるため、`poc/ai-sdk/README.md` に PoC の目的・比較対象・凍結条件を明記する。
- フェーズ8は実 Ollama を要する opt-in smoke を完了条件に含むため、CI だけでは完了を判定できず、owner の実機実行が要る。

**Neutral**:

- `src/core/boundary.test.ts` の allow-list、`schemas/*.json`、`command` runner の token 契約、artifact layout はどの構成でも変更しない。
- Issue #48 が挙げた OpenAI Agents SDK / Mastra / VoltAgent は本 ADR で個別評価していない。D4 のトリガーが立った時に LangGraph と同じ表で扱う。
- worker の out-of-process / in-process はフェーズ8の (a) で決める（D3）。

## References

- GitHub Issue #48（エージェントハーネス軽量化の検討: AI SDK + XState を LangGraph 代替として評価する）- 本 ADR の対象
- GitHub Issue #37（Node/TypeScript 移行のスコープに Ollama 対応を明記する）- AC-01/AC-02 は ADR-0001 Amendment 2026-09-06、worker 移植のフェーズは本 ADR
- PR #60（ADR-0001 フェーズ5）- `src/runners/agentStep.ts` の in-process runner seam コメント
- PR #55（Ollama lean worker の token-aware automatic context compaction）
- ADR-0001（`docs/adr/0001-primary-runtime-typescript.md`）Migration strategy フェーズ6・7・8、Amendments 2026-09-06
- ADR-0002（`docs/adr/0002-windows-job-object-via-koffi.md`）- 依存追加の前例（exact pin、owner 承認）
- 評価文書: `issue-48-assessment.md`（2026-09-06、`origin/main` = `a4fa523` に対する read-only 調査。repository 外に置かれた作業文書であり、本 ADR が結論と Facts checked を取り込む）
- `src/core/state/index.ts`、`src/core/boundary.test.ts`、`src/runners/agentStep.ts`、`workers/hdo-ollama-worker.ps1`、`tests/test-lean-worker.ps1`、`tests/test-lean-worker-smoke.ps1`、`config/examples/ollama-lean-worker.json`
- AI SDK: https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text 、https://ai-sdk.dev/docs/agents/loop-control
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- `ollama-ai-provider-v2`: https://github.com/nordwestt/ollama-ai-provider-v2

## Appendix: Facts checked（確認日 2026-09-06、開発機 Windows 11 / Node 24 から。評価文書より転記）

| # | 事実 | 確認方法 / 出典 |
|---|---|---|
| F1 | `xstate@5.32.6`, MIT, `dependencies` なし, unpacked 2,294,177 bytes, 2026-08-25 公開; v5.0.0 は 2023-12-01 | `npm view xstate version license dependencies dist.unpackedSize time`（registry.npmjs.org） |
| F2 | xstate lockfile-only install で packages=1; `exports` に `./graph`, `./actors`, `./guards`, `./actions`; `dist/declarations/src/graph/graph.d.ts` に `toDirectedGraph`, `TestModel.d.ts` に `getShortestPaths`/`getSimplePaths`; `getPersistedSnapshot`, `getNextSnapshot`, `transition` あり | `npm install --package-lock-only --ignore-scripts xstate@5` と `npm pack xstate@5.32.6` の tarball 実測（`$TEMP/hdo-phase5/npm-scratch`） |
| F3 | `ai@7.0.93`, Apache-2.0, `engines.node >= 22`, `"type":"module"`, deps `@ai-sdk/gateway@4.0.75` / `@ai-sdk/provider@4.0.10` / `@ai-sdk/provider-utils@5.0.36`, peer `zod ^3.25.76 \|\| ^4.1.8`（optional 指定なし）, unpacked 7,013,975 bytes, 2026-09-04 公開 | `npm view ai ...`、tarball `package.json` |
| F4 | `ai` major 公開日: 4.0.0 2024-11-18, 5.0.0 2025-07-31, 6.0.0 2025-12-22, 7.0.0 2026-06-25 | `npm view ai time --json` |
| F5 | `ai@7.0.93` + `ollama-ai-provider-v2@4.0.1`（zod 未指定）の lockfile-only install = 12 packages、`zod@4.5.4` が peer として自動導入; 一覧: `@ai-sdk/gateway`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `@standard-schema/spec@1.1.0`(MIT), `@vercel/oidc@3.2.0`(Apache-2.0), `@workflow/serde@4.1.0`(Apache-2.0), `ai`, `eventsource-parser@3.1.1`(MIT), `json-schema@0.4.0`((AFL-2.1 OR BSD-3-Clause)), `undici@7.29.1`(MIT), `ollama-ai-provider-v2`, `zod`(MIT); `@ai-sdk/openai-compatible@3.0.44` に置き換えても 12 | `npm install --package-lock-only --ignore-scripts` 実測 |
| F6 | unpacked sizes: `zod@4.5.4` 5,797,652; `undici@7.29.1` 1,652,058; `@ai-sdk/provider-utils` 954,538; `@ai-sdk/gateway` 799,520; `@ai-sdk/provider` 640,757; `@ai-sdk/openai-compatible` 418,015; `ollama-ai-provider-v2` 355,808; `@vercel/oidc` 153,406; `ai-sdk-ollama@4.2.0` 7,633,959 | `npm view <pkg> dist.unpackedSize` |
| F7 | `@ai-sdk/ollama` は npm に存在しない（E404） | `npm view @ai-sdk/ollama` |
| F8 | `ollama-ai-provider-v2@4.0.1`: Apache-2.0, maintainer nordwestt, 2026-07-08 更新, peer `ai ^7.0.0`, `zod ^4.0.16`; default base URL `http://127.0.0.1:11434/api`（native）; `buildBaseArgs` が `format: responseFormat.schema`, `think`, `options: ollamaOptions.options` を送る; `ollamaProviderOptions` schema に `options.num_ctx`; `usage.inputTokens.total = prompt_eval_count`, `outputTokens.total = eval_count`; completion model のみ `responseFormat (JSON)` unsupported 警告 | `npm pack ollama-ai-provider-v2@4.0.1` → `dist/index.mjs` 380-392, 453-460, 765-772, 950-961, 1297-1327, 1630 行; README https://github.com/nordwestt/ollama-ai-provider-v2 |
| F9 | `PrepareStepResult.messages` の doc comment: "Optionally override the full set of messages sent to the model for this step. The override carries forward to later steps."; `instructions` も同様に carries forward; `prepareStep` は `PromiseLike<PrepareStepResult>` を返せる; `PrepareStepOptions` は `steps`, `stepNumber`, `model`, `messages`, `instructions`, `runtimeContext`, `toolsContext` を受ける | ai@7.0.93 tarball `dist/index.d.ts`（`type PrepareStepResult` 付近、1706-1730 行）; https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text |
| F10 | loop-control docs: "Returned messages carry forward to later steps, so later `messages` values include your transformed messages plus the assistant/tool response messages from completed steps"; "The `stopWhen` parameter controls when to stop execution when there are tool results in the last step"; loop 停止条件 = finish reason が tool-calls 以外 / execute の無い tool / approval 要求 / stop condition | https://ai-sdk.dev/docs/agents/loop-control |
| F11 | `generateText` は各 step の model 呼び出しで `responseFormat: await output?.responseFormat` を `tools: stepTools` と同時に渡す | ai@7.0.93 `dist/index.js` 5900-5945 行 |
| F12 | ai@7: `declare class ToolLoopAgent<...>`; `isStepCount(n)` が StopCondition helper（`stepCountIs` は文字列として 1 箇所のみ残存）; `hasToolCall`, `isLoopFinished`; `ToolLoopAgent` の `stopWhen` 既定 `isStepCount(20)`; `jsonSchema()` helper は `@ai-sdk/provider-utils` から re-export（zod 不要で tool の inputSchema を書ける）; `index.d.ts` に `@deprecated` 122 箇所; tool 実行失敗は `type: "tool-error"` content part | tarball `dist/index.d.ts` 1800, 5077, 5271 行 / `dist/index.js` 3067 行 |
| F13 | Ollama の OpenAI 互換 `/v1/chat/completions` は per-request `num_ctx` 非対応。"The OpenAI API does not have a way of setting the context size for a model. If you need to change the context size, create a `Modelfile`"; 対応 field: model, messages, temperature, top_p, max_tokens, stop, stream, seed, response_format, frequency/presence_penalty, tools, reasoning_effort, stream_options; 非対応: tool_choice, logit_bias, user, n, logprobs | https://docs.ollama.com/api/openai-compatibility |
| F14 | repository 側: `package.json` deps = `ajv ^8.17.1`, `ajv-formats ^3.0.1`, `koffi 3.2.1`; `src/core/boundary.test.ts` allow-list = `node:path`, `ajv`, `ajv/dist/2020.js`, `ajv-formats`; `State.ps1` `Set-HdoRunState` は `{type:'state.transition', from, to, reason, iteration}` を `events.jsonl` に追記; worker 各区画の行番号は Context の表 | worktree `a4fa523` 実測 |
| F15 | Issue #48 本文（AC 8 項目、非目標 4 項目、推奨導入順序 7 段）、Issue #37 本文（AC-01〜05、worker 447 行時点の記述; 現在は 1222 行） | `gh issue view 48 --json`, `gh issue view 37 --json`（2026-09-06、いずれも comments 0 件） |

補足（本 ADR 起草時、`5748aea` で再確認）: `workers/hdo-ollama-worker.ps1` は 1240 行（PR #58 の修正分）、`tests/test-lean-worker.ps1` 715 行、`tests/test-lean-worker-smoke.ps1` 192 行、`src/core/state/index.ts` 117 行、`package.json` の `dependencies` は F14 と同一。
