# Hybrid Dev Orchestrator アーキテクチャ

- 対象: GitHub Issue pickup → implementation → validation → review → bounded fix
- runtime: Windows native / PowerShell 7.2+
- schema version: 1

## 1. 設計目標

HDO は GitHub Issue を versioned contract へ正規化し、run 専用 Git worktree で実装・検証・レビューを有限回実行する one-shot CLI である。

設計上の優先事項:

1. 現在の working tree を worker に変更させない。
2. plan / implement / review / fix の runner と model を別々に選べる。
3. Ollama を選択した run だけ Ollama を必要とする。
4. provider/model の暗黙 fallback を行わない。
5. Issue 本文を command authority にしない。
6. validation と Git diff を model の自己申告に依存しない。
7. review/fix loop を設定した上限で停止する。
8. provider conversation ではなく local artifact を run state の正典にする。
9. dry-run と「実装するが GitHub を変更しない」run を区別する。

## 2. 実装構成

~~~text
hdo.ps1
  └─ HybridDevOrchestrator PowerShell module
       ├─ Configuration  config merge / schema / semantic policy
       ├─ GitHub         Issue normalize / pickup / claim / labels
       ├─ Git            base commit / worktree / complete diff / cleanup
       ├─ Runner         Codex / Claude / command adapters / validation
       ├─ State          transition / run manifest / event log
       └─ Workflow       orchestration and bounded loop

external processes
  ├─ git
  ├─ gh
  ├─ codex | claude | configured command
  └─ trusted validation commands from .hdo/project.json
~~~

すべての外部 process は `ProcessStartInfo.ArgumentList` で executable と argument を分離して起動する。shell command string、`Invoke-Expression`、Issue text の command 化は使わない。stdout/stderr は各 stream 32 MiBを上限とし、agent step は非同期に artifact へ drain して64 KiBの診断 tailだけを保持する。Git/gh/validation のように結果を呼出元が消費する process も32 MiB以内に制限する。上限超過または timeout 時は process tree を停止する。長時間agent processでは30秒ごとにcontent-free heartbeatを生成し、CLIはstderrの `HDO_PROGRESS` recordとして中継する。

## 3. CLI

実装済み command:

~~~text
help      usage
doctor    environment/read-only preflight
config    resolved profile/execution plan
issues    eligible candidate list
inspect   Issue raw/normalized/validation
run       dry-run or full cycle
status    saved run.json
cleanup   guarded worktree removal
labels    catalog preview/sync
~~~

| Exit | 意味 |
|---:|---|
| 0 | command success / APPROVED / successful dry-run |
| 2 | argument、configuration、schema、Issue contract error |
| 3 | preflight failure |
| 4 | pickup candidate なし |
| 5 | full run failure |
| 6 | ESCALATED |

resume、cancel、daemon polling、PR/merge command は MVP に含まれない。run subprocess自体をdaemon化せず、保存済みrun stateとheartbeatから同期実行の結果を回収する。

## 4. Configuration と route

設定 source は次を deep mergeする。array は連結せず後の値で置換する。

~~~text
config/hdo.default.json
  < %APPDATA%/hdo/config.json
  < committed HEAD:.hdo/config.json
  < explicit -Config file(s), left to right
  < programmatic Overrides
  < -Profile / Issue Route Hint
  < -SetStep / StepOverrides
~~~

`%APPDATA%` は環境変数が未定義なら .NET の ApplicationData 既知フォルダーへ fallback する（`docs/configuration.md` 1 節）。

対象 repository の `.hdo/config.json` は `HEAD` に commit 済みの blob だけを自動読込する。専用の制限付き schema は profile routing と built-in Codex/Claude runner の provider/model/sandbox/timeout 等だけを許可し、任意 command、argument、environment、path、GitHub/workflow policy は許可しない。新規 runner の command は adapter type から HDO が固定し、既存 command runner の変更・自動 routing も拒否する。worktree 作成後に blob ID と SHA-256 を再照合する。

