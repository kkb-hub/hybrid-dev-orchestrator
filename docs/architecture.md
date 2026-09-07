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

Claude/Ollama の exit-zero 応答が canonical schema に違反した場合は `structured-output noncompliance` と分類する。回復は追加 inference を使わず、1 Mi 文字以内の応答について一度だけ実行する。成功 envelope の文字列 `result` が、引用符・JSON delimiter・code fence を含まない説明文（英数字等からなるインラインコード表記は許可）、改行、単一 JSON object の順である場合だけ、object から末尾まで全体を未変更の canonical schema で検証する。複数 object、末尾説明文、壊れた JSON、曖昧な境界は拒否する。回復処理は shell、network、repository write を行わず、既存 diff を保持する。

違反時は step directory の `envelope.json` に加え、`result.original.txt`、`recovery.input.txt`、`recovery.output.txt`、`structured-output.json` を保存する（既存 credential redaction を適用）。診断 JSON は初回 validation error、試行上限、回復結果、最終 validation error を含む。回復不能時は既存 workflow の例外処理で `FAILED` へ遷移し、status の error に違反分類と回復結果を残す。正常 JSON、cloud Claude、Codex の処理経路は維持する。

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

呼び出しは `node src/cli/main.ts <command> [options]` を既定とする（ADR-0001 Migration strategy フェーズ7の cut-over 後、plugin の `commands/*.md`・`skills/*/SKILL.md` が呼ぶ経路、§16.2参照）。PowerShell 実装 `hdo.ps1 <command> [options]` は同じ9個の command を引き続き提供するが、フェーズ7完了に伴い maintenance mode（既存不具合の修正のみ、ADR-0001 Decision 節）へ移行した。

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

validation gate の各結果は `failureClass`（`product` / `setup` / `timeout` / `unclassified` / `skipped` / `null`）で分類する（Issue #16）。gate command 自体が起動できなかった場合（`setup`）は、その gate の `continueAfterFailure` の値に関わらず残りの gate を実行せず `skipped` として記録する - setup failure は「product が壊れているか」を判定すらできていない状態であり、後続 gate を検証されていない worktree/tooling 状態のまま走らせることを避けるため。timeout・product failure（fail exit code）・unclassified（未知の exit code）は引き続き gate ごとの `continueAfterFailure` に従う。

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

TypeScript 実装（フェーズ6）はこの遷移表を唯一の正典 (`src/core/state/index.ts` の `EXPLICIT_TRANSITIONS`) とし、`toMermaid()`（`src/core/state/mermaid.ts`）が同じ表から次の diagram を機械的に生成する（「図 = 表」、ADR-0003 D1。手書きの複製ではない）:

~~~mermaid
stateDiagram-v2
    CREATED --> ISSUE_SELECTED
    CREATED --> FAILED
    CREATED --> CANCELLED
    ISSUE_SELECTED --> PREFLIGHT
    ISSUE_SELECTED --> FAILED
    ISSUE_SELECTED --> CANCELLED
    PREFLIGHT --> ISSUE_CLAIMED
    PREFLIGHT --> WORKTREE_READY
    PREFLIGHT --> FAILED
    PREFLIGHT --> CANCELLED
    ISSUE_CLAIMED --> WORKTREE_READY
    ISSUE_CLAIMED --> FAILED
    ISSUE_CLAIMED --> CANCELLED
    WORKTREE_READY --> PLANNING
    WORKTREE_READY --> IMPLEMENTING
    WORKTREE_READY --> FAILED
    WORKTREE_READY --> CANCELLED
    PLANNING --> IMPLEMENTING
    PLANNING --> FAILED
    PLANNING --> CANCELLED
    IMPLEMENTING --> VALIDATING
    IMPLEMENTING --> FAILED
    IMPLEMENTING --> CANCELLED
    VALIDATING --> REVIEWING
    VALIDATING --> CHANGES_REQUESTED
    VALIDATING --> FAILED
    VALIDATING --> CANCELLED
    REVIEWING --> APPROVED
    REVIEWING --> ESCALATED
    REVIEWING --> CHANGES_REQUESTED
    REVIEWING --> FAILED
    REVIEWING --> CANCELLED
    CHANGES_REQUESTED --> IMPLEMENTING
    CHANGES_REQUESTED --> ESCALATED
    CHANGES_REQUESTED --> FAILED
    CHANGES_REQUESTED --> CANCELLED
~~~

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

`continueAfterFailure: false` の gate が non-pass なら、残り gate は実行せず indeterminate/skipped として記録する。gate command が起動できなかった場合（`failureClass: setup`）は `continueAfterFailure` の値に関わらず常に残り gate を止める（Issue #16、`docs/architecture.md` §6）。required gate が1つでも pass でなければ `allRequiredPassed=false` である。

`doctor` は `.hdo/project.json` の各 `validationGates[]` エントリについて `gate:<id>` check を追加で行い、その `command` が実行可能ファイルとして解決できるかを検査する（Issue #8）。解決できない場合は `warning`（`required: false`）を返す - `fail` にすると、gate command が一時的に見つからないだけで `run` が PREFLIGHT_FAILED になり、Issue #16 の setup-failure 分類（実行時の TOCTOU 検出）が到達しなくなるため、意図的に `warning` にとどめている。

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

`validation/result.json` の各 gate エントリは `status` に加えて `failureClass`（`product` / `setup` / `timeout` / `unclassified` / `skipped` / `null`）を持つ（Issue #16、§6/§10 参照）。

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
    process/    Invoke-HdoProcess の結果契約（ProcessRunOptions/ProcessResult・
                resolveExitCode の exit code 優先順位）、Protect-HdoText/
                Protect-HdoObject（redact.ts）、Get-HdoSafeEnvironment
                （safeEnvironment.ts）。process 実行そのもの（node:child_process）は
                含まない - それは src/process/ の役割。フェーズ5で cmdShim.ts
                （`.cmd`/`.bat` shim 用の純粋な cmd.exe コマンドライン builder、
                buildCmdShimCommandLine）を追加した
    runners/    フェーズ5で追加。純粋な runner adapter ロジック - stepBinding・
                argumentTemplate・claudeSchema・codexSchema・codexArguments・
                claudeArguments・runnerEnvironment・ollamaContextModelName・
                claudeOutput（recoverOllamaStructuredOutput 含む）・
                failureDetail・reviewResult・prompts・psSemantics（PS の
                `-eq`/`-in`/`[bool]` 等の値意味論を再現する共有 helper）
    state/mermaid.ts  フェーズ6で追加。`EXPLICIT_TRANSITIONS` から Mermaid
                `stateDiagram-v2` を機械的に生成する toMermaid()（ADR-0003 D1、
                本ドキュメント §7 に出力を貼り付けている）
    workflow/   フェーズ6で追加。純粋な workflow ロジック - runRecord.ts
                （RunRecord/RunResult/RunError 型、createRunRecord、newRunId、
                isWriteBackEnabled、syntheticTaskContract、classifyRunFailure、
                REASONS）、decisions.ts（decideNoDiff/decideValidation/
                decideReview/applyValidationBlocker）、gates.ts
                （classifyGateOutcome を含む gate 分類、Issue #16）
  platform/   PlatformAdapter の Windows/POSIX 実装。フェーズ1
              （userConfigDir・defaultDataDir・pathEquals・isPathWithinRoot・
              expandPath）に加え、フェーズ2で resolveExecutable・killProcessTree・
              isReparsePointInPath・removeTree（long-path safe）・
              createProcessContainer（Windows Job Object、jobObject.ts）・
              spawnDetached を追加し、フェーズ5で resolveExecutable の解決対象へ
              `.cmd`/`.bat` を追加した（`.ps1` は引き続き解決しない）
  process/    NodeProcessRunner（runner.ts）- bounded output・timeout・
              process-tree containment・heartbeat を実装する本番 ProcessRunner。
              `src/core/process/types.ts` の contract を実装する。フェーズ5で
              解決先が `.cmd`/`.bat` の場合に cmd.exe 経由で spawn する分岐を追加した
  git/        GitClient（rev-parse・show・worktree add/list/remove/prune）+
              repositoryConfigSnapshot（Get-HdoRepositoryConfigSnapshot 相当）。
              フェーズ2で ProcessRunner 経由の実行、Windows での
              `-c core.longpaths=true`、worktree 操作を追加した。フェーズ3で
              `diff --numstat` ベースの完全な diff 構築（GitClient.diff）を追加した
  github/     フェーズ4で追加。Issue 正規化（normalize.ts）、pickup 対象の
              authorization 検証（authorization.ts）、claim marker の読み書き
              （claim.ts）、label 同期（labels.ts）、GhClient（client.ts）、
              markdown 断片抽出（markdown.ts）、project contract 検証
              （contractValidation.ts）
  runners/    フェーズ5で追加。host 層の runner adapter - agentStep.ts
              （Invoke-HdoAgentStep 相当、Codex/Claude/command 共通の実行と
              artifact 保存）、artifacts.ts（bounded file 読み込み・JSON 書き込み・
              ログ redaction）、ollamaContextModel.ts（`ollama create` による
              派生 context model の解決）、ollamaStructuredOutput.ts（prose 回復
              結果の artifact 書き込み）
  workflow/   フェーズ5で追加。preflight.ts（Add-HdoPreflightCheck /
              Test-HdoEnvironment 相当、`doctor`/`run -DryRun` が共有する
              read-only 環境検査。フェーズ6で `.hdo/project.json` の各
              validationGates[] に対する `gate:<id>` check を追加した、Issue
              #8）、projectContract.ts（loadProjectContract、file 読み込み +
              schema 検証を追加した Get-HdoProjectContract 相当）。フェーズ6で
              追加した host 層の workflow モジュール - runStore.ts（RunStore の
              save/addEvent/setState、readRun。Save-HdoRun/Add-HdoRunEvent/
              Set-HdoRunState/Get-HdoRun 相当）、worktree.ts（getBaseCommit、
              createWorktree、assertWorktreeIntegrity、
              getWorktreeProjectContract、assertRepositoryConfigSnapshot）、
              validation.ts（runValidation、Invoke-HdoValidation の host 半分）、
              selectIssue.ts（Invoke-HdoRun のIssue選択 prologue）、run.ts
              （runWorkflow - DryRun、run record 生成、
              `Record<NonTerminalRunState, StepHandler>` による dispatch loop
              - Invoke-HdoRun 本体、ADR-0003 D1）
  cli/        main.ts が composition root。フェーズ1の `config`/`help` に加え、
              フェーズ5で `doctor`（doctorCommand.ts、`-DryRun`/`-Json` を含む
              hdo.ps1 と同名の option をすべて受け付ける。フェーズ7の CLI 移植を
              待たず、run -DryRun の preflight 半分を直接検証する oracle として
              先行実装した）を実装した。フェーズ6で `run`（runCommand.ts、
              `-Issue`/`-Pick`/`-NoWriteBack`/`-DryRun`/`-Json`/`-Config`/
              `-Profile`/`-SetStep`/`-IgnoreRepositoryConfig`/`-Repository`/
              `-RepositoryPath` を受け付ける）と `status`（statusCommand.ts、
              `-RunId`/`-Json`）を、`config`/`doctor` と同じ理由（§16.2参照）で
              フェーズ7の CLI 移植を待たず先行実装した
  cli/runParity.test.ts  フェーズ6で追加。pwsh oracle との NoWriteBack
              full-run parity harness（13シナリオ、tests/fixtures/workflow/
              の共有 fixture を消費する）
  cli/        フェーズ7で追加した composition root - issuesCommand.ts
              （runIssuesCommand、候補0件で exit 4）、inspectCommand.ts
              （runInspectCommand、`-ProjectContract` を渡さない）、
              cleanupCommand.ts（runCleanupCommand、`-RunId` 必須の guard の後
              `workflow/cleanup.ts` へ委譲）、labelsCommand.ts
              （runLabelsCommand、`config/labels.json` をここで読む）。
              paths.ts に `LABELS_CATALOG_PATH` を追加した
  workflow/cleanup.ts  フェーズ7で追加。`Remove-HdoRunWorktree`/
              `Test-HdoOrphanedWorktree`（Git.ps1:187-301）の移植 -
              removeRunWorktree・isOrphanedWorktree（Issue #25 の
              「Filename too long」で admin entry だけ先に消えた worktree を
              `-Force` 付きでのみ filesystem 削除 + `git worktree prune` で
              片付ける orphan 分岐を含む）
  cli/inspectParity.test.ts・issuesParity.test.ts・statusParity.test.ts・
  cleanupParity.test.ts・labelsParity.test.ts  フェーズ7で追加。終了条件
              (i)（`inspect`）・(ii)（`status`/`cleanup -WhatIf`/
              `labels -WhatIf`）の測定と、移植対象コマンドである `issues` の
              追加比較（§16.2参照）。`tests/fixtures/cli/gh/`（mock `gh.cmd` +
              `issue-list.json`/`label-list.json`）を新設し、phase 6 の
              `tests/fixtures/workflow/gh/gh.cmd` は変更していない
