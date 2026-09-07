# ADR-0001: HDO の primary implementation runtime

## Status

Accepted (2026-09-05) — 2026-09-04 に Proposed として起草し、評価文書・PoC・review を経て repository owner が 2026-09-05 に承認した。

## Context

HDO は現在 PowerShell 7.2+ を runtime とし、GitHub Issue の正規化、config merge、Git worktree 管理、Codex/Claude/Ollama runner abstraction、bounded subprocess 実行、state machine、artifact 永続化、structured review/fix loop を実装している（`docs/architecture.md`）。実装規模は `src/HybridDevOrchestrator/Private/*.ps1` + `hdo.ps1` + `workers/*.ps1` で約4514行、test harness を含めると6830行（本 branch実測）。

Issue #18 は、HDO が今後 multiple reviewer、parallel agent、provider 追加、remote execution、daemon/scheduler、Web UI、telemetry 等へ拡張する可能性を踏まえ、PowerShell 7 を長期的な application runtime として維持することが適切かを明示的に評価するよう求めている。Issue #15 は WSL2/Linux 正式対応を PowerShell 継続前提で計画しているが、その大きな platform-specific 変更に着手する前に本 Issue の結論を出すことが望ましいとされている。

比較の詳細は `docs/evaluation/powershell-vs-typescript.md`（評価）と `docs/evaluation/typescript-architecture-proposal.md`（アーキテクチャ提案）に記録した。両文書は `poc/typescript/` の実装・実行結果（Windows 11 実機、Ubuntu 24.04 Docker コンテナ）を実証根拠として引用している。CI `poc-typescript.yml` はワークフロー定義として追加済みだが、本 PR がその最初の実行であり、CI 実行結果そのものはまだ実証根拠に含めていない。

## Decision

TypeScript / Node.js 24 LTS を HDO の中長期 primary implementation language / runtime として採用する。移行は strangler-style の phased migration とし、一括書き換えは行わない。

- PowerShell 7 実装は、Migration strategy フェーズ6（`NoWriteBack` full run。決定論的な mock runner で測定し、実 agent には依存しない）の終了条件を満たし、かつフェーズ7の (i)・(ii) 両方（`doctor`・`config`・`inspect`・`run -DryRun`・`status`・`cleanup -WhatIf`・`labels -WhatIf` の7コマンドすべてについて parity）に達した時点で、maintenance mode（既存不具合の修正のみ、新規 subsystem の追加はしない）へ移行する。
- Python は候補としない（AC-08、評価文書7節）。
- Bun は primary runtime として採用しないが、コーディング規約（`erasableSyntaxOnly`、`types: ["node"]`、`node:` prefix import のみ、相対 import への `.ts` 拡張子明記、tsconfig `paths` 不使用）により将来の選択肢として道を残す（評価文書8節）。

**この決定を見直すべき条件（revisit condition）を明示する:**

1. Migration strategy フェーズ2 完了時点で、`tests/fixtures/runtime/hold-output-handle.ps1` および `ignore-input.ps1` と同一シナリオの Windows test を、platform別 prebuilt binary（native addon / FFI、`koffi` 等）無しには pass させられないと判明し、かつ owner がその追加依存（ビルド環境、platform別バイナリ配布）を受け入れないと判断した場合。
2. plugin 経由起動（Claude Code / Codex）での `doctor` の `node-version` check fail 率が運用実績として悪化した場合。暫定閾値: plugin 経由起動の直近30日間で `doctor` の `node-version` check fail が5%を超える（計測は各 run artifact の `environment.json` 集計に基づく）。`node` そのものが PATH に無いケースはこの計測方法では捕捉できない（run 自体が起動せず `environment.json` が書かれないため）ため、この条件からは意図的に除外している。この閾値は Migration strategy フェーズ7完了時に正式な値へ改定してよい。
3. Node 24 LTS の EOL 前に、後継 LTS で native type stripping や SEA のサポートが後退（撤回・experimental 降格等）した場合。

## Alternatives

### PowerShell 7 継続

**誠実な擁護**: 現在稼働中で6830行相当のテスト済み実装がある。Windows Job Object という OS 保証への到達手段を既に持つ（`Common.ps1` の `BoundedProcessCapture.KillOnCloseJob`）。npm グローバルの `.cmd`/`.bat` shim も、明示パスを渡す限り `shell: true` なしで実行できる（bare コマンド名では `Get-Command` が `.ps1` を優先解決し、`npm.cmd` のような shim の解決は実測で THROW するため、この優位は明示パスを渡す場合に限られる）。`Test-Json` を標準搭載し、追加の JSON Schema validator 依存が要らない。外部パッケージ依存がゼロで、supply chain surface が最小である。書き直しに伴う regression risk そのものが発生しない。

**採用しない理由**: MCP、GitHub App、Web API/UI という Issue #18 のロードマップにおいて、PowerShell には一次言語としてのエコシステムが存在しない。型システムによるコンパイル時検査、`boundary.test.ts` のような依存方向の機械的強制が言語機能として得にくい。

### TypeScript（採用）

評価文書9節「総合評価」で示した通り、Architecture/Maintainability と Ecosystem/Future Expansion で明確な優位を持ち、Cross-platform と Security は同等、Process Orchestration（Windows Job Object）のみ PowerShell が優位という結果に基づく。

### Python（不採用）

評価文書7節の通り、pydantic/jsonschema・asyncio subprocess・uv・PyInstaller は揃うが、MCP 公式 SDK は TypeScript 版と対等な位置づけではあるものの reference implementation ではない。GitHub App/Octokit エコシステムも JS ほど厚くない。TypeScript/PowerShell のいずれに対しても明確な優位点がなく、AC-08 に従って候補から外す。

### Bun-first（不採用）