明示 `-Config` は利用者が承認した full configuration overlay として扱い、複数 file を左から右へ merge できる。`-IgnoreRepositoryConfig` は自動 repository source だけを除外する。

source merge 後の configuration は `hdo-config.schema.json`、route 解決後は `Test-HdoConfiguration` で検査する。主な cross-field rule:

- active profile と step の runner 参照が存在する。
- plan/review は read-only、implement/fix は workspace-write。
- local provider は model を明示する。
- Codex は cloud/ollama/lmstudio、Claude は cloud provider を使う。
- GitHub token は runner environment へ渡さない。
- adapter-controlled flag と dangerous sandbox bypass を `extraArgs` で上書きしない。Claude runner は `extraArgs` 自体を宣言できない（adapter が argument surface を専有する）。
- `implicitFallback` は false。
- worktree/artifact root は repository 外で、互いに重ならない。
- project contract path は repository 内。

Issue route hint は logical profile 名である。CLI `-Profile` が最優先で、指定がなければ Issue route、どちらもなければ `activeProfile` を使う。step override 後も全 policy を再検査する。

## 5. Issue と pickup

`ConvertTo-HdoIssueContract` は canonical Issue Form heading を schema version 1 object へ正規化する。本文、label、dependency、gate の規則は `docs/issue-contract.md` を正典とする。

自動 pickup は LLM を使わず、eligible Issue を次で並べる。

1. configured priority
2. createdAt ascending
3. Issue number ascending

明示 Issue も open/ready、contract、ready actor、dependency、active claim を同じく検査する。dependency の状態取得に失敗した場合は fail closed とする。

write-back 有効時は worktree 作成前に managed comment を作る。同時 claim は valid active marker の comment ID が最小の run を勝者とする。comment/event API は pagination する。lease は記録のみで、自動 takeover はしない。

## 6. Workflow

~~~text
resolve config / Issue / project contract
  -> contract + dependency + claim-conflict validation
  -> DryRun: selected-runner preflight and execution plan, then return

full run
  -> create external artifact directory
  -> preflight
  -> optional GitHub claim
  -> create branch + isolated worktree at fixed HEAD
  -> optional read-only plan
  -> implement
  -> trusted validation gates
  -> complete tracked + untracked diff
  -> read-only structured review
       approve
       request_changes -> fix -> validate -> review
       escalate
  -> final artifact
  -> terminal state
  -> optional GitHub final projection
~~~

`maxFixAttempts` は初回 implement を含まない。既定 2 は最大3 iteration（initial 1 + fix 2）である。

Policy branch:

- no diff: `onNoDiff = fail | escalate`
- required validation non-pass: `onValidationFailure = request-changes | escalate | fail`
- fix 上限: `onMaxFixAttempts = escalate | fail`

`request-changes` policy は validation result を reviewer へ渡す。required validation が non-pass のまま reviewer が approve しても、HDO は request_changes と measured blocker finding へ変換する。

terminal state は final artifact の保存後に設定する。最終 artifact の保存に失敗した run を APPROVED として残さない。

artifact directoryの作成直後にCLIへrun IDとartifact pathを通知する。agent step中は `run.json.activity` にstep、iteration、runner、開始時刻、最終heartbeat、経過秒を保存し、process終了時にnullへ戻す。progress callbackの出力streamが閉じてもrunは失敗させないため、親Codex turnが先に終了した場合もsubprocessとatomicなrun state更新を継続できる。再接続後は通知済みrun IDを `status` へ渡す。

## 7. State machine

~~~text
CREATED -> ISSUE_SELECTED -> PREFLIGHT
PREFLIGHT -> ISSUE_CLAIMED -> WORKTREE_READY  (write-back)
PREFLIGHT -> WORKTREE_READY                   (NoWriteBack)
WORKTREE_READY -> PLANNING | IMPLEMENTING
PLANNING -> IMPLEMENTING -> VALIDATING -> REVIEWING | CHANGES_REQUESTED
REVIEWING -> APPROVED | ESCALATED | CHANGES_REQUESTED
CHANGES_REQUESTED -> IMPLEMENTING | ESCALATED
any non-terminal -> FAILED | CANCELLED
~~~

