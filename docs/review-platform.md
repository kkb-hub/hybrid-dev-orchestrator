# HDO Review Platform

- 文書種別: 実装状況と shared review contract
- 出自: `kkb-hub/net-equity` の多段レビュー運用
- 現在の scope: HDO MVP の single structured reviewer
- 最終更新: 2026-09-01

## 1. 現在の結論

net-equity で得た finding 規律のうち、HDO の implementation/review cycle に必要な **shared schema、fail-safe decision rule、validation evidence、bounded fix loop** は実装済みである。

当初「post-MVP」としていた Claude Code plugin のうち、`hdo.ps1` を包む**薄い wrapper plugin**（`.claude-plugin/` + `commands/`）は方針を変更して本 repository に同梱した。Claude Code から `/hdo:run` 等で CLI を起動できるが、orchestration logic・schema・validation の正典は CLI 実装のままである。

一方、多視点 reviewer の orchestration、反証 batch、mutation runner、usage/token telemetry、および多段 review 機能を持つ standalone review-platform plugin は引き続き post-MVP とする。現在の repository にそれら未実装機能が存在することを前提にしてはならない。

HDO MVP の review は、profile の `review` step に割り当てた1 runner が complete diff を構造化レビューする方式である。既定 profile は Claude runner を使うが、runner は Codex、Claude、または command adapter から選べ、Claude 固定ではない。

## 2. net-equity から継承した原則

次の原則を harness 非依存の contract として継承した。

1. finding は自然言語の箇条書きだけでなく versioned JSON にする。
2. finding ID を安定させ、fix と次 review で同じ問題を追跡する。
3. 「コードを読んだ根拠」と「実行して測った根拠」を区別する。
4. request_changes は具体的な open actionable finding を必要とする。
5. 判定不能や未実施 viewpoint を空の成功に変換しない。
6. validation の実測結果を review evidence として渡す。
7. fix loop を有限にし、上限後は Human へ戻す。
8. detection、product failure、indeterminate を混同しない。
9. schema の手編集コピーを複数箇所に作らない。

net-equity Issue #106/#107 の comment はこの判断の履歴資料であり、現在の normative contract ではない。normative source は本 repository の schema、project contract、runtime validation、test である。

## 3. 実装済みの共有物

### 3.1 Schema の定義元

review の唯一の schema 定義元は次である。

- `schemas/review-result.schema.json`

関連する境界 schema:

- `schemas/issue-contract.schema.json`
- `schemas/task-contract.schema.json`
- `schemas/worker-result.schema.json`
- `schemas/project-contract.schema.json`

Codex adapter は `--output-schema`、Claude adapter は JSON Schema output、command adapter は返却 JSON の runtime validation に同じ schema file を使う。HDO 用と将来 plugin 用に別の finding schema を作らない。

Claude adapter は CLI の strict-mode 制約のため、`--json-schema` へ渡す直前に in-memory の transport copy を正規化する（`$schema` / 既定値 `minContains` の除去、`type: "array"` 補完）。これは実行時変換であり、編集可能な copy を生成しない。出力の再検証は canonical schema で行う。

同梱した thin-wrapper plugin は schema copy を持たず、repository の `schemas/` を直接参照する。将来 plugin へ schema を同梱する場合も、この source から生成し、version/hash を CI で照合する。配布物の copy は編集元にしない。

### 3.2 Review input

review runner は少なくとも次を受け取る。

- untrusted Issue contract
- planned task contract
- trusted project review policy
- validation result
- previous review。初回は null
- base commit と complete diff hash
- tracked/untracked change を含む complete diff

review runner は read-only でなければならない。review が source を直接修正することは禁止し、修正は `fix` runner に戻す。

### 3.3 Review result

root field:

| Field | 契約 |
|---|---|
| `schemaVersion` | `1` |
| `runId` | 現在の run ID と完全一致 |
| `baseCommit` | review 対象 worktree の固定 base commit と完全一致 |
| `diffHash` | review へ渡した complete diff の SHA-256 と完全一致 |
| `reviewRound` | 1以上 |
| `decision` | `approve`, `request_changes`, `escalate` |
| `summary` | 空でない summary |
| `missingViewpoints` | 常に存在する配列 |
| `findings` | finding 配列 |
| `escalationReason` | escalate 時に必須 |