`bun build --compile` の単一バイナリ配布は Node SEA より実務的に成熟している。process/signal のエッジケース報告があり、JSON Schema の built-in support もない。native addon については、V8 の C++ API に直接依存する addon は Bun（JavaScriptCore ベース）と非互換だが、Node-API addon（`koffi` を含む）は Bun が独自実装しており概ね動作するとされる（この PoC では未検証）。Claude Code CLI 自体の native install が Bun でコンパイルされている事実（手元の `claude.exe` に Bun 1.4.1 / JavaScriptCore のマーカーを確認）を踏まえると「Bun の Windows 実績が浅い」と単純化するのは不正確で、正確には HDO 固有の process 制御挙動が Bun 上で未検証という点に絞られる。評価文書8節の通り、コーディング規約でこの選択肢を潰さずに Node を primary とする。

### Hybrid 永続（PowerShell core + TypeScript surface、不採用）

「PowerShell で orchestration core を維持し、TypeScript は CLI surface だけを持つ」という永続的な2言語構成も検討したが採用しない。理由:

- 2つの runtime を同時に保守すると、config schema・state machine・security boundary（redaction、path境界検査等）を2言語で重複実装し続けることになり、どちらか一方が先に更新されて契約が乖離する risk が常態化する。
- 「surface だけ TypeScript」では Issue #18 が挙げる MCP/GitHub App/Web API 等の拡張はいずれも core 側（workflow, runner abstraction）に触れる必要があり、surface 分離では実質的な恩恵を得られない。
- 一時的な移行期の二重実装（Migration strategy 参照）と、意図的な恒久2言語構成は目的が異なる。前者はフェーズ6の `NoWriteBack` full run parity（mock runner 測定）とフェーズ7の (i)・(ii) 7コマンド parity という具体的な収束点を持ち、それに達した時点で PowerShell は maintenance mode へ移行し二重実装は終わる（Decision節）。後者（恒久Hybrid）にはこの種の収束点が存在せず、2言語の重複保守が終わる時点そのものが定義できない。

## Rationale

- **Architecture/Maintainability**: `src/core/state/index.ts` の `RunState` union + `EXPLICIT_TRANSITIONS`（`Record<RunState, readonly RunState[]>`）は、TypeScript のコンパイラが全 state のキー網羅を検査する。PowerShell の `State.ps1`（95行）は同じ遷移表を実行時検査のみで持つ。`src/core/boundary.test.ts` は「core が import してよい非相対 specifier は `node:path`/`ajv`/`ajv-formats` の allow-list のみ」であることをテストとして機械的に強制している（deny-list ではなく allow-list 方式。`node:child_process`/`node:os`/`node:fs`/`../platform`/`../process`/`../git`/`../cli` はこの allow-list に無い一例）。PowerShell module には現行コードとしてこの検査を行うものは無い（`Select-String` ベースの同種の静的検査や PSScriptAnalyzer custom rule で同等のことを実現するのは技術的には可能）。TypeScript 側の実質的な優位は `boundary.test.ts` というテストそのものではなく、型検査と IDE の go-to-definition/rename の精度によるリファクタリング安全性にある。
- **Cross-platform**: PoC は `PlatformAdapter`（`windows.ts`/`posix.ts`）で pathEquals・resolveExecutable・isReparsePointInPath・killProcessTree を実装し、Windows/Ubuntu 双方で計80件（Windows 75 pass / 5 skip、Ubuntu 72 pass / 8 skip、いずれも0 fail。skip は相補的な OS 固有ケース）を実測した。root containment（`isPathWithinRoot`/`comparableFullPath`）は `resolve()` で `..` を先に畳んでから最深の実在祖先を realpath する形にしており、traversal を拒否するテストも追加している（`git/index.test.ts`）。「Node にすれば cross-platform 問題が自動解消する」という前提は採らず、両OSとも同等の作り込みが必要という Issue #18 の前提を維持したまま評価している。
- **Ecosystem**: `@modelcontextprotocol/sdk` は TypeScript-first（TypeScript SDK が reference implementation。Python SDK も公式で対等な位置づけ）、Octokit/GitHub App エコシステムは JS-first。PowerShell にはどちらの一次言語としての選択肢もない。
- **Security（実証範囲）**: `redactSecrets`/`redactObject`（`core/process/redact.ts`）は PowerShell の `Protect-HdoText`/`Protect-HdoObject` と同等の契約を実測レベルで再現した。`NodeProcessRunner`（`spawn` の argv 配列渡し、`shell: true` 不使用）は `Invoke-HdoProcess` の数値契約（32 MiB/64 KiB既定、exit code 124/125/126/127、drain 2秒）は再現したが、spawn 失敗時の扱い（PowerShell は例外を throw、PoC は127を返す値として扱う）と終了原因の優先順位付けの semantics（PowerShell は固定優先順位チェーン、PoC は先着順）は異なる。`isReparsePointInPath`/`isPathWithinRoot` は `Test-HdoReparsePointInPath`/`Test-HdoPathWithinRoot` と同等のロジックを再現した。`Get-HdoSafeEnvironment` の deny-list は `getSafeEnvironment()`（`core/process/safeEnvironment.ts`）として core に移植したが未配線のまま（F-09。`doctor`/`probe`/`GitClient` のどこからも呼び出していない）（評価文書6節）。

**最も強い反論とそれが決定を変えない理由:**