APPROVED、ESCALATED、FAILED、CANCELLED は terminal である。現在の CLI は CANCELLED を生成する cancel command を持たないが、state core は将来用遷移を定義する。

## 8. Worktree と diff

full run は開始時の `HEAD` commit を固定し、branch `hdo/issue-<number>-<run-id>` と `<worktreeRoot>/<run-id>` を作る。current working tree の uncommitted change は base に含まれない。worker は worktree に未 commit change を残す。

review diff は base commit からの tracked binary patch に加え、`git ls-files --others --exclude-standard` で列挙した untracked file を `git diff --no-index --binary` で追加する。aggregate patch は32 MiBを上限とし、超過時は不完全な review をせず run を失敗させる。diff hash、numstat、porcelain status も保存する。

cleanup は run artifact の path が configured root 内で、`git worktree list` に存在する場合だけ実行する。dirty worktree は explicit `-Force` が必要で、cleanup 後も branch と artifact は残す。

## 9. Runner adapter

### 9.1 Codex

Codex adapter は非対話 `codex exec` を使う。

~~~text
codex exec --ephemeral --ignore-user-config --ignore-rules --json --color never
  --sandbox <mode> --cd <worktree>
  [--oss --local-provider ollama|lmstudio]
  [--model <id>]
  [--config model_reasoning_effort="..."]
  [--config model_context_window=...]
  --output-schema <schema>
  --output-last-message <file>
  -
~~~

prompt は stdin、event stream は raw events/stdout log、last message は schema-validated JSON として保存する。process exit 0、final file、JSON parse、schema validation のすべてを成功条件にする。

個人の Codex `config.toml` と execpolicy rules は読み込まず、HDO の runner contract で provider、model、sandbox、schema を決める。Codex 組み込みおよび repository の instruction はこの隔離の対象外である。

### 9.2 Claude

Claude adapter は非対話 print mode を使う。

~~~text
claude -p --output-format json --no-session-persistence --safe-mode
  --permission-mode <plan|acceptEdits>
  [--json-schema <normalized schema JSON>]
  [--model <id>] [--effort <level>] [--allowedTools <names>]
~~~

prompt は stdin、stdout の単一 result envelope は `envelope.json` として保存する（Codex の `events.jsonl` に相当する artifact slot）。envelope の `structured_output`（なければ `result`）を final JSON として取り出し、正規 schema で再検証する。

cloud providerの `--json-schema` へは、CLI の Ajv strict mode が受理できるよう正規化した transport copy を渡す（`$schema` と既定値 `minContains: 1` の除去、array keyword を持つ subschema への `type: "array"` 補完）。Ollama providerではClaude CLIのSDKが任意model IDを拒否するため、同じtransport schemaをpromptへ付加する。`schemas/` の canonical file が唯一の編集元であり、どちらも出力の再検証は正規 schema で行う。

`--safe-mode` により利用者の CLAUDE.md、plugin、hook、MCP server、skill は agent run に載らない。`read-only` は `--permission-mode plan`、`workspace-write` は `--permission-mode acceptEdits` に対応するが、これは permission mode であって OS-level sandbox ではない（`sandbox` field の保証は command adapter と同様に host policy へ依存する）。

`provider: ollama` の Claude adapter は `ANTHROPIC_BASE_URL=http://127.0.0.1:11434`、非secretの local token、空の API key、nonessential traffic 無効化を process environment へ adapter 内部で設定する。endpoint は repository config から変更できない。これにより Claude CLI は tool harness としてのみ働き、model inference は指定した Ollama model が行う。

### 9.3 Command

command adapter は argument token と stdin/file prompt transport を提供する。output file があれば読み、なければ stdout を final JSON とする。任意 executable に OS-level sandbox を自動付与しないため、`sandbox` field は routing/policy declaration であり、host policy も必要になる。

## 10. Project contract と validation