```

依存方向は `core <- platform, process, git, github <- runners, workflow <- cli` で、`core` は上位レイヤーに一切依存しない。`platform/jobObject.ts` は `koffi` を `src/platform/**` からのみ import し（`src/core/boundary.test.ts` の allow-list は変更していない）、失敗時は `taskkill /T /F /PID` へフォールバックする（ADR-0002）。既存 PowerShell module（`src/HybridDevOrchestrator/`）は変更していない。

### 16.2 フェーズと終了条件

Migration strategy（ADR-0001）はフェーズ1（core contracts / config / state）から順に進む（フェーズ1〜7、および ADR-0001 Amendment 2026-09-06 で追加された、フェーズ7の cut-over 後に行うフェーズ8 - workers: `workers/hdo-ollama-worker.ps1` の TypeScript 移植、ADR-0003 参照。フェーズ8は 2026-09-07 に完了し、Migration strategy の全フェーズが完了した）。フェーズ1の終了条件は、`config/hdo.default.json`・`config/examples/*.json`・`.hdo/project.json`・`tests/fixtures/schema/**` の valid/invalid 判定が `tests/test-schemas.ps1` と一致することであり、`src/core/contracts/schemaFixtures.test.ts` で検証している。`node src/cli/main.ts config -Json` の出力は、`pwsh -NoProfile -File hdo.ps1 config -Json` と同一入力に対して意味的に等価であることを `src/cli/configParity.test.ts` が pwsh を oracle にして検証する（`pwsh` が無い環境では skip）。

**フェーズ2（process / platform）は完了した。** 終了条件（ADR-0001 Migration strategy）は次の通り満たしている:

- `tests/fixtures/runtime/hold-output-handle.ps1` シナリオを Windows で pass させる: `src/platform/jobObject.test.ts` が実際の `NodeProcessRunner` + Windows `PlatformAdapter` で実行し、exitCode 0・`outputDrainTimedOut: false`・孫プロセスの終了を確認する。koffi 経由の Windows Job Object 実装を採用した経緯は ADR-0002（`docs/adr/0002-windows-job-object-via-koffi.md`）に記録した。
- `spam-output.ps1`（stdout/stderr）・`delayed-output.ps1`（heartbeat）・`hold-output-handle.ps1`・`ignore-input.ps1`（timeout 124、capture error 127）の各シナリオについて、pwsh の `Invoke-HdoProcess` と TypeScript の `NodeProcessRunner` の結果を比較する parity test（`src/process/processParity.test.ts`）が windows-latest で green。
- longpath 対応（Issue #25 相当）: `GitClient.worktreeRemove` が Windows で `-c core.longpaths=true` 付きの `git worktree remove` を試み、失敗時は `platform.removeTree`（long-path safe `fs.rm`）+ `git worktree prune` にフォールバックする（`src/git/index.test.ts`）。**訂正（以前の版は本節と16.4項目7で「この開発機では core.longpaths の有無に関わらず git がそのまま成功し、フォールバック経路は発火しなかった」としていたが、これは事実誤認だった）**: 実機検証の結果、`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` でこのマシン自身の git 設定（`core.longpaths=true` を含む）を分離すると、300文字超のネストされたパスを含む worktree に対する `git worktree remove --force` は、**`core.longpaths` がどこにも設定されていない状態では実際に「Filename too long」（exit 255）で失敗する**(admin entry・gitfile・tracked files は削除済みで `git worktree list` からも消えた状態で、undeletable な subtree だけが残る)。`exec` の `-c core.longpaths=true` はこれを解消するが、**グローバルまたはシステムの git config ファイルで `core.longpaths=false` が設定されている場合、git は config ファイル読み込み中にその値をキャッシュするため後続の `-c` より優先され、`-c` があっても同じ失敗が再現する**。`worktreeRemove` のフォールバックはこの両方のケース(`-c` が無い場合、および `-c` があっても global/system 設定に負ける場合)のために存在し、`git worktree list --porcelain` に対象がもう listed されていないことを確認してから `platform.removeTree` + `git worktree prune` を実行する。`src/git/index.test.ts` は `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` でこの両ケースを明示的に分離して再現する: 「設定なし」のケースでは git 自身（`-c`）が削除し `removeTree` が呼ばれないことを spy で確認し、「global に false」のケースではフォールバックが実際に発火して削除することを確認する。さらに `worktreeRemove` は削除を試みる前に対象が `git worktree list` に載っていることを要求し（載っていなければ `Refusing cleanup because Git does not list the target as a worktree: <path>` を throw）、無関係なディレクトリや他 repository の worktree がフォールバックで削除されることを防ぐ。

WSL2/Linux 上での確認はフェーズ1・7 の gate に含めない（ADR-0001 Amendment 2026-09-05）。POSIX 版 `PlatformAdapter`（`killProcessTree`・`isReparsePointInPath`・`removeTree`・no-op `createProcessContainer`）は型を満たし `src/platform/posix.test.ts` にテストを持つが、CI gate ではない。

**フェーズ3（git）は完了した。**（PR #54）`GitClient.diff`（`src/git/index.ts`）が `Get-HdoDiff`（Git.ps1）を移植し、tracked 変更は単一の `git diff --binary --no-ext-diff <baseCommit> --` + `git diff --numstat <baseCommit> --` で、untracked file は各々 `git diff --no-index --binary --`/`--numstat --` で個別に取得して連結する。集約 diff が 32 MiB を超える場合はその時点で throw する（`--` 以降のバイナリ diff の断片が壊れた形で `stdout` に混ざるのを防ぐため）。各 `git diff` 呼び出しは `Get-HdoDiff` と同じ `-TimeoutSeconds 300` を持つ。この phase には `config`/`doctor` のような実行時 pwsh 比較 harness は無く、`src/git/index.test.ts` が `tests/run-tests.ps1` の該当行から書き写した oracle 値（`// Oracle: tests/run-tests.ps1:<line>` コメント）に対する unit test として終了条件を検証している。

**フェーズ4（github）は完了した。**（PR #57）Issue 正規化（`normalize.ts` の `ConvertTo-HdoIssueContract` 相当）、pickup 順序と `candidateLimit`（`issues.ts`）、`trustedActors` に基づく ready label/claim の authorization 検証（`authorization.ts`）、claim marker の読み書きと lease（`claim.ts`）、label 同期（`labels.ts`）、markdown 断片抽出（`markdown.ts`）、project contract の file 読み込み後 schema 検証（`contractValidation.ts`）、`gh` 呼び出し（`client.ts` の `GhClient`）を実装した。`hdo issues`/`hdo inspect` の CLI 配線はフェーズ7（cli/plugin）まで無いため、ADR-0001 が述べる「PowerShell 版と一致する」終了条件は、フェーズ3と同じ oracle-value 方式（`src/github/*.test.ts` の `// Oracle: tests/run-tests.ps1:<line>` コメント）で測定している。

**フェーズ5（runners）は完了した。**終了条件（ADR-0001 Migration strategy フェーズ5:「同一 prompt/schema に対する `hdo run -DryRun` の execution plan が両実装で一致する」）は、`run -DryRun` 自体を組み立てずに次の3つの parity で分解して測定する:

- **execution plan parity**: 既存の `src/cli/configParity.test.ts`（`config/hdo.default.json` と `config/examples/*.json` の4例、Ollama hybrid/lean worker の両方を含む、を `CASES` に持つ）。
- **preflight parity**: `src/cli/doctorParity.test.ts` - `hdo.ps1 doctor -DryRun -Json` と `main.ts doctor -DryRun -Json` を比較する。これは `run -DryRun` が組み立てる `preflight`（`Test-HdoEnvironment -ReadOnly`）半分の直接 oracle である。
- **adapter parity**: `src/runners/runnersParity.test.ts`（Claude/Codex の argument 組み立て・schema 変換・prompt 生成・failure detail・review result 判定を pwsh oracle と比較）と、`src/process/processParity.test.ts` に追加した `.cmd` ケース（`.cmd`/`.bat` shim 経由の実 process 実行の比較）。

`Invoke-HdoRun -DryRun` 自体の組み立て（`execution` + `preflight` + フェーズ4の GitHub/contract object の合成）と `Invoke-HdoValidation` の実行はフェーズ6に委譲する（ADR-0001 Migration strategy フェーズ6:「plan→implement→validate→review→fix の bounded loop、`.hdo/project.json` の gate 実行を実装する」。gate 実行はフェーズ6の deliverable として明示されており、setup failure と product failure の分類（Issue #16）もフェーズ6が初日から行う）。Ollama 対応のスコープ（Issue #37）は `docs/adr/0001-primary-runtime-typescript.md` の Amendments に記録した。

**フェーズ6（workflow）は完了した。** 終了条件（ADR-0001 Migration strategy フェーズ6:「`NoWriteBack` full run が両実装で同じ state 遷移・同じ diff・同じ review 判定に到達する」）は `src/cli/runParity.test.ts` が測定する: 決定論的な mock `gh`（`tests/fixtures/workflow/gh/gh.cmd`）・mock plan/implement/fix/review agent（`mock-workflow-agent.ps1`）・mock validation gate script（`tools/gate-pass.ps1`/`gate-fail.ps1`）を用いて、2つの独立した（内容とコミット日時が同一で、`baseCommit` が一致することを assert する）throwaway fixture repository に対し `hdo.ps1 run -Issue 7 -NoWriteBack -Json`（oracle）と `node src/cli/main.ts run -Issue 7 -NoWriteBack -Json` を実行し、13シナリオ（approve-first・fix-then-approve・fix上限escalate/fail・review escalate・no-diff escalate/fail・gate-fail escalate/request-changes・gate setup failure・implement 異常終了・DryRun・preflight failure）それぞれについて exit code、canonicalise した `run.json`、`state.transition` イベント列、iteration ごとの `diff.json`/`validation/result.json`/`review/result.json`、`final/summary.json`、stdout JSON を比較する。実 agent（Claude/Codex/Ollama）・実 GitHub・network には一切依存しない。`run`（`-Issue`/`-Pick`/`-NoWriteBack`/`-DryRun`/`-Json`/`-Config`/`-Profile`/`-SetStep`/`-IgnoreRepositoryConfig`/`-Repository`/`-RepositoryPath`）と `status`（`-RunId`/`-Json`）は、フェーズ1の `config`、フェーズ5の `doctor` と同じ理由（この2コマンドがそれぞれの終了条件の直接 oracle であるため）で、フェーズ7の CLI 移植を待たずフェーズ6の時点で `main.ts` へ配線している。フェーズ6で実装・修正した Issue（#16 gate setup failure 分類、#62 `ConvertFrom-Json`/`Get-HdoUtcTimestamp` の DateTime 破損、#63 `_KEY` サフィックス、#8 doctor の `gate:<id>` check）と、両実装での PS/TS 差異は §16.4「フェーズ6」リストに記録している。 フェーズ6完了後の最初の後続項目は Issue #64（死んだ run が残す active claim の解放/resume 手段と `leaseExpiresAt` の期限判定）で、claim 周りの挙動は両実装とも現状のまま鏡写しにしている。

フェーズ6の outer workflow の書き方（自作 dispatch loop、XState は採らない、ADR-0003 D1）と、フェーズ8での lean worker 移植の進め方（依存 0 ベースライン → `poc/ai-sdk/` 比較 PoC → 採否記録）は ADR-0003（`docs/adr/0003-agent-harness-lightweight.md`）に記録した。その (c)（採否記録）は ADR-0003 Amendment「2026-09-07: フェーズ8 (c) 採否決定」で **AI SDK 不採用・依存 0 ベースライン継続**として閉じた。フェーズ8完了により、既定の `config/examples/ollama-lean-worker.json` は `node` 版 lean worker を起動し、`pwsh` は TypeScript runtime のどの route の要件でもない。`workers/hdo-ollama-worker.ps1`（PowerShell worker）を明示的に起動し続ける構成を利用者が選ぶ場合に限り、その環境に `pwsh` が必要になる。

**フェーズ7（cli/plugin）は完了した。** 終了条件（ADR-0001 Migration strategy フェーズ7、この順で満たす）は「(i) `doctor`・`config`・`inspect`・`run -DryRun` の4コマンドについて `-Json` 出力が両実装で意味的に等価になる、(ii) `status`・`cleanup -WhatIf`・`labels -WhatIf` についても `-Json` 出力が共有 fixture に対して両実装で意味的に等価になることを追加で確認する」。(i) は既存の `src/cli/configParity.test.ts`（`config`）・`src/cli/doctorParity.test.ts`（`doctor -DryRun`）・`src/cli/runParity.test.ts` の DryRun シナリオ（`run -DryRun`）に加え、本フェーズで新設した `src/cli/inspectParity.test.ts`（`inspect`、残り1コマンド）で測定した。(ii) は新設した `src/cli/statusParity.test.ts`（`status`）、`src/cli/cleanupParity.test.ts`（`cleanup -WhatIf`、WhatIf preview・already-missing・worktreeRoot 外・非 worktree・dirty without -Force の5シナリオそれぞれについて stdout・stderr・exit code に加え、worktree ディレクトリと `run.json` が前後で不変であることを両実装で確認する）、`src/cli/labelsParity.test.ts`（`labels -WhatIf`、`-WhatIf` 単独と `-Apply -WhatIf` の2ケース。後者は mock `gh` が `label create` を一度も受け取らないことを assert する）で測定した。ADR-0001 の7コマンドには含まれないが移植対象である `issues` も `src/cli/issuesParity.test.ts` で比較している。これらの mock `gh` は新設した `tests/fixtures/cli/gh/`（`gh.cmd`・`issue-list.json`・`label-list.json`）に置き、フェーズ6の `tests/fixtures/workflow/gh/gh.cmd` は変更していない。

(i)・(ii) が green になったことを受け、cut-over コミットで全8個の `commands/*.md`（`allowed-tools` を `Bash(pwsh:*)` から `Bash(node:*)` へ、起動行を `node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" <cmd>` へ変更）と全8個の `skills/*/SKILL.md`（`../../hdo.ps1` を `../../src/cli/main.ts` へ、`pwsh -NoProfile -File` を `node` へ変更し、`node_modules` が無い場合に plugin root で `npm ci` を一度実行する旨を resolve step へ追記）を1コミットで TypeScript 実装へ切り替えた。`.claude-plugin/plugin.json`・`.codex-plugin/plugin.json` は `description` から `hdo.ps1` への言及を外し、`keywords` の `powershell` を `typescript`/`nodejs` に置き換え、`version` を `0.11.0` → `0.12.0` に上げた。`tools/check-plugin-version.ps1` の `$watchedPaths` に `package.json`/`package-lock.json` を追加した（cut-over 後は node の依存 - ajv/ajv-formats/koffi - も client に配布される面の一部になるため）。`hdo.ps1` と `src/HybridDevOrchestrator/` は削除していない。

本フェーズで doctor に `node-version` check（`required: false`、Node 24 以上で `pass`、それ未満または `node` 未検出で `warning`）を、両実装へ同じ name・同じ位置（`command:git`/`command:gh` の直後）・同じ message で追加した（ADR-0001 の revisit condition #2 が前提としていた check）。また `issues` の parity test を書く過程で、`Get-HdoIssueCandidate` の `Sort-Object @{ Expression = 'priorityRank'; ... }` が `ConvertTo-HdoHashtable` の返す `[ordered]`（`OrderedDictionary`）に対しては no-op であり、`hdo.ps1 issues`/`run -Pick` が一度も候補を sort せず `gh issue list` の返した順のまま返していた既存不具合を発見し、PowerShell 側を修正した（ADR-0001 Decision 節が maintenance mode に許す「既存不具合の修正」に当たる）。

**フェーズ8（workers）は完了した（2026-09-07）。** 終了条件（ADR-0001 Migration strategy フェーズ8、ADR-0003 D2）は次の4つである。

- **(a) 依存0の `node` 版 worker**: route 2 の lean worker `workers/hdo-ollama-worker.ps1` を `src/workers/leanWorker/`（entry point `src/workers/leanWorker/main.ts`。`args.ts`・`ollamaClient.ts`・`session.ts`・`tools.ts`・`toolDefinitions.ts`・`workspaceGuard.ts`・`historySlicing.ts`・`compaction.ts`・`summarizer.ts`・`verifiedState.ts`・`log.ts`・`text.ts` に分割）へ移植した。`node:fs`・`node:path` 以外の runtime 依存を持たず、Ollama `/api/chat` の呼び出しは Node 24 の native `fetch` を使う（AI SDK 等の framework は使わない - それは (b) の比較 PoC 側でのみ検討する）。
- **(i)** `tests/test-lean-worker.ps1`（715行）を TypeScript へ移植したテスト（`src/workers/leanWorker/*.test.ts`）が、`node:http` で立てた ephemeral port 上の mock Ollama サーバーに対して `node` 版 worker を実行し pass することを CI gate として測定する。PR #55 で追加された token-aware context compaction（context accounting、working summary、worker-verified state）のケースを含む。
- **(ii)** 実 Ollama を必要とする opt-in smoke（`tests/test-lean-worker-smoke.ps1` の TypeScript 相当）は、環境変数 `HDO_LEAN_WORKER_SMOKE=1` が設定されている場合にのみ実行され、PowerShell worker の smoke と同じ assertion を `node` 版 worker に対して検証する。通常の `npm test`・CI では実行されず、意図的に CI gate にしていない。
- **(iii)** `config/examples/ollama-lean-worker.json` の `ollama-lean-implementer` runner を、`"command": "pwsh"` + `extraArgs: ["-NoProfile", "-File", "{hdoRoot}/workers/hdo-ollama-worker.ps1", ...]` から `"command": "node"` + `extraArgs` 先頭を `{hdoRoot}/src/workers/leanWorker/main.ts` とする形へ更新した。`command`/`extraArgs` の先頭2要素以外の token 契約（`-PromptFile {promptFile}`・`-OutputFile {outputFile}`・`-SchemaFile {schemaFile}`・`-WorkingDirectory {workingDirectory}`・`-Model {model}`・`-ContextTokens {contextTokens}`）と `schemas/*.json` は変更していない。`src/cli/configParity.test.ts` の execution plan parity（`-Config config/examples/ollama-lean-worker.json` ケース、pwsh を oracle として実際に実行）は変更後も pass することを確認済みである。

- **(iv)** `poc/ai-sdk/` に AI SDK（`ai@7.0.93` + `ollama-ai-provider-v2@4.0.1`）版の比較 PoC を実装し、Issue #48 の6指標で (a) と比較したうえで、採否を ADR-0003 の Amendment「2026-09-07: フェーズ8 (c) 採否決定」に記録した。**決定は「AI SDK を採用せず、依存 0 ベースライン `src/workers/leanWorker/` を継続する」**であり、repository root の `dependencies` は変更していない。

  実モデルに向かう4指標は `poc/ai-sdk/scripts/compare.mjs` が実 Ollama（`qwen3.8:27b-q4_K_M`、Ollama 0.33.3、Windows 11 / Node v24.20.0）に対して 3シナリオ × 2実装 × 3反復 = 18 run を実行して測定した。両 worker を同一の方法（直接 subprocess、同一 flag・prompt・fixture）で起動し、シナリオと成功判定は `src/workers/leanWorker/smoke.test.ts` から移している。結果は `poc/ai-sdk/results/comparison.json`（全 run の生値）と `comparison.md`（表）に含めた。

  - **completion rate**: 両実装とも 9/9。`completed` は exit 0 かつ schema 妥当な報告書があり、かつ workspace 上でタスクが実際に達成されていることを全て満たす run のみを数える。
  - **tool call 精度**: 98 call（baseline 52 / poc 46）中、失敗 0 件。両実装とも差がつかない。
  - **32K context 安定性**: 両実装とも 3/3 完了、compaction 0 回（32K では閾値に達しない）。
  - **token 消費**: 中央値は3シナリオとも PoC がやや大きい（+0.7% / +15% / +17%）が、**n=3 の分散がその差を上回るため有意差とは言えない**。`compaction-4k` のベースラインは自身の中で 5632〜19032 と 3.4 倍に振れる。記録する主張は「ベースラインが token 効率で優る」ではなく「**AI SDK は token 消費を改善しなかった**」である。
  - **実装量**: SDK が置き換えるベースライン側（`ollamaClient.ts` + `main.ts`）が 242 コード行に対し、PoC 自身（`main.ts` + `toolAdapter.ts` + `messageBridge.ts`）が 267 コード行で、**25 行の増加**。ADR-0003 の予測（120-140 行の削減）とは符号が逆で、その理由は予測が PowerShell 実装（1222 行）に対して立てられたのに対し、(a) の native `fetch` 移植が既に client を 66 コード行まで縮めていたことにある。加えて SDK は `ModelMessage` ↔ Ollama native message の変換（`messageBridge.ts`、65 コード行）を新たに要求する。
  - **依存**: インストール量は 12 package / 21.68 MB（ADR-0003 の予測と package 名・version まで一致）。ただし workspace 書き込み権限を持つプロセスに実際にロードされるのは 8 package / 103 file / 1.65 MB（`poc/ai-sdk/scripts/loaded-modules.mjs` が `node:module` の ESM `load` hook で実測。`undici` はロードされず Node native `fetch` が使われる）。ベースラインは 0（`node:` builtin と相対 import のみ）。
  - **security / auditability**: PoC でも ADR-0003 D3 は守れた（`WorkspaceGuard` と tool 実装は production の実体を import し、read-only では `write_file`/`edit_file` のキー自体が `ToolSet` に存在しない）。境界の設計は同等だが、境界の内側で信頼すべき第三者コード量が 0 か 8 package かという差が残る。

**フェーズ8完了に伴う発効事項**: ADR-0001 Migration strategy フェーズ8および ADR-0003 D2 が定める「(i)〜(iv) を満たした時点で `pwsh` を TypeScript runtime の route 2 要件から外し、PowerShell worker は maintenance mode へ移行する」が 2026-09-07 に発効した。`workers/hdo-ollama-worker.ps1` は maintenance mode（既存不具合の修正のみ、新規 subsystem を追加しない）へ移行し、`pwsh` は TypeScript runtime のどの route の要件でもなくなった。この PowerShell worker を明示的に起動し続ける独自 config（`command`/`args` を差し替えていない旧来の構成）を利用者が選ぶ場合に限り、その環境に `pwsh` が必要になる。`poc/ai-sdk/` は `poc/typescript/` と同じく凍結し、不採用の根拠として保存する（再評価トリガーは ADR-0003 Amendment 2026-09-07 に記載）。

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

以下はフェーズ2（process / platform）で判明した追加の意図的な差異である。

1. **`Invoke-HdoProcess -Environment` の Windows 環境変数注入**: PowerShell は `ProcessStartInfo.Environment.Clear()` してから明示的な `Environment` の内容だけを設定するため、明示指定した変数のみが子プロセスに渡る。TypeScript の `NodeProcessRunner`（`src/process/runner.ts`）は `spawn(..., { env })` に明示的な `environment` オブジェクトをそのまま渡すが、libuv 自身が Windows 上で子プロセスに常に注入する固定リスト（`HOMEDRIVE`・`HOMEPATH`・`LOGONSERVER`・`PATH`・`SYSTEMDRIVE`・`SYSTEMROOT`・`TEMP`・`USERDOMAIN`・`USERNAME`・`USERPROFILE`・`WINDIR`）が追加で子プロセスに見える。呼び出し側は Windows 上の明示的な `environment` を「指定した変数 + この固定リスト」として扱う必要がある（`src/core/process/types.ts` の `ProcessRunOptions.environment` doc comment 参照）。POSIX にはこの注入は無い。
2. **command 未解決時の throw vs 127**: `NodeProcessRunner.run` は `platform.resolveExecutable(command)` が `undefined` を返す場合 `Command was not found: <command>` を throw する（PowerShell の `Invoke-HdoProcess` が `Get-Command` failure で throw するのと同じ契約）。凍結済みの PoC（`poc/typescript/src/process/runner.ts`）はこれを `captureError`/exitCode 127 という**値**として表現していたが、これは PoC 限定の簡易実装であり本番の契約ではない（PoC のモジュールコメント参照）。
3. **spawn 失敗時のエラー文言**: PowerShell の `Invoke-HdoProcess` は `Process.Start()` が `false` を返した場合、詳細を含まない `Failed to start command: $Command` を throw する。TypeScript は working directory 不正・spawn 自体の同期例外のいずれも `Failed to start command: <command>. <detail>` と、Node が実際に報告する detail 文言を追加する（.NET の `Process.Start()` の bool 戻り値には対応する detail が無いため）。
4. **`.exe`/`.com` 限定の実行ファイル解決**: `PlatformAdapter.resolveExecutable`（Windows）は PATH・PATHEXT を辿るが、`shell: true` を使わない `spawn()` が同期的に throw する（EINVAL、CVE-2024-27980）ことを避けるため候補を `.exe`/`.com` のみに絞る。`.cmd`/`.bat`/`.ps1` の shim（npm グローバルの `claude.cmd`/`codex.cmd` 等）はこの adapter からは解決されない。PowerShell の `Get-Command` はこれらの shim を解決するため、この差は明示的にフェーズ5（runners）へ持ち越した。**フェーズ5で `.cmd`/`.bat` はこの gap を閉じた**（16.4 フェーズ5リスト参照）。`.ps1` は両実装で引き続き解決しない（Issue #35、フェーズ5リスト参照）ため、その部分だけこの項目は今も有効である。なお Windows の「App Execution Alias」（Microsoft Store 配布の `pwsh.exe`/`python.exe` 等、`%LOCALAPPDATA%\Microsoft\WindowsApps` 配下の reparse point placeholder）は `fs.existsSync`/`fs.statSync` では検出できない（`existsSync` は false を返し、`statSync` は `EACCES` を throw する）ため、`resolveExecutable` は `fs.accessSync(path, F_OK)` で存在を確認し、`fs.lstatSync(path).isSymbolicLink()` の場合は App Execution Alias として受け入れ（`statSync` が `EACCES` になるため）、それ以外の symlink/通常ファイルは `fs.statSync(path).isFile()` で判定する（この開発機で実機確認済み: `pwsh` が Program Files ではなく WindowsApps の App Execution Alias としてのみ存在する）。
5. **`stdoutBytes`/`stderrBytes` のチャンク粒度**: 出力上限到達時、PowerShell は 8192 byte 固定バッファで読み取るのに対し、Node のパイプは既定で最大 64 KiB の `highWaterMark` を持つ。そのため上限超過を検知した時点の受信済みバイト数（`stdoutBytes`/`stderrBytes`）は、上限ちょうどにはならず、実装依存の 1 チャンク分（最大 64 KiB 程度）の上振れがあり得る。両実装とも「`maximumOutputBytes` 以上」であることは保証するが、正確な超過量は一致しない - `src/process/processParity.test.ts` はこれを `>=` 比較で許容している。
6. **Windows Job Object の `OpenProcess` ステップ**: PowerShell の `KillOnCloseJob.TryAttach` は .NET `Process` オブジェクトが既に開いている handle を直接使うため `OpenProcess` を呼ばない。TypeScript は Node の `ChildProcess.pid`（PID のみ）から改めて `OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)` で handle を取得する必要があり、その失敗は PowerShell に対応物が無い `OpenProcess failed with Win32 error N.` という独自のエラー文言になる（ADR-0002 参照）。
7. **`GitClient` の longpath fallback**: `worktreeRemove` は `git worktree remove` が非ゼロで終了した場合、`git worktree list --porcelain` を再実行して対象がまだ listed かどうかで分岐する（`git worktree add`/`worktreeRemove` 自体は Windows でのみ `-c core.longpaths=true` を付与するが、この分岐・フォールバック処理コード自体に `platform.name === "windows"` のようなプラットフォーム判定は無く、POSIX でも同じロジックが動く - **訂正: 以前の版は本項目を「Windows で...のみ」としていたが、コードの実態と一致していなかった**）。まだ listed なら元の git 失敗をそのまま throw し、listed から消えていた場合のみ `platform.removeTree`（`fs.rm`）+ `git worktree prune` にフォールバックする。16.2 に記載の通り、このフォールバックは実機で実際に発火することを確認済み（`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` で git 設定を分離した `src/git/index.test.ts` のテスト）。フォールバックが失敗した場合は元の git 失敗メッセージに詳細を追記する。orphan recovery（`git worktree list` に一度も現れたことのない孤立 worktree の `-Force` 復旧、PowerShell 側の `Test-HdoOrphanedWorktree`相当）は意図的に含んでいない - phase 3+ の `cleanup` コマンド向け。
8. **`isReparsePointInPath` が検出できる reparse tag の範囲**: PowerShell の `Test-HdoReparsePointInPath`（`Runner.ps1`）は `Get-Item ... | Attributes -band [FileAttributes]::ReparsePoint` で判定するため、symlink/junction に限らず OneDrive のプレースホルダファイルや Windows Projected File System（ProjFS）のプレースホルダなど、あらゆる reparse tag を検出する。TypeScript の `isReparsePointInPath`（`src/platform/windows.ts`）は `fs.lstatSync(path).isSymbolicLink()` を使うため、symlink・ジャンクション・App Execution Alias は検出できるが、OneDrive/ProjFS のようなそれ以外の reparse tag は Node の `fs` モジュールがそもそも symlink として報告しないため検出できない。この差を native 呼び出しで埋める予定はない。なお、欠落したパスセグメントに対しては PowerShell の `Get-Item -ErrorAction Stop` と同様に例外を throw する（`src/platform/windows.test.ts`）。POSIX adapter（`src/platform/posix.ts`）は Windows-first の方針により未整合で、欠落セグメントを false として扱い root の判定を包含判定より先に行う。WSL2/Linux 対応 Issue で Windows 版と揃える。
9. **redact.ts の大文字小文字畳み込み**: JS の `/i` フラグと .NET の `RegexOptions.IgnoreCase` は、U+212A（KELVIN SIGN, "K"/"k" と等価とみなす）と U+017F（LATIN SMALL LETTER LONG S, "S"/"s" と等価とみなす）の扱いが異なる。これを閉じるには `/i` フラグの影響範囲を変える（他の全文字の畳み込みに影響しうる）か、Unicode `CaseFolding.txt` 相当の変換表を自前実装する必要があり、費用対効果が見合わないため既知の divergence として記録するに留める（`src/core/process/redact.ts` の `SECRET_PATTERNS` コメント参照）。
10. **タイムスタンプの文字列表現**: PowerShell の `startedAt`/`endedAt`（`Get-HdoUtcTimestamp` 相当、`[DateTimeOffset]::UtcNow.ToString('o')`）は `2026-09-05T15:43:50.7777426+00:00` のように 7桁の小数秒とタイムゾーンオフセット表記になるのに対し、TypeScript の `Date.prototype.toISOString()` は `2026-09-05T15:43:50.777Z` のように常に 3桁の小数秒と `Z` 表記になる。両者とも ISO 8601 として有効だが文字列としては一致しないため、`src/process/processParity.test.ts` はこれら3フィールド（`startedAt`/`endedAt`/`durationMs`）を比較前に削除している。
11. **`getSafeEnvironment` のキー順序**: PowerShell の `Get-HdoSafeEnvironment` は `Get-ChildItem Env:` から取得するため、キー順序は概ねアルファベット順（大文字小文字を無視）になる。TypeScript の `getSafeEnvironment`（`src/core/process/safeEnvironment.ts`）は入力オブジェクトの挿入順を保持する。実害は無い: `NodeProcessRunner`/`Invoke-HdoProcess` いずれも、最終的に子プロセスへ渡す環境変数ブロック自体は OS/libuv 側でソートされるため、この順序差が子プロセスから観測可能になることはない。

以下はフェーズ5（runners）で判明した追加の意図的な差異である。

1. **`.cmd`/`.bat` shim 経由の起動**（`src/core/process/cmdShim.ts`、`src/process/runner.ts`、`src/platform/windows.ts`）: PowerShell の `.NET Process.Start` は `.cmd`/`.bat` を cmd.exe 経由で暗黙に起動する際、MSVCRT quoting はするが cmd.exe 自身のメタ文字（`& | < > ^ ! ( )`）には一切の保護を行わない。TypeScript はこの shim 分岐に Windows（`process.platform === "win32"`）でのみ入り、`cmd.exe /d /s /v:off /c "<line>"` を明示的に起動する。`<line>` は `buildCmdShimCommandLine` が組み立てる: shim path は常に `"..."` で quote し、cmd.exe メタ文字は一切 caret escape しない（shim path は `/c` の command token として cmd.exe に一度しか parse されないため）。各 argument は MSVCRT 規則で quote したうえで、cmd.exe 自身のメタ文字を caret escape（`^^^`、caret 3個）するかどうかを、shim path を含む行全体を通して累積する quote parity（`"` を見るたびに反転する単一のトグル）で決める - ある文字の位置で parity が偶数（cmd.exe から見て「quote の外」）のときだけ escape する。これは per-argument では決められない: ある引数の MSVCRT quote 形が奇数個の `"` を含む場合（例: `a"` は `"a\""` という3個の `"` を持つ）、その引数が終わった時点で cmd.exe 自身の quote 状態は開いたままになり、直後の引数（それ自体は空白のみで quote された、一見安全な引数）のメタ文字が quote の外側で生きてしまう - `review-result.schema.json` の `"pattern": "^[a-f0-9]{40}..."` を含む引数の直後に空白+メタ文字を含む引数が続く場合が実例。以前の版はこの組み合わせを個別に「undecidable」として reject していたが、実機検証（cmd.exe の quote トグルは行全体で単一・累積であり `\"` を escape とは解釈しない）によりその判断は誤りだったと確定し、現在は上記の parity 追跡だけで安全に受理・quote/escape できる。reject が残るのは次の4種のみ: `%`（cmd.exe の展開を安全に無効化できないため）、CR/LF（コマンドラインを分断するため）、NUL などの C0 制御文字（タブ以外）、そして実際に CreateProcess へ渡るコマンドライン全体（`<COMSPEC の絶対パス> /d /s /v:off /c "<line>"`）が8191文字を超える場合。round 2 のレビューで実測した通り、上限を決めるのはこの実コマンドライン長のみで（8191文字ちょうどは実行され、8192で cmd.exe が「コマンド ラインが長すぎます」で失敗する）、shim の batch body の長さは上限に影響しない。`runner.ts` は解決済みの COMSPEC パスを含む実プレフィックスを builder に渡して判定する。COMSPEC は絶対パスの既存ファイルであることを要求する: 相対パスなら `Failed to start command: <command>. COMSPEC must be an absolute path to cmd.exe, got '<value>'.`、存在しないパスやディレクトリなら `Failed to start command: <command>. cmd.exe was not found at '<spawnFile>' (COMSPEC)` を spawn を試みる前に throw する（COMSPEC 未設定または空のときは `%SystemRoot%\System32\cmd.exe` へフォールバックするため、通常この経路には入らない）。対照的に PowerShell 側は同じ入力を黙って壊れた形で渡すうえに injection も許す: 上記の review-result pattern は `^` anchor が silently 消えた状態で子プロセスへ届き、`a"&whoami` のような入力はコマンド注入になる（実機確認）。なお、この安全策にも本質的な限界がある: `"%~1"` の形で自分の引数を再 quote する shim は、caret escape 済みのメタ文字1個につき caret 1個が残った状態で受け取る（PowerShell 側は同じ shim で injection になるため、この点では TS のほうが同等以上に安全）。`setlocal enabledelayedexpansion` を使う shim は引数中の `!var!` をそのまま展開してしまう（PowerShell 側も同一）。これらは呼び出し側では補正できない shim 実装者側の選択であり、npm 自身が生成する `cmd-shim` の shim はプレーンな `%*` のみで delayed expansion も使わない。また、cmd.exe 自身が書く stderr は日本語 Windows では CP932 であり、TS・PowerShell のいずれも UTF-8 として decode するため未知コマンド等のエラーテキストは両実装とも同じように文字化けする（parity、要修正なし）。最後に、拡張子を持たない qualified path（例 `C:\dir\tool` で `tool.cmd` が実在する場合）は TS の `resolveExecutable` では PATHEXT probe の対象にならず `undefined` になるが、PowerShell の `Get-Command C:\dir\tool -CommandType Application` は `tool.cmd` を返す - フェーズ2から存在する既知差異で、本フェーズでは変更していない。両実装とも既存の `runner:<name>:shim` preflight warning（`src/workflow/preflight.ts`）は変更していない。
2. **`.ps1` は両実装とも解決しない**（Issue #35）: TypeScript の `resolveExecutable` は元から `.ps1` を候補にしない。PowerShell 側は `Common.ps1`/`Workflow.ps1` の command 解決に `-CommandType Application` を追加し（#35 の修正、コミット `e56374a`）、`Get-Command` が `.ps1` より先に `.exe`/`.cmd` を返すようにした。結果として、npm-global レイアウト（`claude.ps1` と `claude.cmd` が同居）は両実装とも `claude.cmd` に解決し、`.ps1` しか無い command は両実装とも `not found` になる（16.4 フェーズ2リスト項目4も参照）。
3. **Claude `minContains` の除去と `Get-HdoJsonSchemaValueType` の型推論**（`src/core/runners/claudeSchema.ts`）: PowerShell の `Convert-HdoClaudeSchemaNode` は `minContains` が数値の `1`/`1.0` の場合だけそれを除去し、文字列 `"1"` は除去しない（`.NET` の文字列は `[System.Collections.IEnumerable]` に該当し、`-isnot [IEnumerable]` の条件を満たさないため。pwsh 7.6.5 で実機確認済み）。TypeScript はこれをそのまま再現している。また `Get-HdoJsonSchemaValueType` 相当の `jsonSchemaValueType` は、`const`/`enum` の値 `1.0` を PowerShell では `[double]` 由来の `'number'` と判定するのに対し、TypeScript は `JSON.parse` が `1`/`1.0` を区別できないため常に `'integer'` と判定する（該当する shipped schema は無い）。加えて、JSON Schema keyword 名の照合は TypeScript では case-sensitive（spec 通り）、PowerShell の `-in`/`-eq` は case-insensitive という差もある（`claudeSchema.ts`/`codexSchema.ts` のコメント参照）。
4. **Ollama structured-output 回復のテキスト処理**（`src/core/runners/claudeOutput.ts`）: `subtype: null` は PS の `[string]$null` -> 空文字列と同じ意味論で扱う（`Get-HdoValue` の既定値 `"success"` は key 自体が無い場合のみ適用され、`null` を上書きしない）。prefix 正規表現は PS の `\A`/`\z`（`m` flag 無し）を JS の `^`/`$` に置き換えている。`\s`（.NET は U+0085 NEL を含み U+FEFF を含まない、JS はその逆）と `Trim()`/`trim()`（.NET は U+FEFF を保持、JS は除去する）の Unicode 差はそのまま残る既知差異である。Ajv と PowerShell `Test-Json` の validation エラーは prefix（`Invalid JSON: `/`Schema validation failed: `）のみ契約とし、末尾の文言は一致させない。
5. **artifact のバイト列**（`src/runners/agentStep.ts`、`src/runners/artifacts.ts`、`src/runners/ollamaContextModel.ts`）: `prompt.md`・`output.schema.json`・`final.json`・Ollama の Modelfile はいずれも PowerShell 側が `Set-Content`/`-Encoding utf8NoBOM` で CRLF（Windows）を書き込むのに対し、TypeScript は常に LF で書き込む。`final.json` は codex/command runner が出力ファイルを直接書く経路や、Ollama route の構造化出力回復のように、schema validation より前に一旦生の text として `writeTextFile` で書かれる場合があるが、この raw 書き込みも `prompt.md` と同じく末尾に LF を1個だけ付与する（review round 1 finding 12 で修正済み。PowerShell 側は `Set-Content` により同じタイミングで CRLF になる点は変わらない）。`Write-HdoJsonFile` 相当（`writeJsonFile`）が出力する pretty JSON も、PowerShell `ConvertTo-Json` が保持する小数点付き数値表現（`1.0`）と TypeScript `JSON.stringify` の表現（`1`）が異なりうる。`startedAt`/`checkedAt` 等のタイムスタンプは16.4フェーズ2項目10と同じ理由（`ToString('o')` vs `toISOString()`）で文字列として一致しない。`agentStep.ts` の `onActivity(activity | null)` コールバックは、started/heartbeat の各呼び出しで同一の mutable object 参照を渡す（PS の `Invoke-HdoAgentStep` が `$Run['activity']` を都度書き換えるのと同じ意味論）。
6. **preflight のプラットフォーム固有テキスト**（`src/workflow/preflight.ts`）: `paths:*` の probe 失敗メッセージは Node の errno 文言と .NET の例外文言で異なる。`doctor` は `-Json` を付けなくても `config` と同様 JSON を出力し、PowerShell 版のテーブル表示は再現していない（16.4フェーズ2項目相当の既存方針と同じ）。TypeScript の `doctor` サブコマンドは、`config` がフェーズ1で先行実装されたのと同じ理由（`run -DryRun` の preflight 半分の直接 oracle）で、フェーズ7の CLI 移植を待たずに存在する。**（訂正）** 以前の版は `command:git`/`command:gh`/`runner:<r>:shim` の pass メッセージについて、TypeScript の `resolveExecutable` が PATHEXT のエントリそのままの大文字小文字（例: `git.EXE`）を返し、PowerShell の `Get-Command` はディスク上の実際の大文字小文字（例: `git.exe`）を返すという差異があるとしていたが、`windows.ts` の `realCasing` ヘルパー（PATHEXT candidate の実在を確認した後、対象ディレクトリを `readdirSync` して大小文字を無視した一致でディスク上の実際のエントリ名に置き換える）を追加したことでこの差異は解消済みである。TypeScript も `Get-Command` と同じくディスク上の casing（例: `git.exe`）を返す。`src/cli/doctorParity.test.ts` はレビュー round 2 で比較前の小文字化・セパレータ正規化を撤廃し、`doctor -DryRun -Json` の文字列値を大文字小文字・区切り文字ともに完全一致で比較する（`realCasing` の回帰は即座に検出される）。`src/runners/runnersParity.test.ts` の `canonicalize` はキーのソートのみを行い、文字列の大文字小文字正規化は行っていない。
7. **Codex schema 変換の throw と PowerShell 側の JSON 往復の罠**: `toCodexTransportSchemaJson`（`src/core/runners/codexSchema.ts`）が実際に throw するのは adapter が transport する4種のうち `project-contract`（`$defs.validationGate` が `description`/`workingDirectory` を optional のまま持つため）であり、`issue-contract` は optional な object property を持たないため素通りする（実機検証、`src/runners/runnersParity.test.ts` 参照）。メッセージは `Codex structured output requires every object property: description, workingDirectory.` である。加えて、この harness の作成中に新たに判明した PowerShell 側の罠（TypeScript には無関係）: `ConvertFrom-Json` は ISO-8601 らしき文字列値を field 名やスキーマに関係なく無条件に `[DateTime]` へ変換する。`Get-HdoUtcTimestamp` が生成する数値オフセット付きの形式（例 `2026-09-05T15:43:50.7777426+00:00`）は `Kind=Local` として構築され、`ConvertTo-Json` で再出力すると黙ってローカル時刻へシフトし小数秒桁も短縮される（実機確認: `2026-01-01T00:00:00.0000000+00:00` が UTC+9機で `2026-01-01T09:00:00+09:00` に化ける）。TypeScript の `JSON.parse`/`JSON.stringify` はこの変換を一切行わない。これはフェーズ6の run.json 読み書き（read-modify-write round trip）に影響しうる PowerShell 側の不具合であり、Issue #62 として起票した。**フェーズ6でこの不具合を修正した**（16.4 フェーズ6リスト項目2、および §16.4 フェーズ6リストの `ConvertFrom-HdoJson` 項目参照）: `ConvertFrom-HdoJson`（Common.ps1）が pwsh 7.5+ でのみ利用可能な `-DateKind String` を条件付きで渡すようになり、`Get-HdoUtcTimestamp` は `[DateTime]::UtcNow.ToString('o')` を返すよう変更した。最小 PowerShell バージョンは 7.2 のまま変わらない。
8. **`gh` の空配列 JSON 対応**（#50、コミット `ef5cdfd`）: `Invoke-HdoGhJson`（`GitHub.ps1`）は `-NoEnumerate` の結果を一旦ローカル変数に束縛してから `return` するよう修正した。`return` に直接 `-NoEnumerate` の結果を渡すと、呼び出し側の `@(Invoke-HdoGhJson ...)`（変数を介さない直接呼び出し形の `@()`）がパイプライン出力そのものを1件として再ラップし、空配列・1要素配列がもう一段ネストされてしまうため。TypeScript 側は `JSON.parse('[]')` が元から正しい空配列を返すため対応不要。なお `Get-HdoLabelNames`（`GitHub.ps1`）には `return @($names)` という、`$names` が0要素のとき PowerShell のパイプライン展開により呼び出し側が `$null` を受け取りうる、類似の潜在的な empty-array 落とし穴が残っていた（フェーズ5のスコープ外として記録していたもの）。**フェーズ6でこれも修正した**（Issue #61 item 4、コミット `92a3b79`）。
9. **`agentStep.ts` の runner type 検証順序**（`src/runners/agentStep.ts:127-140`）: `runner.type` が `codex`/`claude`/`command` のいずれでもない場合、TypeScript は `Unsupported runner type '<元の casing>'.` を artifact directory の作成（`mkdirSync`）や `prompt.md` の書き込みより前に throw するよう変更した（review round 1 deep-review N-6）。PowerShell の `Invoke-HdoAgentStep` は `[string]$runner.type`（Runner.ps1:547）という直接プロパティ読み取りが strict mode で `New-Item` より前に失敗するため、この順序変更で副作用（artifact directory 不在）が両実装で揃う。`type` の大小文字比較は case-insensitive だが、throw text 自体は正規化前の `rawType`（元の casing）を埋め込む。なお `timeoutSeconds` が欠落した場合は今も揃っていない差異として残る（review round 1 deep-review N-7）: TypeScript は `Math.trunc(asNumber(runnerObject.timeoutSeconds, 0))` が既定値 `0` になった結果を `validateRange` に渡し、明確なメッセージ（`timeoutSeconds must be between 1 and 86400 (got 0).`）で失敗するのに対し、PowerShell は strict mode のプロパティ未検出エラーになる。schema が `timeoutSeconds` を必須にしているため、いずれの実装でも schema-valid な config からは到達しない差異である。

以下はフェーズ6（workflow）で判明した追加の意図的な差異である。

1. **`events.jsonl` の改行コードと `diff.patch` の末尾 CRLF**: PowerShell の `Add-HdoRunEvent`（State.ps1）は `Add-Content` で1行ごとに CRLF を付与し、`diff.patch` も `Set-Content` により末尾へ CRLF が付く（16.4フェーズ5リスト項目5参照）。TypeScript の `runStore.ts`/`run.ts` は常に LF で書き込む。ファイルのバイト列は一致しないが、`events.jsonl` を行ごとに JSON parse した内容、`diff.patch` から計算した `diffHash`（sha256）はいずれも一致する（`runParity.test.ts` は改行コードを比較対象にしない）。
2. **タイムスタンプの文字列表現（#62 修正後）**: フェーズ6で `ConvertFrom-HdoJson`（`-DateKind String`、pwsh 7.5+）と `Get-HdoUtcTimestamp`（`[DateTime]::UtcNow.ToString('o')`）を修正した結果、PowerShell 側のタイムスタンプは16.4フェーズ2項目10の「7桁小数秒＋タイムゾーンオフセット」形式から「`Z` サフィックス」形式に変わった。ただし小数秒の桁数は PowerShell が7桁（`.ToString('o')`）、TypeScript の `toISOString()` が3桁のまま残り、両者とも `Z` 表記になった点だけが変わっている（本項目は16.4フェーズ2項目10の記述を置き換える）。`Claim-HdoIssue` が書き込む claim marker のタイムスタンプだけは `[DateTimeOffset]::UtcNow.ToString('o')` のままで、引き続き `+00:00` 表記を保持する（write-back 専用の経路であり、`runParity.test.ts` の NoWriteBack harness では観測されない）。全ての parity 比較はこれらのタイムスタンプ系フィールドを比較前に除去する（§3.5 参照）。
3. **`-Json` 無しでも JSON を出力する**: `run`/`status` は `-Json` を付けなくても常に JSON を出力する。PowerShell 版は `-Json` 無しで `Format-List`（`RunId/State/Issue/Profile/Iterations/Worktree/Artifacts/Summary/Error`）を表示するが、TypeScript はこのテーブル表示を再現していない（`config`/`doctor` と同じ既存方針、16.4フェーズ2項目相当）。`run -DryRun` では両実装に差異がある: TypeScript は `run`/`status` について `-Json` の有無に関わらず常に JSON を出力するが、PowerShell 版は `-DryRun` 単体（`-Json` 無し）では JSON を返さない。`hdo.ps1` の `run` コマンドは `if ($Json -or $DryRun) { Write-HdoCliOutput $result }`（`hdo.ps1:107`）により `-DryRun` 時は上記の `Format-List` 要約をスキップして `Write-HdoCliOutput` を呼ぶが、`Write-HdoCliOutput` 自体（`hdo.ps1:30-34`）は `$Json` だけを見て分岐するため、`-DryRun` のみでは `$result` が `ConvertTo-Json` されずそのまま PowerShell の既定フォーマットで出力される。JSON を得るには `-DryRun -Json` のように明示的に `-Json` を付ける必要がある。
4. **schema エラーメッセージの末尾と #65 のメッセージ経路**: `Agent step '<step>' produced invalid structured output` および `HDO produced an invalid validation blocker review` というメッセージの「先頭」は両実装で一致するが（16.4フェーズ1項目5と同じ契約）、schema エラー自体の本文（Ajv vs PowerShell `Test-Json`）は文言が異なる。加えて Issue #65（review が `request_changes` + `indeterminate` finding を伴うと常に fail する）について、PowerShell の `Test-HdoObjectSchema` は `Test-Json` のエラー path 表現に既知の誤りがあり、実際には `missingViewpoints` ではない箇所の失敗を `/missingViewpoints` として報告することがある（Ajv は正しい path を報告する）。この誤りは Issue #65 のメッセージ品質の一部として記録するに留め、フェーズ6ではレビュー semantics 自体を変更しない（プラン §7 Q2、§8 決定）。
5. **`Get-HdoRun`/`readRun` はタイムスタンプを変換しない**: PowerShell 側の `Get-HdoRun`（State.ps1）は `Read-HdoJsonFile` 経由で読み込むため、#62 修正後の `ConvertFrom-HdoJson`（`-DateKind String`）がそのまま適用され、日付らしき文字列を `[DateTime]` へ変換しない。TypeScript の `readRun`（`src/workflow/runStore.ts`）はそもそも `JSON.parse` しかしないため最初から変換しない。両実装とも `run.json` の read-modify-write が値を破壊しないという点で一致している。
6. **`ConvertTo-Json` の数値・非ASCII表現**: `run.json` に double 値（`1.0` のような小数点付き数値）は現れない（`fixAttempts`/`iteration`/`durationMs`/`reviewRound` はいずれも整数）ため、16.4フェーズ5項目5の数値差異は `run.json` には影響しない。非ASCII文字列（Issue title 等）は PowerShell `ConvertTo-Json` も TypeScript `JSON.stringify` もエスケープせずそのまま出力する（`<>&'` を含む。review の `evidenceDetail`（プラン §2.6/§3.5、`$validation | ConvertTo-Json -Compress -Depth 20` の文字列値）でも同じ挙動を実機確認済み）。
7. **`.hdo/config.json` の credential 混入時の sha256（#42）は PS 専用のまま**: 16.4フェーズ1項目2で記録した `assertRepositoryConfigSnapshot` の差異はフェーズ6でも未修正である。フェーズ6の fixture は `.hdo/config.json` を含まないため（`repositoryConfig.loaded=false`）、`runParity.test.ts` はこの差異の影響を受けない。
8. **worktree 作成失敗の failure category**: NoWriteBack モードで worktree 作成に失敗した場合、`run.state` がまだ `PREFLIGHT` であるため（プラン §5 semantic trap 3）両実装とも `PREFLIGHT_FAILED`（exit 3）になる - write-back が有効な場合は同じ失敗が `RUN_FAILED` になる。この分類は PowerShell 側の実装上の偶然（catch 節が `run.state` だけを見る）であり、`claimIssue` の失敗も同様に `PREFLIGHT_FAILED` になる。両実装で意図的に mirror している既知の癖であり、修正予定はない。
9. **`gate:<id>` doctor check と runParity oracle self-check で判明した `pwsh` 解決差**: `src/cli/doctorParity.test.ts`（Issue #8 の `gate:<id>` check を含む）は、`command:pwsh` を要求する project contract の gate に対して、両実装の `pwsh` 解決結果が実行ファイル名以外は同一パスであっても、ファイル名だけが `pwsh.exe` で異なる1点だけを許容する（`normalizePwshPath` で `<PWSH>` に正規化してから比較する）。原因は PowerShell 自身が `$PSHOME` を自分のプロセス PATH の先頭に追加するため、`hdo.ps1` 内の `Get-Command pwsh -CommandType Application` は常に実行中の pwsh 自身（Store install の場合 `C:\Program Files\WindowsApps\Microsoft.PowerShell_<ver>\pwsh.exe`）に解決される一方、Node の `platform.resolveExecutable('pwsh')` は素の PATH（`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` の App Execution Alias 等）だけを見るため。両者は同じバイナリを指しており、綴りが違うだけである。この機構が持つ実行時の帰結として、pwsh のインストールが2系統ある機械（例: MSI 版 7.4 が PATH の先頭、Store 版 7.6 で `hdo.ps1` を起動）では、`hdo.ps1` から起動される gate/agent は常に「実行中の pwsh」自身の下で動く一方、TypeScript から起動される gate/agent は「PATH 上で最初に見つかる pwsh」の下で動くため、両実装は実際に異なる pwsh バイナリで子プロセスを実行しうる - これは環境依存の正真正銘の差異であり、TypeScript 側では取り除けない。`doctor` の `gate:<id>` メッセージはこの差異が存在する環境ではそれを可視化する（`<PWSH>` への正規化は文字列比較上の許容であり、差異そのものを消してはいない）。GitHub Actions の `windows-latest` では両者とも `C:\Program Files\PowerShell\7\pwsh.exe` に解決されるため、この差は CI では観測されない。詳細は `src/cli/doctorParity.test.ts` のコメントを参照。
10. **PS oracle self-check**（`tests/run-tests.ps1`）: シナリオ b・g を `Invoke-HdoRun -NoWriteBack` の in-process 呼び出しで実行し、`state.transition` 列・`fixAttempts`・`result.decision`・#16 の gate 分類を検証することで、oracle 自体を TS との比較の前に単独でも pin している（コミット `4918cee`）。

以下はフェーズ7（cli/plugin）で判明した追加の意図的な差異である。

1. **`cleanup -WhatIf` は構造化 preview ではなく PowerShell の `ShouldProcess` 出力をそのまま再現する**（フェーズ7 plan Q1）: 終了条件 (ii) は `-Json` 出力の意味的等価であり、TypeScript が独自の構造化 preview object を新設すると PowerShell と等価でなくなる。PowerShell 側は `$PSCmdlet.ShouldProcess(...)` が `false` を返して関数が値を返さず、`Write-HdoCliOutput` の param binding で `$null` になり `ConvertTo-Json` が文字列 `null` を出す（実測確認済み）。TypeScript の `removeRunWorktree`（`src/workflow/cleanup.ts`）も同様に `undefined` を返し、`main.ts` はそれを明示的に `null\n` として出力する。What-if 行 `What if: Performing the operation "Remove HDO Git worktree" on target "<worktreePath>".` は **stdout** に出す（`-Json` の有無に関わらず）。exit code は 0 で両実装一致する。
2. **`labels -WhatIf`（`-Apply` 無し）は plain `labels` と完全同一**（フェーズ7 plan Q2）: PowerShell の `Sync-HdoLabels` は `$Apply -and $PSCmdlet.ShouldProcess(...)` で `$Apply` が false のとき短絡し `ShouldProcess` 自体を呼ばない。TypeScript の `syncLabels`（`src/github/labels.ts`）の `whatIf` オプションも `apply && whatIf` のときだけ有効になる同じ短絡評価を実装しており、`-Apply` を伴わない `-WhatIf` は observable な差を一切生まない。`-Apply -WhatIf` の場合のみ、label ごとに `What if: Performing the operation "Create or update" on target "<repository> label '<name>'".` を stdout へ出し、`applied` は全て `false` のまま `gh label create` を呼ばない。
3. **非 `-Json` 出力**（フェーズ7 plan Q3）: 既存の意図的差異（16.4フェーズ2項目相当、`config`/`doctor`/`run`/`status` と同じ方針）を踏襲し、本フェーズで新規に配線した `issues`/`inspect`/`cleanup`/`labels` の4コマンドも `-Json` の有無に関わらず同じ JSON を stdout に出す。PowerShell 版の `Format-Table`/`Format-List` 表示は再現していない。What-if 行（項目1・2）だけは両モードで出す。
4. **`issues -Json` で候補0件のときの stdout**（`src/cli/issuesParity.test.ts` を書く過程で判明）: PowerShell の `Write-HdoCliOutput`（共通ヘルパー）は `$Value | ConvertTo-Json` という pipeline 経由の呼び出しで、0要素配列はパイプラインを通ると0個のパイプラインオブジェクトへ展開されてしまうため `ConvertTo-Json` は何も受け取らず、**stdout は完全に空になる**（直接 `ConvertTo-Json -InputObject @()` した場合の `[]` にはならない）。TypeScript の `main.ts` は常に `JSON.stringify(candidates)` を呼ぶため、候補0件でも文字列 `[]` を出力する。`Write-HdoCliOutput` は JSON を出す全コマンドが共有するが、実際に空配列を返しうるのは `issues` だけなので、この quirk が外部から観測できるのはこの1箇所だけである。exit code はこの場合も両実装とも hdo.ps1:82 と同じ 4 で一致する（相違するのは stdout の文字列だけ）。この差異は意図的に受容し、修正予定はない。
5. **`node-version` doctor check の追加**: ADR-0001 の revisit condition #2（plugin 経由起動での `doctor` の `node-version` check fail 率を見直し閾値として使う）は、check そのものが未実装のまま存在を前提にしていた。フェーズ7で `node` が cut-over 後の CLI entry point になることを受け、`required: false`・Node 24 以上で `pass`・それ未満または `node` 未検出で `warning` の check を、`command:git`/`command:gh` の直後という同じ位置・同じ name・同じ message で両実装（`src/workflow/preflight.ts`、`Test-HdoEnvironment`（Workflow.ps1））へ追加した。`doctor`/`run -DryRun` のどちらも `node` の有無・version に関わらず継続する（`required: false`）。

以下はフェーズ8（workers、lean worker の TypeScript 移植）で判明した追加の意図的な差異である。フェーズ8は 2026-09-07 に完了し、`workers/hdo-ollama-worker.ps1` は maintenance mode へ移行した（§16.2「フェーズ8」段落を参照）。同 worker は maintenance mode 後も、下記の差異を記録した時点の PS oracle として参照可能なまま repository に残る。

1. **Ollama エラー応答の非 ASCII 文字化け（Issue #51）は意図的な改善であり、PS oracle の不具合を再現しない**（`src/workers/leanWorker/ollamaClient.ts`）: PowerShell の `Invoke-OllamaChat` は非 2xx 応答時に `Invoke-RestMethod` の `$_.ErrorDetails.Message` を `<status detail> - <body>` として例外メッセージに埋め込むが、Windows PowerShell の既定のエラー詳細処理は非 ASCII の応答 body を正しく decode できず、日本語を含む Ollama のエラーメッセージが文字化けすることが実機で確認されている。TypeScript の `invokeOllamaChat` は `fetch` + `response.text()` で応答 body を読むため、UTF-8 として正しく decode する。メッセージの外形（`Ollama request failed: <status detail> - <body>` というプレフィックスと、`<status detail>` 自体の文言は契約に含めない方針）は PS oracle と同じ形を保っており、parity test の substring assertion はこの外形だけを見るため、この文字化け修正は「再現すべき差異」ではなく「意図的な改善」として記録する。
2. **`search_files` の正規表現 dialect**（`src/workers/leanWorker/tools.ts`）: PowerShell の `Select-String` は .NET の正規表現（named-group 構文、balancing group、一部の `\p{}` category 名が異なる）を使うのに対し、TypeScript の `search_files` は ECMAScript の `RegExp`（`i` flag、`Select-String` の既定の大文字小文字非区別に合わせる）を使う。model が実際に生成する典型的なリテラル・文字クラスのパターンは両 dialect で同じに振る舞うため、この差はホスト自身の正規表現エンジンを使うという以上には吸収しない（PS oracle が .NET の dialect をそのまま使うのと対称的な扱い）。
3. **`list_files` のワイルドカードは NTFS 8.3 短縮名マッチングを再現しない**（`src/workers/leanWorker/tools.ts`）: `Get-ChildItem -Filter` は、対象ファイルの長い名前がパターンに一致しなくても、その 8.3 短縮名（例: `*.htm` に対する `FOOBAR~1.HTM` のような短縮名）に一致すれば返すことがある。TypeScript の `wildcardToRegExp` はファイルの実名（長い名前）だけを見る単純な大文字小文字非区別 RegExp であり、この NTFS 固有の quirk は再現しない。model が生成するパターンでこの quirk に依存することは通常なく、既知の非再現として記録する。
4. **token 見積りの `U+2028`/`U+2029` エスケープ差**（`src/workers/leanWorker/historySlicing.ts` の `measureMessageTokens`）: PowerShell の `ConvertTo-Json -Compress` は `U+2028`（LINE SEPARATOR）・`U+2029`（PARAGRAPH SEPARATOR）をそれぞれ6byteの ASCII エスケープ列として出力するのに対し、`JSON.stringify` はこれらを生の3byte UTF-8 のまま出力する。両者とも有効な JSON であり、この2文字を含む稀な入力でのみ byte 数（したがって token 見積り）がわずかに変わる。見積りが持つ既定の約3割の過大側マージンに比べて無視できる差であり、修正予定はない。
5. **数値引数の厳格パースは意図的な改善であり、PS oracle の丸めを再現しない**（`src/workers/leanWorker/tools.ts` の `parseStrictInt`）: `read_file` の `start_line`/`max_lines`、`search_files` の `max_results` に非数値の文字列（例: `"abc"`）を渡した場合は両実装とも例外になり、model は次のターンで見る `ERROR:` tool result から訂正できる。分岐するのは小数文字列（例: `"10.7"`）を渡した場合で、PowerShell の `[int]"10.7"` は暗黙に丸めて `11` を返しそのまま処理を続けるのに対し、TypeScript の `parseStrictInt` は `^-?\d+$` に一致しない値を数値・非数値の別なく `<引数名> must be an integer` として拒否する。丸めて処理を続けるより拒否して model に訂正させる方が安全であり、行儀の良い model が小数の行数・件数を送ることも通常ないため、意図的な差異として記録する。