- 「Windows Job Object の確実性を失う」（`taskkill /T /F` は孫プロセスの再親化に対して脆弱）: 事実として認める。これは両実装が同じ状況を再現しているのではなく、PowerShell に実在する優位である。しかも実際の gap は「`detached` な孫が breakaway する」場合に限らない、より広いものだと判明している: libuv は `SILENT_BREAKAWAY_OK` を設定した process-wide の Job Object を使うため、`detached` の指定に関わらず孫プロセスは最初から一切 Job のメンバーになれない。PowerShell 実装は Windows で `tests/test-process-output.ps1` の `hold-output-handle.ps1` シナリオ（.NET `Process.Start` で生成した非 breakaway な孫。libuv の Job とは無関係）を、breakaway フラグ無しの `KillOnCloseJob`（`Common.ps1:128-180`）で確実に処理し、孫プロセスごと終了させて exit 0 を返す。同じシナリオを PoC の `NodeProcessRunner` に通すと、孫プロセスは `SILENT_BREAKAWAY_OK` により libuv の Job に入っておらず、直接の子が既に exit した後は `taskkill /T` が辿る生きた根が無いため Windows 上で生き残り、`outputDrainTimedOut: true` とともに 127 を返す（評価文書3.3節）。この gap を埋めるかどうか（native addon/koffi の採否、または既知限界としての明示的な受容）は Migration strategy フェーズ2 の終了条件とし、Consequences の negative にも明記する。TypeScript 側で `hold-output-handle.ps1` 相当の Windows シナリオを pass させる（native addon / FFI / .NET helper / 既知限界の文書化のいずれか）ことを、フェーズ2 の達成基準として明示する。
- 「Ajv という追加依存が増える」: 事実。PowerShell の `Test-Json` はゼロ依存である。PoC は直接 runtime dependency を Ajv 1系統（`ajv`+`ajv-formats`）に限定する方針を実際に守っているが、推移的依存を含めると `package-lock.json` に記録された実行時 package は6個になる。`npm ci --ignore-scripts` は install 時の lifecycle script 実行を止めるだけで、この6 package 自体が実行時に読み込まれること自体は変わらない。
- 「6830行のテスト済み資産を捨てるリスク」: この ADR は「一括書き換え」を決定していない。Migration strategy が定める通り、PowerShell 実装は parity 到達まで正典であり続け、fixture を両実装の contract として共有することで regression を検出する。

## Consequences

**Positive**:

- 型システムと `boundary.test.ts` 相当の機械的検査により、大規模化時の保守性が向上する。
- MCP、GitHub App、Web API/UI という将来ロードマップに対して一次言語のエコシステムを利用できる。
- `node:test` 標準搭載により、追加パッケージなしで unit test を書ける。

**Negative**:

- 稼働中で6830行相当のテストされたPowerShell実装に対する rewrite effort と regression risk が生じる。
- `ajv`/`ajv-formats` という npm supply-chain surface が新たに増える（直接依存2、推移的依存を含め6 package。PowerShell実装は外部パッケージ依存ゼロ）。
- Windows Job Object という inline C#/Win32 reach を失う（`taskkill /T /F` は孫プロセス再親化に対して脆弱で、孫プロセスは `detached` の指定に関わらず `SILENT_BREAKAWAY_OK` により libuv の Job に一切含まれず、直接の子が既に exit していれば生き残ることがある）。native addon/FFI で取り戻す場合はビルド・配布の複雑性が増す。
- npm グローバルの `.cmd`/`.bat` shim（`claude`/`codex` 等）を `shell: true` なしでは直接 spawn できない（EINVAL, CVE-2024-27980）。PowerShell の `Invoke-HdoProcess` は `.cmd` パスを明示すれば実行できるが、bare コマンド名では `Get-Command` が `.ps1` を優先解決し npm-global shim を実測で THROW するため、この差は限定的である。`config/hdo.default.json` の既定 `"command": "claude"` が今日動くのは native installer が `claude.exe`（shim ではない）を提供しているからであり、TypeScript 側も同様に shim を辿るか `.exe` インストーラ版に頼る追加実装が要る。
- 移行期間中、PowerShell 実装と TypeScript 実装が並存し、二重の保守コストが発生する。
- contributor が TypeScript を習得する必要がある。
- plugin 実行環境（Claude Code / Codex）に `node` 24+ が PATH 上に存在することが新たな前提になる。Claude Code CLI は npm 配布の Node.js アプリケーションとしても、Bun でコンパイルされた native バイナリとしても配布されるが、どちらの配布形態も plugin から呼ばれるサブプロセスへの `node` on PATH を保証しない。Codex CLI は Rust製で何もバンドルしない。

**Neutral**:

- Python・Bun は不採用のまま、コーディング規約により Bun という選択肢だけは技術的に残る。
- 配布方式は当面 repository-local（plugin root + `npm ci`）であり、npm package化・単一バイナリ化は需要が生じてから検討する。

## Migration strategy

移行は次の順序でモジュールを段階的に TypeScript へ移す。各フェーズは「終了条件」を満たしてから次へ進む。カレンダー日程は定めない。