`.hdo/project.json` は schema validation したうえで、gate ID 一意性と exit-code class の非重複を semantic validation する。

gate command は executable + args、working directory、timeout、required、exit class、`continueAfterFailure` を持つ。Issue は ID だけを選べる。working directory は worktree 外へ出られず、path segment に junction/symbolic link がある場合も拒否する。

- configured passed code: pass
- configured failed code: fail
- timeout、unknown code、起動失敗: indeterminate

`continueAfterFailure: false` の gate が non-pass なら、残り gate は実行せず indeterminate/skipped として記録する。required gate が1つでも pass でなければ `allRequiredPassed=false` である。

worker/review policy は prompt と schema/sandbox に反映するが、validation command 自体は host process であり、arbitrary command の network/command/path policy を syscall level で intercept する機能はない。信頼できない repository の gate は low-privilege account または VM/container 内で実行する。

## 11. Structured review

reviewer は untrusted Issue contract、task contract、trusted project/review policy、validation result、previous review、base commit、diff hash、complete patch を受け取る。

output は `review-result.schema.json` に従う。runtime は decision、round、finding ID uniqueness、missing viewpoint、indeterminate、actionable finding を検査する。前 round の finding は消去できず、resolved / waived / refuted 等の status で carry forward する。

review は read-only であり、source 修正は fix runner だけが行う。

## 12. Artifact

~~~text
<artifactRoot>/<run-id>/
  run.json
  events.jsonl
  issue.raw.json
  issue.contract.json
  execution-plan.json
  effective-config.redacted.json
  environment.json
  worktree.json
  project-contract.json
  task-contract.json
  plan/                         # enabled の場合
  iterations/001/
    implement/ | fix/
      prompt.md
      envelope.json | events.jsonl   # Claude: 単一 result envelope / Codex・command: event stream
      stdout.log
      stderr.log
      final.json
    validation/
      result.json
      <gate>.log
    diff.patch
    diff.json
    review/
      prompt.md
      envelope.json | events.jsonl
      stdout.log
      stderr.log
      final.json
      result.json
  final/
    diff.patch
    summary.json
~~~

step directory の stdout copy は adapter に応じて名前が変わる。Claude adapter は `--output-format json` の単一 envelope object を `envelope.json` として、Codex と command adapter は JSONL event stream を `events.jsonl` として保存する（run root の `events.jsonl` は HDO 自身の run event log であり、adapter に依存しない）。既定 profile は claude-only なので、既定の run では step artifact は `envelope.json` になる。

JSON manifest は temporary file から replace する。config object、stdout/stderr、exception、GitHub summary は known secret pattern を redact する。prompt と source diff 自体は task artifact なので、artifact directory の access control は利用者が管理する。

## 13. DryRun と NoWriteBack

DryRun は GitHub/Issue/project contract を読み、contract/dependency/claim conflict、configuration、selected runner/provider の read-only preflight を行う。worktree、artifact、agent、validation、GitHub mutation は作らない。

NoWriteBack は full local cycle である。worktree、agent、validation、review、artifact は作るが、claim/comment/label/assignee は変更しない。

## 14. Security と既知の境界

実装する防御:

- Issue/comment は untrusted と prompt で区切る。
- validation command は trusted project contract だけから解決する。
- worker environment から GitHub/cloud/package credential を既定除外する。
- GitHub token の runner opt-in を拒否する。
- plan/review と implement/fix の sandbox を分離する。
- dangerous CLI override を拒否する。
- path containment と guarded cleanup。
- validation working directory の junction/symbolic-link boundary 拒否。
- no implicit fallback / no model auto-pull。
- model output を直接 GitHub command にしない。

MVP の境界:

- generic command adapter と validation command の filesystem/network isolation は host に依存する。
- cloud runner/reviewer は Issue/source/diff を provider へ送信し得る。
- GitHub claim は optimistic protocol であり atomic lock ではない。
- validation cwd の reparse-point 検査は process start 前の point-in-time check であり、gate が引数や source 内の別 path を辿ることまで filesystem sandbox しない。
- claim lease の自動回復、resume/cancel、PR automation はない。
- usage/token telemetry、multi-review lens、mutation testing は post-MVP。

