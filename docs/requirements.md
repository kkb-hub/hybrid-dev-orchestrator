# Hybrid Dev Orchestrator 要件定義

- 文書種別: 実装準拠 MVP 要件
- 対象 repository: `kkb-hub/hybrid-dev-orchestrator`
- 対象 OS: Windows native
- runtime: PowerShell 7.2 以上
- schema version: 1
- 最終更新: 2026-09-01

## 1. 概要

Hybrid Dev Orchestrator（HDO）は、GitHub Issue を起点に、task planning、isolated implementation、trusted validation、structured review、bounded fix を実行する one-shot CLI である。

LLM や agent harness は runner として抽象化する。`plan`、`implement`、`review`、`fix` の各 step は異なる runner を選択できる。既定は Claude CLI による claude-only profile であり、Codex は明示的に選択する profile、Ollama は任意の hybrid profile でのみ利用する。

~~~text
GitHub Issue
  -> normalize / validate / select
  -> read-only preflight
  -> optional GitHub claim
  -> isolated Git worktree
  -> plan (optional, read-only)
  -> implement (workspace-write)
  -> trusted validation gates
  -> review (read-only)
       -> approve
       -> request_changes -> fix -> validate -> review
       -> escalate
  -> artifact + optional GitHub status write-back
~~~

HDO が最適化する対象は単発のモデル能力ではなく、Issue からレビュー済み差分までの再現可能な time-to-correct-solution である。

## 2. MVP の目的

MVP は次を満たす。

1. GitHub Issue を明示指定、または決定的な pickup policy で1件選択できる。
2. Issue 本文を versioned contract へ正規化し、必須 section、label、dependency、validation gate を検証できる。
3. plan / implement / review / fix の runner、provider、model、reasoning、context、sandbox、timeout を設定で分離できる。
4. Codex も Ollama もない「Claude CLI のみの PC」で既定 claude-only profile が完結し、Codex/Ollama は選択した場合だけ検査する。
5. 現在の working tree を変更せず、固定した base commit から run 専用 worktree を作る。
6. Issue が指定した gate ID を、trusted `.hdo/project.json` の command へ解決して実行する。
7. review result を JSON Schema と semantic rule で検証し、finding を fix step へ渡せる。
8. fix 回数を有限にし、上限到達後に ESCALATED または FAILED で停止できる。
9. run state、prompt、structured output、diff、validation、review、最終結果を repository 外へ保存する。
10. dry-run と GitHub write-back 無効の full run を区別できる。

## 3. 非目的

MVP は次を行わない。

- commit、push、PR 作成、merge、Issue close、main branch 更新
- 成果物の現在の working tree への自動適用
- 無制限の fix loop
- daemon、常駐 polling、scheduler、複数 repository の自動巡回
- provider/model の暗黙 fallback
- model の自動 download / pull
- 独自 inference engine または独自 OpenAI-compatible proxy
- GitHub Projects custom field の必須化
- Linux、macOS、WSL2 の正式対応
- OS firewall、VM、container による汎用 command adapter の完全な network isolation
- 多段 reviewer orchestration、反証 batch、mutation runner、token telemetry

最後の項目群は review platform の post-MVP scope とする。なお、`hdo.ps1` を包む薄い Claude Code plugin（`.claude-plugin/` + `commands/`）は scope に含め、本 repository から配布する。多段 review 機能を持つ standalone review-platform plugin は引き続き post-MVP とする。

## 4. 前提環境

必須:

- PowerShell 7.2 以上
- Git for Windows
- Git repository と解決可能な `HEAD`
- GitHub CLI `gh`
- `gh auth status` が成功する認証
- GitHub Issue が有効な repository
- 対象 repository の `.hdo/project.json`
- active profile が参照する全 runner command

既定 profile では Claude CLI `claude` と、その authentication（OAuth login、または `passEnvironment` で明示継承する `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`）が必要である。Codex CLI は `config/examples/cloud-only.json` 等で明示的に選択した場合だけ必要になる。

PowerShell は 7.2 以上が必須であり、Windows 同梱の Windows PowerShell 5.1 では動作しない。「Claude のみの PC」でも `pwsh` の別途導入は前提となる。

Ollama は必須ではない。active step が `provider: ollama` の runner を参照するときだけ次を要求する。

- `ollama` command
- 到達可能な Ollama service
- runner の `model` と一致する導入済み model

HDO は不足 model を自動 pull しない。