1. **core contracts / config / state**: `schemas/*.json` の Ajv validation、config source merge（`config/hdo.default.json` < user config < repository config < explicit `-Config` < programmatic override < profile/route < `-SetStep`）、`RunState` 遷移表を TypeScript で実装する。終了条件: `config/hdo.default.json`・`config/examples/*.json`・`.hdo/project.json`（config, repository-config, project-contract の各 schema）と `tests/fixtures/schema/**` 配下の全 fixture（issue-contract, task-contract, worker-result, review-result, repository-config）が、PowerShell 側の `test-schemas.ps1` と同じ valid/invalid 判定になる（`schemaFixtures.test.ts` 相当を本番規模へ拡張）。
2. **process / platform**: `NodeProcessRunner`（bounded output, timeout, process tree kill）と `PlatformAdapter`（Windows/POSIX）を本番品質へ引き上げる。終了条件: `tests/fixtures/runtime/hold-output-handle.ps1`・`ignore-input.ps1`・`spam-output.ps1` と同一シナリオの test を `windows-latest`/`ubuntu-latest` の両 CI で pass させる（Windows は `tests/test-process-output.ps1:95-100` の `$IsWindows` 分岐と同じ assertion - exitCode 0、`outputDrainTimedOut` が false、孫 PID が `Get-Process` で見つからないこと - を oracle として満たす）、または Windows の Job Object 未対応（Rationale「最も強い反論」参照。孫プロセスが `SILENT_BREAKAWAY_OK` により Job のメンバーになれないという既知限界）を owner が明示的に受け入れる決定として新しい ADR（ADR-0002 以降）に記録するかのいずれかを満たし、かつ longpath 対応（Issue #25 相当）を実装する。
3. **git**: `GitClient` に `diff --numstat`・porcelain status 取得を追加し、`Get-HdoDiff` 相当の完全な diff 構築（tracked + untracked、32 MiB上限）を実装する。終了条件: PowerShell側の `tests/run-tests.ps1` にある worktree/diff関連ケースと同じ入出力になることを、共有 fixture で確認する。
4. **github**: Issue 正規化（`ConvertTo-HdoIssueContract`）、pickup 順序、claim/label同期、`trustedActors` 検証を実装する。終了条件: `hdo issues`/`hdo inspect` の出力が同一 Issue に対して PowerShell 版と一致する。
5. **runners**: Codex/Claude/command adapter を実装する。終了条件: 同一 prompt/schema に対する `hdo run -DryRun` の execution plan が両実装で一致する。Ollama 対応（route 1/2、`contextTokens`、doctor 検査）のスコープと完了条件の詳細は Amendments の「Ollama 対応の移行スコープ（Issue #37）」を参照。
6. **workflow**: plan→implement→validate→review→fix の bounded loop、`.hdo/project.json` の gate 実行を実装する。終了条件: `NoWriteBack` full run が両実装で同じ state 遷移・同じ diff・同じ review 判定に到達する。判定には `tests/fixtures/runtime/mock-agent.ps1`/`mock-claude.cmd`/`validation-pass.ps1` 相当の決定論的な mock runner を使用し、実 agent（Claude/Codex/Ollama）には依存しない。**完了（2026-09-06）**。測定方法・13シナリオ・実装した Issue 修正（#16, #62, #63, #8）の詳細は `docs/architecture.md` §16.2「フェーズ6（workflow）は完了した」を参照。
7. **cli / plugin**: まず `hdo` CLIコマンド群（`help`/`doctor`/`config`/`issues`/`inspect`/`run`/`status`/`cleanup`/`labels`）を TypeScript 実装へ移植し、parity を確認する。終了条件（この順で満たす）: (i) `doctor`・`config`・`inspect`・`run -DryRun` の4コマンドについて `-Json` 出力が両実装で意味的に等価になる、(ii) `status`・`cleanup -WhatIf`・`labels -WhatIf` についても `-Json` 出力が共有 fixture に対して両実装で意味的に等価になることを追加で確認する。(i)・(ii) の parity 確認が両方完了して初めて、全8個の `commands/*.md`・全8個の `skills/*/SKILL.md` の呼び出し経路を TypeScript 実装へ切り替える（`allowed-tools` を `Bash(pwsh:*)` から `Bash(node:*)` へ、`plugin.json` の `description`/`keywords` も同時に更新し、片方だけ pwsh 呼び出しが残る中間状態を作らない）。**完了（2026-09-07）**。測定方法・cut-over の内容は `docs/architecture.md` §16.2「フェーズ7（cli/plugin）は完了した」を参照。Decision 節が定める PowerShell orchestrator の maintenance mode 移行（フェーズ6・7両方の終了条件を満たした時点、Amendment 2026-09-06「フェーズ8（workers）の追加」参照）はこの完了時点で発効した。`workers/hdo-ollama-worker.ps1` はフェーズ8完了まで live のまま残る唯一のコンポーネントである点は変わらない。
8. **workers**（Amendment 2026-09-06「フェーズ8（workers）の追加と lean worker 移植の位置づけ」で追加。ADR-0003 と対で読む）: フェーズ7の cut-over 完了後に、route 2 の lean worker `workers/hdo-ollama-worker.ps1` を TypeScript へ移植する。順序は (a) 依存 0（Node 24 native `fetch` で Ollama `/api/chat` を呼ぶ）の `node` 版 worker をベースラインとして実装する → (b) `poc/ai-sdk/` に AI SDK（`ai` + Ollama provider）版の比較 PoC を置き、Issue #48 の指標（token 消費、completion rate、tool call 精度、32K context での安定性、実装量、security/auditability）で (a) と比較する → (c) 採否を ADR-0003 の Amendment または新 ADR に記録する。`command` runner の token 契約（`{hdoRoot}`/`{promptFile}`/`{outputFile}`/`{schemaFile}`/`{model}`/`{contextTokens}`）と `schemas/*.json` は変更しない。終了条件（すべて満たす）: (i) `tests/test-lean-worker.ps1` の全ケースを TypeScript へ移植したテストが `node` 版 worker に対して pass する（mock Ollama、CI gate。PR #55 の token-aware compaction - context accounting、working summary、worker-verified state - のケースを含む）、(ii) `tests/test-lean-worker-smoke.ps1` の TypeScript 相当（実 Ollama、opt-in、CI gate にしない）が PowerShell worker と同じ assertion を `node` 版 worker に対して pass する、(iii) `config/examples/ollama-lean-worker.json` が `pwsh` ではなく `node` 版 worker を起動する形に更新され、`src/cli/configParity.test.ts` の execution plan parity が引き続き pass する、(iv) (b) の比較結果と (c) の採否決定が記録されている。(i)〜(iv) を満たした時点で `pwsh` を TypeScript runtime の route 2 要件から外し、PowerShell worker は maintenance mode へ移行する。**(a)・(i)・(ii)・(iii) は完了した（2026-09-07）。(iv) は未了であり、フェーズ8全体はまだ完了していない。** (a) は `src/workers/leanWorker/`（entry point `src/workers/leanWorker/main.ts`）として実装し、依存 0・Node 24 native `fetch` という設計を満たす。(i) は `tests/test-lean-worker.ps1`（715行）を移植した `src/workers/leanWorker/*.test.ts` が mock Ollama（`node:http` スタブ）に対して CI gate として pass することで測定し、(ii) は `HDO_LEAN_WORKER_SMOKE=1` を立てた場合にのみ実行される実 Ollama smoke で測定した（CI gate にはしない）。(iii) は `config/examples/ollama-lean-worker.json` の `ollama-lean-implementer` runner を `"command": "pwsh"` から `"command": "node"`・`extraArgs` 先頭を `{hdoRoot}/src/workers/leanWorker/main.ts` に変更したことで満たし、`src/cli/configParity.test.ts` の execution plan parity は変更後も pwsh を oracle として実際に実行し pass することを確認した（`-Config config/examples/ollama-lean-worker.json` ケース）。(iv)（`poc/ai-sdk/` 比較 PoC と採否記録）は本 PR のスコープ外であり、後続 PR で扱う。したがって本 ADR 冒頭および Amendment が述べる「(i)〜(iv) を満たした時点で `pwsh` を TypeScript runtime の route 2 要件から外し、PowerShell worker は maintenance mode へ移行する」はまだ発効していない: `workers/hdo-ollama-worker.ps1` は (iv) の完了まで live のまま残り、`pwsh` は（デフォルト example が `node` 版へ切り替わった後も）その PowerShell worker を使い続ける構成に対しては引き続き必要である。詳細は `docs/architecture.md` §16.2「フェーズ8（workers）は (a)・(i)・(ii)・(iii) まで完了した」および §16.4「フェーズ8」を参照。

