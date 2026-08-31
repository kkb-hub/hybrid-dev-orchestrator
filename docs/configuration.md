# HDO Configuration Guide

- 対象: configuration schema version 1
- runtime: `Get-HdoConfig` / `Test-HdoConfiguration`
- schema: `schemas/hdo-config.schema.json`
- 既定値: `config/hdo.default.json`

## 1. 設定の読込順

HDO は JSON object を deep merge し、後の source で同名値を上書きする。

1. HDO checkout の `config/hdo.default.json`
2. `%APPDATA%/hdo/config.json` が存在する場合
3. CLI で明示した `-Config <path>`
4. CLI `-Profile`、または merge 後の `activeProfile`
5. `run -SetStep <step=runner>`

`-Config` は完全置換ではなく overlay である。読込 source と resolved execution plan は次で確認できる。

~~~powershell
pwsh ./hdo.ps1 config -RepositoryPath C:\src\owner\repo -Json
pwsh ./hdo.ps1 config -RepositoryPath C:\src\owner\repo `
  -Config C:\configs\hdo-team.json -Profile cloud-only -Json
~~~

対象 repository の `.hdo/config.json` は **自動読込しない**。runner の `command`、`extraArgs`、environment、provider は code execution authority を持つため、checkout した branch の設定を暗黙適用しないためである。

repository ごとの設定が必要な場合は、内容をレビューしたうえで `-Config` へ明示するか、user config から repository-independent profile を参照する。

一方、対象 repository の `.hdo/project.json` は trusted project contract として自動読込する。validation command を含むため、こちらも実行前にレビューし、base commit へ commit しておく必要がある。

## 2. Root keys

| Key | 内容 |
|---|---|
| `schemaVersion` | 現在は `1` |
| `activeProfile` | CLI で profile を指定しない場合の profile 名 |
| `profiles` | step から runner への routing |
| `runners` | harness/provider/model/process policy |
| `github` | repository、pickup、label、claim、write-back |
| `workflow` | no-diff、validation failure、fix limit の policy |
| `paths` | worktree / artifact root |
| `projectContractPath` | 対象 repository 内の trusted project contract |

bundled config と example は CI の JSON Schema test で検証する。runtime では `Test-HdoConfiguration` が動的な runner 参照、sandbox、timeout、fallback、dangerous argument、credential environment 等を semantic validation する。

## 3. Profile と step routing

profile は4 step を routing する。

~~~json
{
  "activeProfile": "cloud-only",
  "profiles": {
    "cloud-only": {
      "steps": {
        "plan": "cloud-planner",
        "implement": "cloud-implementer",
        "review": "cloud-reviewer",
        "fix": "cloud-implementer"
      }
    }
  }
}
~~~

`implement`、`review`、`fix` は必須である。`plan` だけは設定で無効化できる。

~~~json
{
  "steps": {
    "plan": { "enabled": false },
    "implement": "cloud-implementer",
    "review": "cloud-reviewer",
    "fix": "cloud-implementer"
  }
}
~~~

plan 無効時は、正規化 Issue の goal と acceptance criteria から synthetic task contract を作る。

### 3.1 選択優先順位

run が使う profile/runner は次の順で決まる。

1. CLI `-Profile` があればその profile
2. CLI profile がなく Issue の `Route Hint` または `hdo:route/<profile>` があればその profile
3. merge 済み `activeProfile`
4. `-SetStep step=runner` が該当 step だけを最終上書き

Issue route は、merge 済み configuration の `profiles` に存在しなければ contract error になる。route hint は model ID や provider 名ではなく logical profile 名である。

`-SetStep` は `plan`、`implement`、`review`、`fix` と、すでに定義済みの runner 名だけを受け付ける。override 後も sandbox と必須 step の validation は省略しない。

~~~powershell
pwsh ./hdo.ps1 run -Issue 123 `
  -SetStep implement=codex-ollama-implementer `
  -DryRun -Json
~~~

## 4. Runner

安定した JSON config で使用する主な field:

| Field | 必須 | 内容 |
|---|:---:|---|
| `type` | yes | `codex`, `claude`, `command` |
| `provider` | yes | `cloud`, `ollama`, `lmstudio`, `custom` |
| `command` | yes | executable 名または path。shell command line ではない |
| `model` | local は yes | model ID。cloud で省略すると harness default |
| `reasoningEffort` | no | harness が対応する effort |
| `contextTokens` | no | Codex へ要求する context window。command は `{contextTokens}` token で明示利用 |
| `sandbox` | yes | `read-only` または `workspace-write` |
| `timeoutSeconds` | yes | 1–86400 |
| `passEnvironment` | yes | runner へ明示継承する environment 名 |
| `extraArgs` | yes | executable へ追加する argument array |
| `promptTransport` | command only | `stdin` または `{promptFile}` を使う `file` |
| `allowedTools` | Claude only | Claude CLI へ明示する tool 名の配列 |

### 4.1 Step ごとの権限

- plan / review: `read-only` 必須
- implement / fix: `workspace-write` 必須

権限が逆の runner binding は `Test-HdoConfiguration` が拒否する。

### 4.2 Codex adapter

Codex runner は概ね次を組み立てる。

~~~text
codex exec --ephemeral --json --color never
  --sandbox <sandbox> --cd <worktree>
  [--model <model>]
  [--config model_reasoning_effort="..."]
  [--config model_context_window=...]
  --output-schema <schema>
  --output-last-message <file>
  -
~~~

`provider` が `ollama` または `lmstudio` の場合は `--oss --local-provider <provider>` を加える。prompt は stdin で渡す。

Codex の `contextTokens` は requested value として CLI へ渡し execution plan に残す。command runner は `extraArgs` の `{contextTokens}` token で利用できる。Claude adapter は対応する context-window argument がないため、`contextTokens` を設定すると configuration error になる。MVP の preflight は provider が実際に適用した context 長を照会・保証しないため、provider/CLI が unsupported とした場合は step failure として扱う。

Codex runner は `cloud`、`ollama`、`lmstudio` に対応する。Claude runner は `cloud` のみ、command runner は上記に加えて任意 harness を表す `custom` を選べる。

### 4.3 Claude adapter

Claude runner は print mode、session persistence 無効、JSON Schema output を利用する。read-only は plan permission、workspace-write は edit permission に対応させる。model と effort は設定時だけ明示する。

### 4.4 Command adapter

command runner は既定で prompt を stdin へ渡し、`extraArgs` 内の次の token を argument 単位で展開する。

- `{promptFile}`
- `{outputFile}`
- `{schemaFile}`
- `{workingDirectory}`
- `{model}`
- `{contextTokens}`
- `{step}`
- `{iteration}`
- `{runId}`

shell evaluation は行わない。command adapter の `sandbox` は HDO の routing policy として検査されるが、任意 executable に OS-level sandbox を自動付与するものではない。

### 4.5 Environment と extraArgs

runner と validation process は、known credential および名前が `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` で終わる environment を既定で除外する。

`passEnvironment` は明示的な opt-in である。ただし `GH_TOKEN` / `GITHUB_TOKEN` は runner へ渡せず configuration error になる。ほかの sensitive 名は warning を出す。secret value を config、model ID、argument、artifact path に直接書いてはならない。

次のような sandbox bypass argument は拒否する。

- `--dangerously-bypass-approvals-and-sandbox`
- `--dangerously-skip-permissions`
- `--search`
- `danger-full-access`

runner の `fallback` 配列は許可しない。

## 5. 既定 cloud-only profile

`config/hdo.default.json` は model ID を固定せず、Codex の configured cloud default を使う。

| Step | Runner | Provider | Sandbox | Timeout |
|---|---|---|---|---:|
| plan | `cloud-planner` | cloud | read-only | 900s |
| implement | `cloud-implementer` | cloud | workspace-write | 3600s |
| review | `cloud-reviewer` | cloud | read-only | 1200s |
| fix | `cloud-implementer` | cloud | workspace-write | 3600s |

この profile の doctor は Ollama を probe せず、`provider:ollama` check を `skipped` として返す。

Codex command の存在は preflight するが、cloud account/model の実利用可否は agent step の実行時にも検証される。事前に Codex CLI の authentication/configuration を完了しておく。

## 6. Ollama hybrid profile

`config/examples/ollama-hybrid.json` は明示的に選択する example である。

| Step | Runner | Provider |
|---|---|---|
| plan | `codex-cloud-planner` | cloud |
| implement | `codex-ollama-implementer` | ollama |
| review | `codex-cloud-reviewer` | cloud |
| fix | `codex-ollama-implementer` | ollama |

~~~powershell
pwsh ./hdo.ps1 doctor `
  -Config ./config/examples/ollama-hybrid.json `
  -Profile ollama-hybrid -DryRun
~~~

この profile を選んだときだけ HDO は次を検査する。

1. `ollama` command
2. `ollama list` の成功
3. runner が指定した model の存在

model がなければ導入方法を自動実行せず fail する。Ollama が不調でも cloud runner へ暗黙 fallback しない。

LM Studio は Codex CLI の `--local-provider lmstudio` へ委譲する。MVP の doctor は runner command の存在までは検査するが、LM Studio server/model の専用 probe は行わないため、接続と model の利用可否は step 実行時に fail-closed で判定される。

## 7. GitHub 設定

~~~json
{
  "github": {
    "labels": {
      "ready": "hdo:ready",
      "skip": "hdo:skip",
      "statusPrefix": "hdo:status/",
      "claimed": "hdo:status/claimed",
      "implementing": "hdo:status/implementing",
      "review": "hdo:status/review",
      "changesRequested": "hdo:status/changes-requested",
      "approved": "hdo:status/approved",
      "escalated": "hdo:status/blocked",
      "failed": "hdo:status/failed",
      "cancelled": "hdo:status/cancelled"
    },
    "priorityOrder": [
      "hdo:priority/p0",
      "hdo:priority/p1",
      "hdo:priority/p2",
      "hdo:priority/p3"
    ],
    "writeBack": "status",
    "candidateLimit": 50,
    "assignOnClaim": true,
    "trustedActors": [],
    "claimLeaseHours": 24
  }
}
~~~

| Field | 内容 |
|---|---|
| `repository` | optional `owner/repository`。なければ origin から解決 |
| `labels` | Issue contract と phase write-back の label 名 |
| `priorityOrder` | pickup の優先順位 |
| `writeBack` | `status` または `none` |
| `candidateLimit` | priority で整列した eligible Issue の返却上限、1–1000 |
| `assignOnClaim` | claim 勝者を `@me` へ assign |
| `trustedActors` | ready label/claim marker の actor allowlist |
| `claimLeaseHours` | marker に保存する lease 期限、1–720時間 |

`trustedActors` が空なら、ready label については repository の label permission を trust boundary とする。既存 claim marker は comment author と `claimedBy` が一致し、GitHub の `author_association` が `OWNER`、`MEMBER`、`COLLABORATOR` のいずれかである場合だけ信頼する。allowlist が非空なら、ready label の最新 event actor、現在の authenticated actor、marker comment author と `claimedBy` を allowlist に照合する。

lease は audit/recovery 用に記録する。MVP は期限到達時の自動 takeover を行わない。

CLI `-NoWriteBack` はこの設定より優先し、その run だけ write-back を無効にする。

`labels` command は `config/labels.json` の色・説明を利用しつつ、eligibility/lifecycle label 名は merge 済み `github.labels` へ置換して同期する。さらに `profiles` から `hdo:route/<profile>` を生成する。`statusPrefix` は `hdo:status/` 固定であり、status label はその配下、ready/skip はその外側に置く。label 名の重複は configuration error になる。`-Apply` がない場合は read-only preview である。

## 8. Workflow 設定

~~~json
{
  "workflow": {
    "maxFixAttempts": 2,
    "implicitFallback": false,
    "onNoDiff": "fail",
    "onValidationFailure": "request-changes",
    "onMaxFixAttempts": "escalate"
  }
}
~~~

| Field | 値 / 意味 |
|---|---|
| `maxFixAttempts` | 0–10。初回 implement 後の fix 実行上限 |
| `implicitFallback` | 必ず `false` |
| `onNoDiff` | `fail` / `escalate` |
| `onValidationFailure` | `request-changes` / `escalate` / `fail` |
| `onMaxFixAttempts` | `escalate` / `fail` |

既定の `maxFixAttempts: 2` は最大3 iteration、すなわち initial implement 1回と fix 2回である。

validation は設定で順序変更できず、常に implement/fix の後、review の前に実行する。

`request-changes` policy では validation result を reviewer へ渡す。required gate が不合格のまま approve が返っても、HDO は decision を request_changes へ変更し blocker finding を付ける。

## 9. Paths

~~~json
{
  "paths": {
    "worktreeRoot": "%LOCALAPPDATA%/hdo/worktrees",
    "artifactRoot": "%LOCALAPPDATA%/hdo/runs"
  },
  "projectContractPath": ".hdo/project.json"
}
~~~

- Windows environment variable を展開する。
- `{repository}` token があれば local repository path に置換する。
- relative path は `-RepositoryPath` で解決した repository root 基準にする。
- project contract は repository root 内でなければならない。
- run directory は各 root 直下の run ID で決まる。

artifact/worktree root の書込 probe は通常 doctor/full run で行う。`doctor -DryRun` は directory/file を作らず path probe を skip する。

## 10. Project contract

既定 path は `.hdo/project.json`、schema は `schemas/project-contract.schema.json` である。

~~~json
{
  "schemaVersion": 1,
  "instructions": {
    "files": ["AGENTS.md"],
    "specificationPaths": ["docs/requirements.md"]
  },
  "validationGates": [
    {
      "id": "tests",
      "description": "Run the repository test suite.",
      "command": "pwsh",
      "args": ["-NoProfile", "-File", "tests/test-suite.ps1"],
      "workingDirectory": ".",
      "required": true,
      "timeoutSeconds": 300,
      "exitCodes": {
        "passed": [0],
        "failed": [1],
        "indeterminate": [2, 124, 125, 126, 127]
      },
      "continueAfterFailure": true
    }
  ],
  "workerPolicy": {
    "networkAccess": "denied",
    "oneWriterPerWorktree": true,
    "allowCommit": false,
    "allowPush": false,
    "forbiddenCommands": ["git commit", "git push"],
    "protectedPaths": [".git"]
  },
  "reviewPolicy": {
    "defaultViewpoints": ["correctness", "tests", "security"],
    "highRiskPaths": [],
    "largeChangeLines": 500,
    "onMissingViewpoint": "escalate",
    "stableFindingIds": true,
    "mutation": {
      "enabled": false,
      "oneWriterWindow": true,
      "indeterminateIsSuccess": false
    }
  }
}
~~~

### 10.1 Validation gate

- Issue は ID だけを指定する。
- ID は project contract 内で case-insensitive に一意でなければならない。
- `command` は executable、`args` は argument array である。
- `workingDirectory` は worktree 内の既存 directory に限り、途中または終端の junction/symbolic link を拒否する。
- `{worktree}` token を argument 内で展開できる。
- unlisted exit code と timeout は indeterminate とする。
- required gate の non-pass は review approval を阻止する。
- gate は observational でなければならず、tracked/untracked を問わず worktree を変更すると run は失敗する。

MVP validator は Issue が選んだ gate を順に実行し、各 gate の log と集計を保存する。project contract の変更は対象 base commit に含める。

### 10.2 Worker/review policy の強制範囲

project contract 全体は plan/implement/fix の task context に含まれる。schema、HDO prompt、runner sandbox、worktree isolation、credential filtering が一部を構造的に補強する。

ただし arbitrary command adapter に対して `networkAccess`、`forbiddenCommands`、`protectedPaths` を OS-level に intercept する policy engine は MVP に含まれない。必要な強制は runner 自身の sandbox、Windows policy、firewall 等でも構成する。

structured review の fail-safe rule は `schemas/review-result.schema.json` と runtime semantic validation が正典である。mutation engine と project-specific multi-review lens の実行は post-MVP である。

## 11. User config の例

`%APPDATA%/hdo/config.json` は partial overlay にできる。

~~~json
{
  "activeProfile": "cloud-only",
  "paths": {
    "worktreeRoot": "D:/hdo/worktrees",
    "artifactRoot": "D:/hdo/runs"
  },
  "workflow": {
    "maxFixAttempts": 1
  },
  "github": {
    "trustedActors": ["maintainer-login"]
  }
}
~~~

secret は user config にも保存しない。runner が authentication を必要とする場合は harness 自身の credential store を優先する。

## 12. Configuration troubleshooting

| 症状 | 確認箇所 |
|---|---|
| profile がない | `config -Json` の `sources` と `profile` |
| runner が undefined | profile の step 名と `runners` key |
| review/plan sandbox error | runner を `read-only` にする |
| implement/fix sandbox error | runner を `workspace-write` にする |
| route hint error | Issue の route 名が merge 済み `profiles` に存在するか |
| Ollama が突然必要 | active execution plan に `provider: ollama` がないか |
| model missing | `ollama list` と runner.model。HDO は pull しない |
| gate unknown | Issue の Validation Gate IDs と `.hdo/project.json` |
| GitHub actor rejected | `github.trustedActors` と ready label event / `gh api user` |
| write-back を止めたい | run に `-NoWriteBack`、または `github.writeBack: none` |