## 5. CLI surface

root entrypoint は `hdo.ps1` とし、次の command を提供する。

| Command | 主な機能 |
|---|---|
| `help` | 現行 CLI usage を表示 |
| `doctor` | Git、GitHub auth、project contract、active runner/provider、保存先を preflight |
| `config` | merge・profile 解決後の execution plan を表示 |
| `issues` | eligible な pickup 候補を一覧 |
| `inspect` | Issue、正規化 contract、semantic validation を表示 |
| `run` | `-Issue` または `-Pick` で dry-run/full cycle を開始 |
| `status` | artifact の `run.json` を取得 |
| `cleanup` | run worktree を path/Git/dirty check 後に除去 |
| `labels` | label catalog の差分を表示し、`-Apply` 時だけ同期 |

代表構文:

~~~powershell
pwsh ./hdo.ps1 doctor [-RepositoryPath <path>] [-Config <path>] [-Profile <name>] [-DryRun] [-Json]
pwsh ./hdo.ps1 config [-RepositoryPath <path>] [-Config <path>] [-Profile <name>] [-Json]
pwsh ./hdo.ps1 issues [-Repository owner/repo] [-Json]
pwsh ./hdo.ps1 inspect -Issue <number> [-Repository owner/repo] [-Json]
pwsh ./hdo.ps1 run (-Issue <number> | -Pick) [-Repository owner/repo] `
  [-Config <path>] [-Profile <name>] [-SetStep <step=runner>] `
  [-DryRun] [-NoWriteBack] [-Json]
pwsh ./hdo.ps1 status -RunId <id> [-Json]
pwsh ./hdo.ps1 cleanup -RunId <id> [-Force] [-WhatIf]
pwsh ./hdo.ps1 labels [-Repository owner/repo] [-Apply] [-WhatIf]
~~~

### 5.1 Claude Code plugin

本 repository は Claude Code plugin としても利用できる。`.claude-plugin/plugin.json` と `commands/` は `hdo.ps1` の各 command を包む薄い層であり、orchestration logic を複製しない。plugin から実行しても、設定・schema・validation の正典は本 repository の CLI 実装のままである。schema を含む配布物は repository の `schemas/` を single source とし、編集元となる copy を作らない。

`-RepositoryPath` は local Git repository、`-Repository` は GitHub の `owner/repository` である。`-Repository` を省略した場合は設定または `origin` URL から解決する。

exit code は次を使用する。

| Code | 意味 |
|---:|---|
| 0 | command 成功、APPROVED、または dry-run 成功 |
| 2 | CLI、configuration、Issue contract 等の処理例外 |
| 3 | doctor / dry-run preflight 失敗 |
| 4 | `issues` の候補なし |
| 5 | full run が FAILED |
| 6 | full run が ESCALATED |

## 6. Configuration と runner

設定の詳細は `docs/configuration.md` を正典とする。

設定優先順位:

1. `config/hdo.default.json`
2. `%APPDATA%/hdo/config.json` が存在する場合
3. 明示した `-Config <path>`
4. `-Profile <name>`、または merge 後の `activeProfile`
5. `run -SetStep <step=runner>`

対象 repository の `.hdo/config.json` は、branch 内の untrusted runner command/argument を暗黙実行しないため、自動読込しない。project-owned command は `.hdo/project.json` の validation gate に限定する。

profile は `plan`、`implement`、`review`、`fix` の binding を持つ。`plan` だけは明示的に disable でき、その場合は Issue contract から synthetic task contract を生成する。ほかの3 step は必須である。

runner type:

- `claude`: 既定。print mode、`--safe-mode`、strict-mode 向けに正規化した JSON Schema output を使用する。
- `codex`: `codex exec` を非対話実行し、output schema と last message file を使用する。
- `command`: argument template と stdin/file transport を利用する adapter。stable config として利用する場合は schema と policy の両方を満たす必要がある。

provider:

- `cloud`
- `ollama`
- `lmstudio`
- `custom`（command runner のみ）

plan/review runner は `read-only`、implement/fix runner は `workspace-write` でなければならない。timeout は1–86400秒、`maxFixAttempts` は0–10とする。

runner の fallback 宣言、および `workflow.implicitFallback=true` は禁止する。model/provider を変更するには、profile、Issue route hint、`-Profile`、または `-SetStep` による明示選択を必要とする。