**両実装をまたぐ契約（変更しない）**:

- `schemas/*.json`（editing source of truth は変えない）
- `tests/fixtures/schema/**`・`config/hdo.default.json`・`config/examples/*.json`・`.hdo/project.json`（PowerShell の `test-schemas.ps1` が直接参照するケーステーブルをそのまま TypeScript 側の oracle にする）
- `config/hdo.default.json` 等の config file
- artifact directory layout（`docs/architecture.md` 12節）
- exit code（0/2/3/4/5/6）
- `HDO_PROGRESS` record の形式
- Issue Form（`.github/ISSUE_TEMPLATE/hdo-task.yml`）
- CLI subcommand 名（`help`/`doctor`/`config`/`issues`/`inspect`/`run`/`status`/`cleanup`/`labels`）と option 名（`-Issue`/`-Pick`/`-Json`/`-Profile`/`-Config`/`-SetStep`/`-IgnoreRepositoryConfig`/`-DryRun`/`-NoWriteBack`/`-RunId`/`-Force`/`-WhatIf`/`-Repository`/`-RepositoryPath`/`-Apply`、`hdo.ps1` で定義された通り）。TypeScript CLI はこれらと同じ名前を受け付けなければならない（GNU 風の別名 `--issue` 等を追加するのは可、既存名の削除は不可）。PoC の `--json`/`--config` という小文字スペルは PoC 限定の簡易実装であり本番の正典ではない。

**"parity" の定義**: 各 CLI コマンドについて、同一入力（同一 repository state, 同一 config, 同一 Issue）に対して `-Json` 出力が意味的に等価であることを、PowerShell 実装を oracle として比較する。`doctor`/`config` は check 結果・execution plan の一致、`inspect` は正規化 contract・validation 結果の一致、`run -DryRun` は execution plan・preflight 結果の一致を指す。`status` は実行中/完了した run の状態一覧の一致、`cleanup -WhatIf`/`labels -WhatIf` は実際には変更を加えず何を変更する予定かを示す preview 出力の一致を指す。フェーズ7の終了条件はこの7コマンド（`doctor`/`config`/`inspect`/`run -DryRun`/`status`/`cleanup -WhatIf`/`labels -WhatIf`）の parity 到達であり、`commands/*.md`・`skills/*/SKILL.md` の切り替えはこの parity 確認より後に行う。フェーズ6の終了条件（`NoWriteBack` full run が両実装で同じ state 遷移・同じ diff・同じ review 判定に到達すること。決定論的な mock runner - `mock-agent.ps1`/`mock-claude.cmd`/`validation-pass.ps1` 相当 - で測定し、実 agent には依存しない）も満たした時点で、PowerShell 実装は maintenance mode へ移行する（Decision節）。実 agent を用いた full run の parity はより長期の目標であり、本 ADR はその到達を maintenance mode 移行の条件にしない。

## Issue #15 への影響

Issue #15 の AC-10（「PowerShell 7 を維持し、WSL2/Linux 対応のみを理由とした Python/Node.js 等への全面 rewrite を行わない」）は、本 ADR の Decision（TypeScript を primary runtime として段階移行する）と衝突する。したがって Issue #15 のスコープを次のように再整理することを提案する。まず、Issue #15 本文の11件の AC（`gh issue view 15 --json body --jq .body` で取得）全件を分類する。