## 15. Test

`tests/test-suite.ps1` は runtime unit/integration test、bounded process-output stress test、CLI exit-code test をまとめて実行する。GPU/Ollama/GitHub success を必要とせず、configuration merge、commit 済み repository config と snapshot binding、複数 explicit overlay、role routing、state、Issue normalization、schema runtime、credential redaction、review continuity、untracked diff、generic command adapter、stdout/stderr 上限、content-free heartbeat、run activityの解除、CLI success/argument/preflight code を検査する。

`tests/test-schemas.ps1` は bundled config/project/Issue/task/worker/review fixture と fail-safe negative fixture を検査する。実 provider/GitHub cycle は credential を持つ integration environment で別途行う。

`tests/test-ollama-smoke.ps1` は `-Run` を付けた場合だけ実Ollamaを呼ぶ。通常のsuite/CIには含めず、隔離repository、実model応答、変更なし、cloud parent routingの不変をlocal hostで確認する。親の待機状態と独立したreceiptへheartbeatと最終検証結果を保存する。

## 16. TypeScript 実装（Migration strategy フェーズ1）

ADR-0001（`docs/adr/0001-primary-runtime-typescript.md`）に基づき、TypeScript / Node.js 24 LTS を中長期の primary runtime として strangler-style で段階移行している。PowerShell 実装（本ドキュメントの1〜15節）は移行完了まで正典であり続け、本節はその上に追加された TypeScript 実装の配置のみを記す。

### 16.1 レイアウト

```text
src/
  core/       純粋なロジックのみ。node:path・ajv・ajv-formats 以外の非相対 import、
              および src/core/ 外への相対 import を持たない（src/core/boundary.test.ts
              が機械的に検査する）
    contracts/  schemas/*.json を名前で解決する SchemaRegistry + Ajv wrapper
    config/     deep merge・%VAR% 展開・repository config 制約・
                Test-HdoConfiguration 相当の意味検証・Get-HdoConfig 相当の解決・
                executionPlan.ts（Get-HdoExecutionPlan 相当）・projectContract.ts
                （Get-HdoProjectContract がファイル読み込み・schema検証の後に行う
                意味検証のみを移植。file 未検出/schema 失敗時の throw は phase 1 の
                `config` サブコマンドからは到達しないため未移植）
    state/      RunState union + 遷移表 + transition(from, to) / isValidTransition
  platform/   PlatformAdapter の Windows/POSIX 実装（userConfigDir・defaultDataDir・
              pathEquals・isPathWithinRoot。killProcessTree・resolveExecutable・
              isReparsePointInPath はフェーズ2で追加する）
  git/        GitClient（rev-parse・show の read-only wrapper）+
              repositoryConfigSnapshot（Get-HdoRepositoryConfigSnapshot 相当）
  cli/        main.ts が composition root（現在 config/help のみ実装）
```

依存方向は `core <- platform, git <- cli` で、`core` は上位レイヤーに一切依存しない。既存 PowerShell module（`src/HybridDevOrchestrator/`）は変更していない。

### 16.2 フェーズと終了条件

Migration strategy（ADR-0001）はフェーズ1（core contracts / config / state）から順に7フェーズで進む。フェーズ1の終了条件は、`config/hdo.default.json`・`config/examples/*.json`・`.hdo/project.json`・`tests/fixtures/schema/**` の valid/invalid 判定が `tests/test-schemas.ps1` と一致することであり、`src/core/contracts/schemaFixtures.test.ts` で検証している。`node src/cli/main.ts config -Json` の出力は、`pwsh -NoProfile -File hdo.ps1 config -Json` と同一入力に対して意味的に等価であることを `src/cli/configParity.test.ts` が pwsh を oracle にして検証する（`pwsh` が無い環境では skip）。

process/platform（フェーズ2）以降は ADR-0001 の Migration strategy 節を参照。移行の一次ターゲットは Windows（2026-09-05 Amendment）であり、WSL2/Linux 上での確認はフェーズ1・7 の gate に含めない。