finding field:

| Field | 契約 |
|---|---|
| `id` | run 内で追跡する stable ID |
| `severity` | `blocker`, `should`, `nit` |
| `category` | `product_bug`, `test_detection`, `docs`, `spec_decision`, `process`, `minor` |
| `evidence` | `measured` または `read` |
| `evidenceDetail` | 根拠の具体的説明 |
| `status` | `open`, `resolved`, `waived`, `refuted`, `indeterminate` |
| `actionable` | fix action が必要か |
| `path`, `line` | source location。line は null 可 |
| `message` | 問題の説明 |
| `requiredAction` | actionable=true の場合に必須 |

`measured` は gate、reproduction、test 等を実行した結果、`read` は source/spec/diff を読んだ根拠を表す。どちらも `evidenceDetail` を省略できない。

### 3.4 Fail-safe rule

JSON Schema と runtime semantic validation は次を拒否する。

- decision が未知
- finding ID が空、または同一 result 内で重複
- request_changes に open actionable finding がない
- approve に open blocker/should finding がある
- indeterminate finding があるのに escalate でない
- `missingViewpoints` がない
- missing viewpoint があるのに escalate でない
- escalate に `escalationReason` がない
- actionable finding に `requiredAction` がない
- `runId`、`baseCommit`、`diffHash`、`reviewRound` が orchestrator の期待値と一致しない
- previous review に存在した finding ID が次 round から消える

required validation gate が pass していないのに reviewer が approve した場合、orchestrator は approval を request_changes へ変更し、measured evidence を持つ blocker finding を追加する。

finding ID は大文字小文字を区別せず各 result 内で一意でなければならない。MVP runtime は previous review の全 ID が次 round にも存在することを検査し、解消済みでも `resolved`、`waived`、`refuted`、`indeterminate` のいずれかとして明示的に持ち越すことを要求する。複数 reviewer 間の統合 ledger は post-MVP とする。

## 4. Bounded fix loop

既定は `maxFixAttempts: 2` である。

~~~text
implement #1
  -> validate
  -> review #1
       request_changes
  -> fix #2
  -> validate
  -> review #2
       request_changes
  -> fix #3
  -> validate
  -> review #3
       request_changes -> ESCALATED または FAILED
~~~

`maxFixAttempts` は初回 implement を含まず、その後に許可する fix 回数である。無制限値は認めず、0–10に制限する。

fix prompt は Issue/task/project contract、previous review、previous validation を受け取り、open finding を stable ID ごとに再現・確認して対応する。review の提案を無検証で適用することは求めない。

## 5. Validation evidence

Issue は validation gate ID だけを保持し、実行 command は trusted `.hdo/project.json` が所有する。reviewer は gate ごとの status、exit code、duration、log artifact と aggregate result を受け取る。

status:

- `pass`
- `fail`
- `indeterminate`

required gate の non-pass は approval を禁止する。test 未実行、timeout、setup failure、未知 exit code を成功へ丸めない。

HDO は validation と diff を provider の自己申告に依存せず、自身で取得する。worker が返す `tests` や `changedFiles` は参考情報であり、authoritative evidence は validation artifact と Git diff である。

## 6. Project review policy

`.hdo/project.json` は project-specific な review context を宣言する。

- `defaultViewpoints`
- `highRiskPaths`
- `largeChangeLines`
- `onMissingViewpoint: escalate`
- `stableFindingIds: true`
- mutation policy

HDO は trusted project contract を review prompt に含める。schema の fail-safe rule は全 repository 共通、viewpoint と high-risk area は利用 repository の責任範囲とする。

`mutation.enabled` は将来の mutation runner との契約予約である。MVP の sample は false であり、true にしても HDO core が mutation を生成・投入する機能はまだ提供しない。

## 7. Artifact

各 review iteration は次を保存する。

- review prompt
- harness event/stdout/stderr
- schema validated `final.json`
- semantic validation 後の `result.json`
- 同じ iteration の validation result/log
- complete `diff.patch` と diff metadata