既定 `claude-only` profile は Codex/Ollama を一切参照しない。`config/examples/claude-only.json` は model を明示した Claude 構成、`config/examples/cloud-only.json` は Codex cloud 構成、`config/examples/ollama-hybrid.json` は plan/review を cloud、implement/fix を Ollama に割り当てる参考構成である。

## 7. GitHub Issue 契約

詳細な field と label 規則は `docs/issue-contract.md`、構造は `schemas/issue-contract.schema.json` を正典とする。

Issue の必須内容:

- title
- Problem / Context
- Goal
- In Scope 1件以上
- Acceptance Criteria 1件以上
- Validation Gate IDs 1件以上
- Priority: `p0` / `p1` / `p2` / `p3`
- Risk: `low` / `medium` / `high` / `critical`

任意内容:

- Out of Scope
- Constraints / Security Considerations
- Dependencies: `#123` または `owner/repository#123`
- Affected Areas
- Route Hint
- Additional Context

Issue、comment、添付、外部リンクは untrusted input である。Issue は validation gate ID を選択できるが、command を定義または上書きできない。

### 7.1 Label

- `hdo:ready`: contract を確認した Issue の実行許可
- `hdo:skip`: pickup / run 対象外
- `hdo:status/*`: mutually exclusive な coarse run status
- `hdo:priority/*`: mutually exclusive な pickup priority
- `hdo:risk/*`: mutually exclusive な risk
- `hdo:route/*`: mutually exclusive な logical profile hint

`hdo:ready` と `hdo:skip`、および `hdo:ready` と任意の `hdo:status/*` は同居できない。未知の reserved `hdo:` label は拒否する。

Issue Form は `hdo:ready` を自動付与しない。HDO は最新の ready label event と Issue の `updatedAt` を比較し、ready 付与後に更新された Issue を拒否する。`github.trustedActors` が空の場合、repository の label write permission を trust boundary とする。値がある場合は、最新の ready label actor を allowlist と照合する。

route label/section は provider や model ID ではなく profile 名を表す。CLI の `-Profile` は Issue route hint より優先する。

### 7.2 Pickup

pickup candidate は open、ready、not skipped、status なし、contract valid、gate ID valid、dependency resolved、active claim なしを満たさなければならない。

既定順序:

1. `github.priorityOrder`
2. `createdAt` の古い順
3. issue number の小さい順

GitHub API の返却順へ依存してはならない。HDO は最大1000件の ready Issue を取得して全候補を検査・整列し、その後に `candidateLimit` を適用する。明示 `-Issue` でも ready、skip、status、contract、gate、ready authorization の検証を省略しない。

### 7.3 Claim / write-back

write-back 有効時は worktree 作成前に managed comment を作り、comment ID が最小の valid active marker を best-effort lock の勝者とする。

~~~text
<!-- hdo:claim:v1 {"version":1,"kind":"claim",...} -->
~~~

marker comment author と `claimedBy` は一致しなければならない。`trustedActors` が非空なら両者と現在の authenticated actor を allowlist に照合する。空なら既存 marker の comment author association が `OWNER`、`MEMBER`、`COLLABORATOR` のいずれかでなければならない。claim 成功時は ready/status label を `hdo:status/claimed` へ置換し、設定により authenticated user を assignee に追加する。

phase label update は best effort であり、失敗は warning/event に記録して local cycle を継続する。final write-back は同じ managed comment を更新し、APPROVED / ESCALATED / FAILED に対応する status を設定する。Issue は自動 close しない。

claim lease 時刻は marker に記録するが、MVP は自動 force takeover を行わない。stale active marker の解消は Human recovery とする。

## 8. Dry-run と NoWriteBack

`run -DryRun` は次だけを行う。

- configuration/profile/step resolution
- GitHub Issue read と contract validation
- ready authorization
- project contract read
- selected command/provider の read-only preflight

AI runner、worktree、run artifact、GitHub mutation は作成しない。返却値の `mutations` は空である。

`run -NoWriteBack` は full local orchestration cycle を実行し、worktree、artifact、runner、validation、review、fix をすべて動かす。一方、claim comment、label、assignee を変更しない。

## 9. Project contract と validation

対象 repository の `projectContractPath` は既定で `.hdo/project.json` である。このファイルは repository-owned trusted contract とし、実行前に Human がレビューする。

主な内容:

- instruction/specification path
- validation gate
- worker policy
- review policy

