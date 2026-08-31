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

すべての外部 process は `ProcessStartInfo.ArgumentList` で executable と argument を分離して起動する。shell command string、`Invoke-Expression`、Issue text の command 化は使わない。stdout/stderr は各 stream 32 MiBを上限とし、agent step は非同期に artifact へ drain して64 KiBの診断 tailだけを保持する。Git/gh/validation のように結果を呼出元が消費する process も32 MiB以内に制限する。上限超過または timeout 時は process tree を停止する。

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

resume、cancel、daemon polling、PR/merge command は MVP に含まれない。

## 4. Configuration と route

設定 source は次を deep mergeする。array は連結せず後の値で置換する。

~~~text
config/hdo.default.json
  < %APPDATA%/hdo/config.json
  < explicit -Config
  < programmatic Overrides
  < -Profile / Issue Route Hint
  < -SetStep / StepOverrides
~~~

対象 repository の `.hdo/config.json` は code execution authority を持つため自動読込しない。`.hdo/project.json` だけを repository-owned trusted contract として読む。

source merge 後の configuration は `hdo-config.schema.json`、route 解決後は `Test-HdoConfiguration` で検査する。主な cross-field rule:

- active profile と step の runner 参照が存在する。
- plan/review は read-only、implement/fix は workspace-write。
- local provider は model を明示する。
- Codex は cloud/ollama/lmstudio、Claude は cloud provider を使う。
- GitHub token は runner environment へ渡さない。
- adapter-controlled flag と dangerous sandbox bypass を `extraArgs` で上書きしない。
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
codex exec --ephemeral --json --color never
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

### 9.2 Claude

Claude adapter は print mode、JSON output、session persistence 無効、JSON Schema output を使う。read-only は plan permission、workspace-write は edit permission に対応する。structured envelope から final JSON を取り出し、同じ schema で再検証する。

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
      events.jsonl
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
      events.jsonl
      stdout.log
      stderr.log
      final.json
      result.json
  final/
    diff.patch
    summary.json
~~~

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

`tests/test-suite.ps1` は runtime unit/integration test、bounded process-output stress test、CLI exit-code test をまとめて実行する。GPU/Ollama/GitHub success を必要とせず、configuration merge、routing、state、Issue normalization、schema runtime、credential redaction、review continuity、untracked diff、generic command adapter、stdout/stderr 上限、CLI success/argument/preflight code を検査する。

`tests/test-schemas.ps1` は bundled config/project/Issue/task/worker/review fixture と fail-safe negative fixture を検査する。実 provider/GitHub cycle は credential を持つ integration environment で別途行う。