最終 run は final diff と summary を保存する。FAILED / ESCALATED でも、それまでの review/finding/evidence を残す。

artifact は model/provider の conversation state ではなく HDO が所有する。将来別 harness から review を再開するときも、保存 artifact を入力にできる設計を維持する。

## 8. HDO core と review platform の境界

| 項目 | 現在の所有者 |
|---|---|
| Issue pickup / claim | HDO core |
| profile / step runner | HDO core |
| worktree / diff / artifact | HDO core |
| validation gate execution | HDO core + project contract |
| review-result schema | shared schema |
| single review/fix loop | HDO core |
| project viewpoint declaration | project contract |
| multi-review lens orchestration | post-MVP review platform |
| counterargument batch | post-MVP review platform |
| mutation manifest / runner | post-MVP review platform |
| usage/token telemetry | post-MVP review platform |
| Claude Code thin-wrapper plugin（`.claude-plugin/` + `commands/`） | HDO core（実装済み） |
| standalone review-platform plugin packaging | post-MVP review platform |

runner process invocation は共有できるが、role policy は分ける。implement/fix の workspace-write と review の read-only を同じ adapter 設定として混在させない。

## 9. Post-MVP review platform

### Phase R1 — Multi-viewpoint review

- correctness / tests / security 等の独立 lens
- viewpoint ごとの完了・未実施記録
- finding merge と stable-ID ledger
- 同じ reviewer context の単なる再実行を避ける独立性 policy

### Phase R2 — Counterargument

- finding を ID namespace で分割した反証 batch
- evidence に基づく resolved / refuted / waived / indeterminate 更新
- verdict だけでなく訂正字面と推奨 action の検証状態

### Phase R3 — Mutation validation

- versioned mutation manifest
- mutation source の一意性
- baseline green の事前確認
- detection / survived / indeterminate の exit class
- one-writer window と必ず復元する recovery

### Phase R4 — Telemetry / packaging

- usage report schema
- unit / form / launch / subject / size-band の層別
- standalone review-platform plugin と Codex-facing adapter の独立配布（`hdo.ps1` を包む薄い wrapper plugin は実装済み）
- generated schema bundle と version check
- net-equity との並走検証

## 10. 移行条件

net-equity など既存運用を standalone review platform へ切り替える場合、実 PR を従来方式と新方式で並走させる。

最低限比較するもの:

- finding 数と severity
- 実際の product bug
- counterargument 後に残る finding
- mutation の detected / survived / indeterminate
- review/fix iteration と wall-clock
- missing viewpoint / escalation

token 削減率だけで成功を判定しない。quality gate が同等以上であることを確認してから切り替える。

## 11. Acceptance criteria

実装済み MVP:

- review-result の valid fixture が schema を通る。
- empty request_changes、open blocker 付き approve、missing viewpoint 付き non-escalate が拒否される。
- review runner は read-only でなければ configuration validation に失敗する。
- complete diff と validation evidence が review prompt/artifact に含まれる。
- required validation failure中の approve が HDO により拒否される。
- review result が run/base/diff/round へ binding され、previous finding の消失が拒否される。
- request_changes が bounded fix loop へ接続される。
- fix 上限後に自動継続しない。
- 同じ review schema を Codex / Claude / command adapter が利用できる。
- Claude adapter へ渡す schema は strict-mode 向けに正規化した transport copy であり、canonical schema による出力再検証と、Claude CLI が正規化済み schema を受理する契約テスト（`tests/test-claude-contract.ps1`）を持つ。
- `hdo.ps1` を包む薄い Claude Code plugin から各 command を起動できる。

post-MVP であり、現在の acceptance 対象外:

- 複数 reviewer lens の自動 orchestration
- 反証 batch
- mutation generation/execution
- token telemetry report
- standalone review-platform plugin の install/update

## 12. 履歴資料

- net-equity issue #106: review 基盤の切り出しと契約整理
- net-equity issue #107: telemetry 層別定義

外部 Issue comment は背景の追跡に使う。実装判断や CI validation では本 repository の schema/test を優先する。