| 元 AC | 内容（要約） | 分類 | 備考 |
|---|---|---|---|
| AC-01 | Windows 11・WSL2+Ubuntu・native Linux+Ubuntu LTS の各環境で `pwsh` 7.2+ から HDO CLI を起動できる | 残す（Windows）／TypeScript側へ移す（WSL2・Linux） | Windows 部分は現状維持で新規作業不要。WSL2/Linux 上での起動確認は TypeScript CLI の守備範囲とする |
| AC-02 | `config`/`doctor -DryRun` が Windows/WSL2/Linux で成功し、user config path・worktree root・artifact root が絶対 path として正しく解決される | 残す（APPDATA 直接参照の修正）／TypeScript側へ移す（Linux/WSL2 上での実際の成功確認） | bucket (a) の修正は残すが、Linux 上で `pwsh` 自体を実際に成功させる検証は行わない |
| AC-03 | Windows は既存の `%APPDATA%`/`%LOCALAPPDATA%` 挙動を維持、Linux/WSL2 は platform-appropriate な既定 path | 残す | bucket (a) と同一 |
| AC-04 | Git worktree の作成・diff 取得・status・cleanup が Windows/WSL2/Linux で同一契約に従う | 残す（Windows）／TypeScript側へ移す（Linux 実行契約の検証） | 従来の (b) に暗黙に含まれていたが明示されていなかった項目 |
| AC-05 | runner/validation process の起動・timeout・出力上限・終了が Linux 上で test 検証される | 削除して TypeScript 側へ移す | フェーズ2で TypeScript 実装として作られるため、PowerShell 側での実装は破棄される投資になる |
| AC-06 | junction と symbolic link の双方を拒否し、path 比較の OS 差を保持する | 削除して TypeScript 側へ移す | 同上 |
| AC-07 | `tests/test-suite.ps1`・schema test・plugin test が `windows-latest`/`ubuntu-latest` で継続実行される | 削除して TypeScript 側へ移す | 同上（CI OS matrix 追加は TypeScript 側で実施） |
| AC-08 | WSL2+Ubuntu での `doctor -DryRun` 実行証跡、または再現可能な manual smoke procedure | 削除して TypeScript 側へ移す | `poc/typescript` の Ubuntu Docker 実行結果（`results/ubuntu.json`, `results/ubuntu-test-output.txt`）が実質的にこの役割を代替する |
| AC-09 | README/requirements/architecture/configuration docs の OS 前提・install/path example の更新 | 残す | bucket (a) と同一 |
| AC-10 | PowerShell 7 を維持し、WSL2/Linux 対応のみを理由とした全面 rewrite を行わない | 削除（本 ADR の Decision と衝突するため無効化） | 本 ADR 自体がこの制約と矛盾する意思決定であり、Issue #15 側のこの AC は撤回する |
| AC-11 | runner（Claude/Codex/Ollama）が利用可能な OS 上で同じ契約で使え、provider 固有の OS 分岐を不必要に増やさない | 削除して TypeScript 側へ移す | Migration strategy フェーズ5（runners）で扱う |

(a) **Issue #15 に残す（安価かつ低リスクな portability fix。移行期間のリスクも下げる)**:

- `Get-HdoConfig`（`Configuration.ps1:179-180`）の `$env:APPDATA` 直接参照を platform-neutral な user config dir 解決に置き換える。
- `config/hdo.default.json` の `%LOCALAPPDATA%` 固定値を、Linux/WSL2 でも動く既定パスに変更する。
- README/requirements/architecture/configuration の OS 前提記述の更新。

これらは PowerShell 実装が maintenance mode に入った後も安全に保守できる程度の変更であり、かつ TypeScript 側の `PlatformAdapter`（`resolveToken` の LOCALAPPDATA/APPDATA → XDG fallback、`poc/typescript/src/platform/posix.ts:49-57`）と同じ思想を PowerShell 側にも先に適用しておくことで、移行期間中の両実装の挙動差を減らす効果がある。

(b) **TypeScript 実装側へ移す（Linux process/Job-Object/symlink/CI-matrix・worktree/diff・runner可用性・WSL2 smoke まわりの本格対応)**:

- Windows Job Object 相当の対応方針決定と実装（Migration strategy フェーズ2）。
- WSL2/Linux 上での CLI 起動確認（元 AC-01）。TypeScript CLI の `doctor`/`config` が Ubuntu で起動することを Migration strategy フェーズ1・7 で確認する。
- Linux/WSL2 での process-tree termination・symbolic link 境界検査の正式検証（元 AC-05, AC-06）。
- CI OS matrix（`ubuntu-latest`）の追加（元 AC-07 の代替）。
- Git worktree/diff/cleanup の Linux 実行契約の検証（元 AC-04、Migration strategy フェーズ3）。
- runner（Claude/Codex/Ollama）の OS 別可用性検証（元 AC-11、Migration strategy フェーズ5）。
- WSL2 + Ubuntu 実行証跡（元 AC-08）は `poc/typescript` の Ubuntu Docker 実行結果が代替済み。
- `config`/`doctor -DryRun` が Linux/WSL2 上で実際に成功することの検証（元 AC-02 のうち、Linux 上で `pwsh` 自体を実行して成功させる部分。Migration strategy フェーズ1・7）。bucket (a) に残すのは `$env:APPDATA` 直接参照の修正のみで、Linux 上での実行成功そのものの確認はこちらに含める。

これらは Issue #15 が想定する「PowerShell のまま Linux 対応を仕上げる」作業と実質的に同じ設計判断（`platform/windows` / `platform/posix` へ分岐を閉じ込める）を要求するため、二重実装を避けて TypeScript 側でまとめて実施する。

(c) **Issue #15 から削除する（PowerShell 側では実施せず、破棄されるだけの投資になる項目)**:

- Issue #15 の AC-05〜AC-07（runner/validation process の Linux 検証、junction/symlink boundary の双方対応、`tests/test-suite.ps1` の Linux CI 継続実行）。これらはフェーズ2〜3 で TypeScript 実装として作られるため、PowerShell 側での実装は移行完了時に破棄される投資になる。
- Issue #15 の AC-10（PowerShell 維持・全面 rewrite 禁止）。本 ADR の Decision と衝突するため撤回する。

**Issue #15 への提案 AC リスト（そのまま貼り付け可能。上表の分類と一致させている）**:

```text
AC-01: Windows 11 で `pwsh` 7.2 以上を用いて HDO CLI を起動できる（現状維持。WSL2/Linux 上での起動確認は TypeScript 実装の守備範囲とする）
AC-02: `Get-HdoConfig` が `$env:APPDATA` の直接参照をやめ、platform-neutral な user config dir 解決を持つ
AC-03: `config/hdo.default.json` の既定 `worktreeRoot`/`artifactRoot` が Windows 以外でも解決可能な値になる
AC-04: README / requirements / architecture / configuration docs の OS 前提が更新され、TypeScript 移行後の対応方針（ADR-0001 参照）への言及がある
AC-05: 本 Issue の範囲内では PowerShell 7 実装を維持し、次を実施しない（いずれも ADR-0001 の Migration strategy に委譲する）: Linux/WSL2 の process・Job Object・symlink・CI matrix 対応（フェーズ2）、Git worktree/diff/cleanup の Linux 実行契約の検証（フェーズ3）、runner（Claude/Codex/Ollama）の OS 別可用性検証（フェーズ5）、`config`/`doctor -DryRun` が Linux/WSL2 上で実際に成功することの検証（フェーズ1・7）。WSL2 + Ubuntu での `doctor -DryRun` 実行証跡は `poc/typescript` の Ubuntu Docker 実行結果（`results/ubuntu.json` 等）が代替する
```

## Amendments

### 2026-09-05: 移行の一次ターゲットは Windows

repository owner の決定により、TypeScript 移行の一次ターゲットは Windows とする。Migration strategy の各フェーズの終了条件のうち `ubuntu-latest` / Linux に関する部分（フェーズ 2 の Linux CI、フェーズ 1・7 の Linux 上での起動確認など）は初期フェーズの gate とせず、TypeScript 実装が Windows parity（フェーズ 7）に到達した後に起票する WSL2 / Linux 対応 Issue で扱う。`poc-typescript.yml` の `ubuntu-latest` job は PoC の情報提供として維持するが、移行フェーズの終了条件には含めない。Issue #15 はこの前提で再スコープ済み（PowerShell 側の portability fix のみ。「Issue #15 への影響」節）。

また bucket (a) の「`config/hdo.default.json` の `%LOCALAPPDATA%` 固定値を変更する」は、同ファイルが両実装共通の契約であるため値は変更せず、`Expand-HdoPath` 側で `%LOCALAPPDATA%` / `%APPDATA%` を .NET の既知フォルダーへ fallback させる方式で満たした（`docs/configuration.md` 9 節）。

### 2026-09-06: Ollama 対応の移行スコープ（Issue #37）

Issue #37 の AC-01〜AC-05 が問う「Ollama 対応をどのフェーズでどこまで移植するか」を、Migration strategy フェーズ5（runners）の一部として次のとおり確定する。

**route 1（claude+ollama、`type: claude` / `provider: ollama`）はフェーズ5で完全に実装した。** `ANTHROPIC_BASE_URL` のloopback固定・非secretトークン注入（`src/core/runners/runnerEnvironment.ts`）、prompt に埋め込む正規化 transport schema（`src/core/runners/claudeArguments.ts`。npm SDK が任意 model ID に対して `--json-schema` を拒否するため、cloud route と異なりこちらは prompt 埋め込みを使う）、`ollama create` による派生 context model `hdo-ctx-<sanitized>-<sha256[0:8]>-<contextTokens>` の解決（`src/runners/ollamaContextModel.ts`）、structured-output prose 回復（`src/core/runners/claudeOutput.ts` の `recoverOllamaStructuredOutput` + `src/runners/ollamaStructuredOutput.ts` の artifact 書き込み）、context-overflow の診断（`src/core/runners/failureDetail.ts`）、doctor の `provider:ollama`/`ollama-model:*`/`ollama-context:*` 検査（`src/workflow/preflight.ts`）をすべて含む。

**route 2（lean worker、`type: command` / `provider: ollama`）は、汎用 command adapter（token 展開・`promptTransport: file|stdin`・output-file-or-stdout、`src/runners/agentStep.ts`）としてのみフェーズ5に含む。** worker 本体である `workers/hdo-ollama-worker.ps1`（1222行、専用の715行テスト `tests/test-lean-worker.ps1` を持つ）は、フェーズ7（cli/plugin、PowerShell 実装が maintenance mode へ移行する時点）まで PowerShell のまま維持し、TypeScript へ移植しない。理由: (1) worker は HDO の runtime state に一切触れない独立した harness であり、(2) `{hdoRoot}`/`{promptFile}`/`{outputFile}`/`{schemaFile}`/`{model}`/`{contextTokens}` という token 契約（`config/examples/ollama-lean-worker.json`: `"command": "pwsh"`, `"args": ["-File", "{hdoRoot}/workers/hdo-ollama-worker.ps1", ...]`）そのものが、`command`/`extraArgs` を差し替えるだけで将来の `node` 版 worker に置き換え可能な抽象を既に提供しており、schema 変更なしに移行できる。結果として、TypeScript runtime 上で route 2 を使うには引き続き `pwsh` が PATH 上に必要になる（既知の制限として記録）。worker 自体の TypeScript 移植はフェーズ7より後の別 Issue で扱う。→ フェーズ8として確定（下記 Amendment「2026-09-06: フェーズ8（workers）の追加と lean worker 移植の位置づけ」、および ADR-0003）。

**doctor の Ollama 関連検査はフェーズ5で実装した**（`src/workflow/preflight.ts`、`Test-HdoEnvironment` 相当）: `ollama` command の存在、`ollama list` の成功、runner が指定する model の存在、（`contextTokens` 設定時）派生 context model が実際に `ollama create` できること、（`contextTokens` 未設定時）長時間 run で失敗しやすい構成である旨の warning。