### 16.3 実行方法

```sh
npm ci
npm run typecheck
npm test
node src/cli/main.ts config -Json
```

PoC（`poc/typescript/`）は評価時点の実証根拠として凍結し、本番実装の出発点にした後は変更していない。

### 16.4 PowerShell 実装との意図的な差異

フェーズ1の TypeScript 実装は原則として PowerShell を rule-for-rule で移植するが、以下は意図的に挙動を変えている（または変える予定がない）既知の差異である。

1. **`isPathWithinRoot` とドライブルート**: `root` がファイルシステムのルート（`C:\`）の場合、PowerShell の `Test-HdoPathWithinRoot` は常に `$fullRoot + [System.IO.Path]::DirectorySeparatorChar`（`C:\\`）を要求するプレフィックス比較になり、どんな実在のパスもこれで始まることはないため常に `$false` を返す（`root` の真の子孫であっても弾かれる、PowerShell 側の不具合）。TS 版はこの二重区切り文字を作らないため、正しく `true` を返す（TS が正しい挙動）。`config` では `paths.worktreeRoot`/`paths.artifactRoot` を `C:/`（ドライブルート）にした場合にのみ観測できる差異。詳細は `src/platform/paths.ts` の G-04 コメントを参照。
2. **committed `.hdo/config.json` に credential らしき文字列が含まれる場合の sha256**: PowerShell の `Get-HdoRepositoryConfigSnapshot` は `Invoke-HdoProcess` 経由で `git show` の stdout を取得する際、その stdout に `Protect-HdoText`（credential-pattern redaction）を適用してから schema検証・`ConvertFrom-Json`・sha256計算を行う。そのため、committed された `.hdo/config.json` の値に credential pattern に一致する文字列（例: `"model": "sk-ant-..."` や `"mytoken:latest"` のような値）が含まれていると、PowerShell 側では redaction によって JSON 構造が壊れて失敗するか、あるいは `[REDACTED]` に置換された文字列に対して schema検証・sha256計算が行われる。TS の `getRepositoryConfigSnapshot`（`src/git/repositoryConfig.ts`）は `git show` の生の stdout をそのまま parse・sha256計算するため、このケースでは両実装の `sha256`（および場合によっては `loaded`/エラーの有無）が一致しない。これは PowerShell 側の不具合として Issue #42 で扱う（TS 側の挙動を変える予定はない）。
3. **JSON パーサーの寛容さ**: PowerShell の `ConvertFrom-Json`（内部的に Newtonsoft.Json を使用）はコメント・末尾カンマ・単一引用符などの非標準 JSON を許容する場合があるが、TS 側は厳密な JSON（`JSON.parse`）のみを受理する。非標準 JSON を含む設定ファイルは PowerShell では読めても TS では `Invalid JSON in '<path>': ...` で失敗しうる。
4. **`-Config` / `-Profile` の繰り返し**: PowerShell の `[CmdletBinding()]` パラメーターバインダーは、任意の named parameter への重複指定をバインディングエラー（exit 1、`parameter 'Config' is specified more than once`）として拒否する。`-Config` が `[string[]]`（配列型）で宣言されていても例外ではなく、2回目の `-Config` は同様に拒否される（配列型は単一指定の値をコンマ区切りにするためのものであり、フラグ自体の繰り返しを許すものではない）。TS の `parseArgs`（`src/cli/args.ts`）は複数回の `-Config` を受理し、値をコンマ区切りリストとして連結する（単発の `-Config` の挙動は変えないため、ADR-0001 が許容する superset な拡張）。`-Profile` は最後に指定した値が勝つ（後勝ち）。
5. **schema validation 失敗メッセージの末尾**: `Configuration schema validation failed:` および `Repository configuration schema validation failed for '<path>' at <commit>:` のプレフィックス（末尾の半角スペースを含む）は両実装で一致するが、その後ろのメッセージ本文（Ajv のエラーメッセージ vs. PowerShell `Test-Json`/Newtonsoft.Json のエラーメッセージ）は文言・形式が異なる。`src/cli/configParity.test.ts` と `src/core/config/resolve.ts` はこれを明示的に許容されたプレフィックスのみの一致としてテストしている。
6. **非 object の JSON を `-Config` に渡した場合**: `[]`・`5`・`null`・空 file のような、トップレベルが JSON object ではない値（または空）を `-Config` に渡すと、両実装とも exit 2 で失敗する点は一致するが、メッセージ文言は異なる。PowerShell は parameter binding error の文言（`ConvertFrom-Json` の戻り値の型が期待と合わないことに起因する内部的なエラー）を出すのに対し、TS の `readJsonFile`（`src/cli/configCommand.ts`）は `Invalid JSON in '<path>': expected a JSON object` という専用メッセージを出す。
7. **`Expand-HdoPath`/`expandPath` と末尾区切り文字**: .NET `[System.IO.Path]::GetFullPath` は入力に末尾区切り文字があればそれを保持するのに対し、Node の `path.resolve`（TS の `expandPath` が最終ステップで使う）は末尾区切り文字を落とす（詳細は `src/core/config/expand.ts` のコメントを参照）。そのため `paths.worktreeRoot`/`paths.artifactRoot` を `{repository}/`（末尾スラッシュ付き）にすると、PowerShell 側は `C:\repo\` に展開され `worktreeRoot -eq repositoryPath`（`C:\repo`）が `false` になり、この誤設定（実質的に repository 直下を worktree root にしてしまう設定）を **受理してしまう**。TS 側は `path.resolve` が末尾区切りを落として `C:\repo` になり、`pathEquals` で repositoryPath と一致するため `paths.worktreeRoot must be outside repositoryPath.` として **正しく拒否する**（この差異では TS の挙動が正しい）。
8. **unknown command/option の exit code**: 未知の command / 未知の option を渡した場合、PowerShell は `[CmdletBinding()]`/`ValidateSet` のパラメーターバインディングエラーとして exit 1 になるのに対し、TS の `parseArgs`/`main`（`src/cli/main.ts`）は exit 2 を返す。これは Migration strategy フェーズ7（CLI 移植）で PowerShell 側の挙動に揃える予定の既知の差異であり、フェーズ1時点では未対応（なお `help` コマンド自体の出力先は両実装とも stdout で一致している）。
9. **8.3 短縮名（`RUNNER~1` 等）を含む path の `Expand-HdoPath`/`expandPath` 展開**: .NET `[System.IO.Path]::GetFullPath` は path に `~` が含まれる場合、既存部分の 8.3 短縮名を `GetLongPathNameW` で展開する（`~` を含まない path では何もしないのが .NET 自身の高速パス）。TS の core `expandPath`（`src/core/config/expand.ts`）は最終ステップで `path.resolve` を呼ぶだけでこの展開を行わないため、`src/platform/windows.ts` の Windows adapter が同じ条件（`~` を含む場合のみ）で post-step を追加する: 最長の既存祖先を `fs.realpathSync.native` で展開し、存在しない末尾セグメントをそのまま再連結する。この post-step は `~` を含まない path には適用されず（`GetFullPath` の高速パスと同じ）、また `realpathSync.native` は reparse point（symlink/junction）も解決してしまう（`GetLongPathNameW` は解決しない）ため、既存祖先に reparse point が含まれる場合にのみ両者の結果が異なりうる近似実装である。GitHub Actions の `windows-latest` は `%TEMP%` が `C:\Users\RUNNER~1\...` という短縮名になるため、この差は CI で実際に観測された（`src/cli/configParity.test.ts` の `-Config` 存在しないファイルを指す negative case、および `src/git/repositoryConfig.test.ts` の一時リポジトリに対する `snapshot.path` の期待値）。POSIX adapter に変更はない。単体テストは `src/platform/windows.test.ts`（Windows限定、`C:\PROGRA~1` が存在しない環境ではskip）。
