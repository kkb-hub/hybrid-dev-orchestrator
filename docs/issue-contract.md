# GitHub Issue 契約

- 契約 version: 1
- Issue Form: `.github/ISSUE_TEMPLATE/hdo-task.yml`
- 正規化 schema: `schemas/issue-contract.schema.json`
- label catalog: `config/labels.json`

## 1. 役割と trust boundary

GitHub Issue は HDO の task input であり、実行 policy や shell command の定義元ではない。title、body、comment、添付、外部 link はすべて untrusted input として扱う。

Issue が指定できる validation 情報は `.hdo/project.json` に存在する gate ID だけである。Issue 本文に書かれた command、provider、model、権限変更、secret 取得指示は実行しない。runner 設定と project contract は Issue より常に優先する。

run state の正典は repository 外の `run.json` と `events.jsonl` である。Issue label と managed comment はその projection であり、HDO は Issue close、commit、push、PR 作成、merge を行わない。

## 2. Issue Form field

GitHub API は Issue Form の回答を Markdown heading と本文へ変換する。normalizer は次の canonical heading を読む。

| Heading / Form ID | 必須 | 正規化先 | 規則 |
|---|:---:|---|---|
| `Problem / Context` / `problem-context` | yes | `context` | 空白不可 |
| `Goal` / `goal` | yes | `goal` | 空白不可 |
| `Acceptance Criteria` / `acceptance-criteria` | yes | `acceptanceCriteria[]` | 1行1件、ID は重複不可 |
| `In Scope` / `in-scope` | yes | `scope.include[]` | 1行1件 |
| `Out of Scope` / `out-of-scope` | no | `scope.exclude[]` | 1行1件 |
| `Constraints / Security Considerations` / `constraints` | no | `constraints[]` | command authority にはならない |
| `Dependencies` / `dependencies` | no | `dependencies[]` | `#123` または `owner/repo#123` |
| `Validation Gate IDs` / `validation-gate-ids` | yes | `validationGates[]` | trusted project contract の ID のみ |
| `Affected Areas` / `affected-areas` | no | `affectedAreas[]` | 1行1件 |
| `Priority` / `priority` | yes | `priority` | `p0`–`p3` |
| `Risk` / `risk` | yes | `risk` | `low`, `medium`, `high`, `critical` |
| `Route Hint` / `route-hint` | no | `preferredExecution` | logical profile 名だけ |
| `Additional Context` / `additional-context` | no | `additionalContext` | untrusted reference |
| `Input Policy` / `policy-acknowledgements` | UI only | なし | trust level は変えない |

Markdown bullet と checkbox marker は除去する。通常の textarea に箇条書き記号がない場合も、空でない各行を1項目として扱う。GitHub が空欄へ出力する `_No response_`、`No response`、`なし`、`N/A` は空値へ正規化する。

Acceptance Criteria は `AC-01: text` のような ID を推奨する。ID がない行には出現順で `AC-1`, `AC-2`, ... を割り当てる。正規化後の ID は `AC-` で始まり、大文字英数字と `.`, `_`, `-` だけを許可する。

gate ID と route hint は小文字英数字から始まり、小文字英数字と `.`, `_`, `-` だけを許可する。

## 3. 正規化 object

`ConvertTo-HdoIssueContract` は次を保持する。

- `schemaVersion: 1`
- `issue`: repository、number、URL、updatedAt、title、state、label snapshot、body SHA-256
- `goal`, `context`
- `scope.include[]`, `scope.exclude[]`
- ID 付き `acceptanceCriteria[]`
- `validationGates[]`
- `constraints[]`, `dependencies[]`, `affectedAreas[]`
- `additionalContext`
- `priority`, `risk`, `preferredExecution`
- `capturedAt`

構造は runtime でも JSON Schema 検証し、label cardinality、configured profile、known gate、ready/skip/status 等は追加の semantic validation を行う。

## 4. Priority、risk、route の解決

本文値より予約 label を優先する。

- priority: `hdo:priority/p0`–`p3`
- risk: `hdo:risk/low|medium|high|critical`
- route: `hdo:route/<profile>`

各 axis は zero-or-one である。複数 label がある場合は選択せず contract error にする。route suffix は merge 済み configuration の profile 名でなければならない。route は provider/model ID や fallback 許可ではなく、logical profile の選択 hint である。

## 5. Label catalog

HDO が管理する予約 namespace は `hdo:` である。