**`contextTokens` の扱いは route ごとに異なる**: route 1 は `ollama create` で焼き込む Modelfile の `num_ctx` パラメータと、Claude CLI 側の `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（auto-compaction 基準）の2 lever を1つの値から導出する（`docs/configuration.md` §4.3 参照）。route 2 は `{contextTokens}` token 経由でリクエスト単位の `num_ctx` として渡すのみで、派生モデルは不要である。

**完了マッピング**: フェーズ5は fixture/mock ベースの parity で測定する - prose 回復は `tests/fixtures/runtime/claude-ollama-*.json`（`src/runners/ollamaStructuredOutput.test.ts`・`src/runners/runnersParity.test.ts`）と `mock-claude-ollama-prose.cmd`（`src/runners/agentStep.integration.test.ts`）、派生 context model の実 process 実行は `ollama.cmd` mock（`src/runners/ollamaContextModel.test.ts`）。実 provider を用いた TypeScript 側の opt-in smoke（`tests/test-ollama-smoke.ps1`/`tests/test-lean-worker-smoke.ps1` の TS 相当）はフェーズ6（TS 側の `run` が存在してから）に委譲し、CI gate にはしない。→ 補足: このうち `node` 版 worker 自体を対象にする `test-lean-worker-smoke.ps1` の TS 相当はフェーズ8の終了条件 (ii)（下記 Amendment）。フェーズ6で行う route 2 の smoke は TS 側の `run` が PowerShell worker を `command` runner 経由で起動する形を対象にする。

**execution plan parity（フェーズ5の終了条件の半分）は Ollama の2例を含む**: `config/examples/ollama-hybrid.json`（route 1）と `config/examples/ollama-lean-worker.json`（route 2）は `src/cli/configParity.test.ts` の `CASES` に含まれており、Ollama 固有の runner 設定も execution plan parity の対象である。

### 2026-09-06: フェーズ8（workers）の追加と lean worker 移植の位置づけ

repository owner の決定（2026-09-06）により、Migration strategy に **フェーズ8（workers）** を追加する。上の Amendment「Ollama 対応の移行スコープ（Issue #37）」が「フェーズ7より後の別 Issue で扱う」とした `workers/hdo-ollama-worker.ps1` の TypeScript 移植は、このフェーズ8として確定する。trade-off の詳細と inner tool loop の framework 採否の進め方（依存 0 ベースライン → `poc/ai-sdk/` 比較 PoC → 採否記録）は ADR-0003（`docs/adr/0003-agent-harness-lightweight.md`、Accepted 2026-09-06）に記録した。

**フェーズ7と並行ではなく、フェーズ7の後に置く理由**:

1. フェーズ7は cut-over の瞬間（`commands/*.md`・`skills/*/SKILL.md` の呼び出し経路が `pwsh` から `node` へ切り替わる）であり、7コマンド parity に注意を集中させる。
2. worker は `command` adapter の向こう側にいて、フェーズ6（mock runner による `NoWriteBack` full run）とフェーズ7（7コマンドの `-Json` parity）のどちらの parity にも現れない。並行させてもフェーズ7の parity を助けず、review の焦点だけが割れる。
3. 移植は大きい（worker 1222行 + 専用テスト `tests/test-lean-worker.ps1` 715行 + PR #55 で追加された token-aware compaction）うえ、完了判定に実 Ollama の opt-in smoke という、フェーズ6/7の mock ベース parity とは異なる検証方法を要する。

**maintenance mode の条件の明確化**: Decision 節のとおり、PowerShell orchestrator（`hdo.ps1` + `src/HybridDevOrchestrator/`）はフェーズ6・7の終了条件を満たした時点で maintenance mode へ移行する。この決定は変えない。ただし PowerShell worker（`workers/hdo-ollama-worker.ps1`）は、フェーズ8が完了するまで live のまま残る唯一のコンポーネントであり（route 2 を使う限り実際に実行される。compaction 等の不具合修正はこの間も worker に対して行う）、`pwsh` が TypeScript runtime の要件（route 2 に限る）から外れるのはフェーズ8完了時である。

**帰結（既知の制限）**: フェーズ7の cut-over からフェーズ8完了までの間、TypeScript runtime 上で route 2（`config/examples/ollama-lean-worker.json`）を使うには `pwsh` が PATH 上に必要である。route 1（claude+ollama）と cloud route には影響しない。opt-in の経路に限られた制限として記録する。**更新（2026-09-07、フェーズ8 (a)・(i)・(ii)・(iii) 完了）**: `config/examples/ollama-lean-worker.json` の `ollama-lean-implementer` runner が `node` 版 worker（`src/workers/leanWorker/main.ts`）を起動する形に変わったため、この既定 example を使う限り `pwsh` はもう不要である。ただし (iv) が未了のため `workers/hdo-ollama-worker.ps1`（PowerShell worker）は maintenance mode に入らず live のまま残っており、この PowerShell worker を明示的に起動し続ける独自 config（`command`/`args` を差し替えていない旧来の構成）に対しては `pwsh` が引き続き必要である。

**依存の扱い**: owner は比較 PoC のための依存追加（`ai` + Ollama provider、推移的に約12 package）を認めた。これは `poc/ai-sdk/` 配下の `package.json` に閉じ、フェーズ8 (c) の採否決定を経るまで repository root の `dependencies` には入れない。`poc/typescript/` は凍結のまま変更しない。security boundary（workspace guard、`.git` 保護、sandbox による write 権限、audit artifacts、`num_ctx` 予算）はどの構成でも HDO 所有とする（ADR-0003 D3）。

## References

- `docs/evaluation/powershell-vs-typescript.md`
- `docs/evaluation/typescript-architecture-proposal.md`
- `poc/typescript/README.md`
- `poc/typescript/results/windows.json`, `poc/typescript/results/ubuntu.json`, `poc/typescript/results/windows-test-output.txt`, `poc/typescript/results/ubuntu-test-output.txt`, `poc/typescript/results/plugin-surface-windows.md`
- GitHub Issue #18（本 ADR の対象）
- GitHub Issue #15（WSL2/Linux 正式対応、影響を受ける）
- GitHub Issue #25（`hdo cleanup` の Windows longpath 障害、Migration strategy フェーズ2 で参照）
- GitHub Issue #37（Ollama 対応の移行スコープ、Amendment 2026-09-06）
- GitHub Issue #48（エージェントハーネス軽量化の検討）、ADR-0003（`docs/adr/0003-agent-harness-lightweight.md`、Migration strategy フェーズ8 と対で読む）
- Issue #18 のコメント（Node/Bun 両対応のための tsconfig・wrapper 規約）