validation gate は少なくとも ID、実行 file、argument array、working directory、timeout、required、exit code classes を持つ。HDO は command line string を shell evaluation せず、executable と argument array を process API に渡す。

Issue から選択された gate だけを実行する。gate working directory は worktree 内の既存 directory に制限し、path segment に junction/symbolic link がある場合は拒否する。exit code は `pass`、`fail`、`indeterminate` に分類し、timeout や未知 code は indeterminate とする。required gate が1つでも pass でなければ `allRequiredPassed=false` である。

validation gate は対象 branch が所有する code/command を host process として実行する。HDO は path、argument、credential environment、timeout を制約するが、任意 validation executable に OS-level filesystem/network sandbox を付与しない。信頼できない repository では low-privilege account、VM/container、または sandbox wrapper を使う。

既定 workflow は validation failure を reviewer へ渡して request_changes とする。設定により即時 ESCALATED または FAILED を選択できる。required validation が不合格のまま reviewer が approve しても、HDO は approval を拒否し blocker finding を追加する。

## 10. Worktree と変更境界

各 full run は固定した `HEAD` commit から次を作る。

- branch: `hdo/issue-<number>-<run-id>`
- worktree: `%LOCALAPPDATA%/hdo/worktrees/<run-id>`

ユーザーの現在の working tree にある未 commit 変更は base commit に含まれない。worker は専用 worktree だけを変更し、変更を commit しない。

diff は tracked change と untracked file を含めて取得し、reviewer へ完全な patch として渡す。aggregate patch は32 MiBを上限とし、超過時は truncated review を行わず失敗する。no diff は `workflow.onNoDiff` に従って FAILED または ESCALATED とする。

cleanup は run artifact の worktree path が configured root 内で、Git が worktree として認識する場合だけ実行する。dirty worktree は `-Force` がなければ拒否し、branch と artifact は cleanup 後も保存する。

## 11. State machine

~~~text
CREATED
  -> ISSUE_SELECTED
  -> PREFLIGHT
       -> ISSUE_CLAIMED -> WORKTREE_READY  (write-back enabled)
       -> WORKTREE_READY                   (NoWriteBack)
  -> PLANNING | IMPLEMENTING
  -> IMPLEMENTING
  -> VALIDATING
       -> REVIEWING
       -> CHANGES_REQUESTED
  -> REVIEWING
       -> APPROVED
       -> CHANGES_REQUESTED -> IMPLEMENTING
       -> ESCALATED
~~~

任意の non-terminal state から FAILED / CANCELLED への遷移を state core は許可する。APPROVED、ESCALATED、FAILED、CANCELLED は terminal である。MVP CLI は cancel/resume command をまだ提供しない。

不正な遷移は `Test-HdoStateTransition` と state test で拒否する。

## 12. Structured review と bounded fix

review runner は complete diff、task contract、validation result、previous review を読み、`schemas/review-result.schema.json` に従う JSON を返す。結果の `runId`、`baseCommit`、`diffHash`、`reviewRound` は orchestrator の期待値と完全一致しなければならない。

decision:

- `approve`
- `request_changes`
- `escalate`

finding は最低限次を持つ。

- stable `id`
- severity: `blocker` / `should` / `nit`
- category
- evidence: `measured` / `read`
- evidence detail
- status
- actionable
- path / line
- message / required action

fail-safe rule:

- `request_changes` は open actionable finding を1件以上必要とする。
- open blocker/should を含む approve を禁止する。
- indeterminate finding は escalate を必要とする。
- `missingViewpoints` は常に存在し、非空なら escalate を必要とする。
- escalate は `escalationReason` を必要とする。
- finding ID は大文字小文字を区別せず各 result 内で一意であり、previous review の ID は解消済みでも次 round へ明示的に持ち越す。消失または改名は拒否する。

`maxFixAttempts` は初回 implement の後に許可する fix 実行回数である。既定値2は、最大で「初回 implement + fix 2回」の3 implementation/review iteration を意味する。上限で open finding が残る場合は `workflow.onMaxFixAttempts` に従って ESCALATED または FAILED とする。

## 13. Run artifact

既定 root は `%LOCALAPPDATA%/hdo/runs/<run-id>` である。

root artifact:

- `run.json`
- `events.jsonl`
- `issue.raw.json`
- `issue.contract.json`
- `execution-plan.json`
- `effective-config.redacted.json`
- `environment.json`
- `worktree.json`
- `project-contract.json`
- `task-contract.json`