以下は既定 label 名である。`github.labels` で eligibility/lifecycle の個別名は変更できるが、`statusPrefix` は `hdo:status/` 固定、lifecycle はその配下、ready/skip はその外側かつ priority/risk/route namespace 外でなければならない。fixed priority/risk と generated route を含む managed label 名の衝突は configuration error になる。

Eligibility:

- `hdo:ready`: maintainer が実行可能と判断した候補
- `hdo:skip`: pickup 対象外

Lifecycle status（常に zero-or-one）:

- `hdo:status/claimed`
- `hdo:status/implementing`
- `hdo:status/review`
- `hdo:status/changes-requested`
- `hdo:status/approved`
- `hdo:status/blocked`
- `hdo:status/failed`
- `hdo:status/cancelled`

configured ready label は status label と共存できない。claim 時に ready を除去し claimed へ遷移する。HDO は catalog 内の label だけを作成・更新し、`bug`、team、milestone 等の repository 固有 label は変更しない。

Issue Form は ready label を自動付与しない。`labels -Apply` は configured eligibility/lifecycle、fixed priority/risk、configured profile に対応する route label を同期する。

## 6. Eligibility と dependency

明示 `-Issue` と自動 `-Pick` はどちらも次を要求する。

1. Issue が open。
2. `hdo:ready` があり、`hdo:skip` と lifecycle status がない。
3. Issue contract の schema/semantic validation が成功。
4. ready actor policy が成功。
5. 全 gate ID が `.hdo/project.json` に存在。
6. 全 dependency が GitHub API で確認でき、state が `CLOSED`。
7. trusted active claim marker がない。

dependency の取得失敗や未知 state は解決済みに丸めず、unresolved として停止する。`-NoWriteBack` でも dependency と active claim の読み取り検査は省略しない。

HDO は paginated Issue event から最新の ready label event を取り、Issue の `updatedAt` が event 時刻より後なら再レビューと ready の再付与を要求する。`github.trustedActors` が空の場合、ready label を付けられる repository permission を authorization boundary とする。allowlist がある場合は event actor も allowlist と照合する。GitHub timestamp は秒精度のため、同一秒内の更新順までは識別できない既知の制約がある。

## 7. 自動 pickup

`-Pick` と `issues` は ready Issue を取得し、eligibility を通った候補を次の順で決定的に並べる。

1. `github.priorityOrder` の順
2. `createdAt` の古い順
3. Issue number の小さい順

API の返却順や LLM の判断には依存しない。GitHub CLI から最大1000件の ready Issue を取得して eligibility を検査・整列し、その後に `candidateLimit` を返却上限として適用する。

## 8. Claim marker

GitHub comment/label は atomic lock ではないため、write-back 有効時は worktree 作成前に optimistic claim を行う。

~~~text
<!-- hdo:claim:v1 {"version":1,"kind":"claim","runId":"issue-123-...","issueKey":"owner/repo#123","claimedBy":"login","claimedAt":"<RFC3339>","leaseExpiresAt":"<RFC3339>","state":"active"} -->
~~~

HDO は comment author と `claimedBy` の一致、issueKey、timestamp、state、run ID を検証する。`trustedActors` があれば author を allowlist と照合する。空の場合は GitHub の `author_association` が `OWNER`, `MEMBER`, `COLLABORATOR` の comment だけを claim として認める。

comments は pagination して取得する。同時に複数の valid active marker が作られた場合、GitHub comment ID が最小の marker を勝者とし、敗者は自身の marker を `released` へ更新して停止する。status label 更新に失敗した場合も自身の marker を best-effort で release する。

`claimLeaseHours` は recovery 用の期限を marker に記録するが、MVP は期限切れ claim の自動 takeover や削除を行わない。Human が原因を確認してから復旧する。

`assignOnClaim` の assignee 更新は claim 後の補助動作であり、失敗は run warning に記録して実装 cycle 自体は継続する。

## 9. Write-back

`github.writeBack: status` の run は同じ managed comment を最終状態へ更新し、対応する lifecycle label を設定する。model summary は credential pattern、mention、追加 marker を無害化し、長さを制限してから comment へ含める。

`github.writeBack: none` または CLI `-NoWriteBack` は Issue/comment/label/assignee を変更しない。どちらも GitHub の読み取り、contract、dependency、claim conflict の検査は行う。

APPROVED は `hdo:status/approved` を意味するだけで、Issue の close や成果物の適用を意味しない。Human は run artifact、validation、diff を確認し、その後の commit/PR を別の操作として行う。