iteration artifact:

- step ごとの `prompt.md`, `envelope.json`（Claude）または `events.jsonl`（Codex / command）, `stdout.log`, `stderr.log`, `final.json`
- validation gate log と `validation/result.json`
- `diff.patch`, `diff.json`
- `review/result.json`

final artifact:

- `final/diff.patch`
- `final/summary.json`

FAILED でも作成済み artifact と `run.json` の error を保存する。prompt/log/output には Issue や source diff が含まれるため、artifact root の access control は利用者の責任で設定する。

## 14. Security / privacy

HDO は次を実装する。

- Issue text を prompt 内で untrusted と明示する。
- Issue text から validation command を生成しない。
- external process は executable と argument array で起動し、`Invoke-Expression` を使わない。
- stdout/stderr を各 stream 32 MiBに制限し、上限超過時は process tree を停止して失敗とする。agent step は逐次 artifact へ書いて診断用 memory tail を64 KiBに制限し、出力を直接消費する Git/gh/validation process も32 MiBを超えて保持しない。
- GitHub token を runner の `passEnvironment` に指定する設定を拒否する。
- known credential name/pattern を runner/validation environment と log から除外・redactする。
- plan/review と implement/fix の sandbox mode を semantic validation する。
- worktree path と cleanup target を configured root に制限する。
- validation working directory の junction/symbolic-link boundary を拒否する。
- dangerous bypass argument を拒否する。

ただし、`workerPolicy.networkAccess`、forbidden command、protected path は project policy と prompt の一部であり、HDO の process layer 自体が全 adapter または validation command に OS-level firewall、filesystem isolation、syscall interception を提供するわけではない。validation cwd の reparse-point 検査は process start 前の point-in-time check で、gate が引数や source 内の別 path を辿ることまでは制約しない。実効的な強制は Codex/Claude の sandbox と、low-privilege account、VM/container、firewall 等の host policy にも依存する。

cloud runner/reviewer を選ぶと、Issue、関連 source、validation result、diff が cloud provider へ送信され得る。Local Implementer という route 名は review を含む全処理が local であることを意味しない。

## 15. MVP acceptance criteria

- AC-01 `hdo.ps1 help` が9 command の現行 usage を表示する。
- AC-02 default config の execution plan が cloud runner だけを参照し、Ollama を probe しない。
- AC-03 explicit hybrid config を選んだ場合だけ Ollama command/model を preflight する。
- AC-04 plan/implement/review/fix を別 runner に割り当て、resolved plan を表示・保存できる。
- AC-05 Issue Form の必須 section、priority、risk、gate ID を正規化できる。
- AC-06 ready/skip/status の競合、同一 label axis の複数値、未知 gate を拒否する。
- AC-07 pickup が priority、createdAt、number の決定的な順で候補を返す。
- AC-08 `run -DryRun` が worktree、artifact、GitHub mutation、runner process を作らない。
- AC-09 `run -NoWriteBack` が full cycle を実行し、GitHub comment/label/assignee を変更しない。
- AC-10 full run が専用 worktree を作り、現在の working tree を変更しない。
- AC-11 Issue command ではなく `.hdo/project.json` の validation gate だけを実行する。
- AC-12 runner output と review result を JSON Schema で検証する。
- AC-13 required validation failure中の approve を拒否する。
- AC-14 request_changes が fix 上限内で fix/validate/review を繰り返し、上限後に停止する。
- AC-15 tracked/untracked change を含む diff と主要 artifact を repository 外へ保存する。
- AC-16 provider/model の暗黙 fallback、model auto-pull、worker commit/push を行わない。
- AC-17 claim 競合時に comment ID 最小の valid marker だけを勝者にする。
- AC-18 cleanup が root 外 path、Git 管理外 worktree、非 Force の dirty worktree を拒否する。
- AC-19 schema fixture、state transition、Issue normalization、default/hybrid routing、credential redaction、command adapter を GPU/Ollama 不要の test で検証できる。

## 16. Post-MVP

- explicit cancel / resume と process-tree recovery UX
- stale claim の安全な lease recovery
- OS-level network policy の強化
- GitHub Enterprise / 複数 repository orchestration
- reviewer lens の多段実行、反証、mutation validation
- usage/token telemetry schema と集計
- standalone review-platform plugin（多段 review lens）と Codex review adapter の独立配布
- WSL2 / Linux / macOS
- self-hosted local-model integration benchmark
