# HDO Configuration Guide

- 対象: configuration schema version 1
- runtime: `Get-HdoConfig` / `Test-HdoConfiguration`
- schema: `schemas/hdo-config.schema.json`
- 既定値: `config/hdo.default.json`

## 1. 設定の読込順

HDO は JSON object を deep merge し、後の source で同名値を上書きする。

1. HDO checkout の `config/hdo.default.json`
2. `%APPDATA%/hdo/config.json` が存在する場合
3. 対象 repository の `HEAD:.hdo/config.json` が存在する場合
4. CLI で明示した1個以上の `-Config <path>`（左から右、後勝ち）
5. programmatic override
6. CLI `-Profile`、または Issue route / merge 後の `activeProfile`
7. `run -SetStep <step=runner>`

`-Config` は完全置換ではなく overlay である。読込 source と resolved execution plan は次で確認できる。

~~~powershell
pwsh ./hdo.ps1 config -RepositoryPath C:\src\owner\repo -Json
pwsh ./hdo.ps1 config -RepositoryPath C:\src\owner\repo `
  -Config C:\configs\hdo-team.json -Profile cloud-only -Json
pwsh ./hdo.ps1 config -RepositoryPath C:\src\owner\repo `
  -Config ./.hdo/base.json,./.hdo/local.json -Json
~~~

`-Config` は `-Config first.json,second.json` の comma-separated list、または PowerShell API の string array として複数指定できる。relative path は対象 repository root 基準で解決し、後の file が前の file を上書きする。path 自体に comma は使用できない。

### 1.1 Repository config の自動読込

`.hdo/config.json` が対象 repository の `HEAD` に commit されていれば、通常の `config`、`doctor`、`run` で自動読込する。working tree の未 commit file は実行権限を取得できず、次の扱いになる。

- `HEAD` に file がなく working tree にだけある場合は、commit を要求して fail closed にする。
- `HEAD` に file があり working tree で変更されている場合は、working tree の内容ではなく `HEAD` の blob を読む。
- worktree 作成後に同じ blob と SHA-256 を再確認し、解決時の snapshot と異なれば runner を起動せず停止する。
- `config -Json` の `repositoryConfig` に commit、blob、SHA-256、読込/無視状態を出す。

自動読込には `schemas/hdo-repository-config.schema.json` の制限付き schema を使う。repository が指定できるのは profile/step routing と、built-in `codex` / `claude` runner の provider、model、reasoning、context、sandbox、timeout だけである。新規 runner の実行 command は type に応じて HDO が `codex` または `claude` に固定する。

自動読込では次を指定できない。

- `command` runner、任意 executable、`command`、`extraArgs`、`passEnvironment`
- GitHub write-back、workflow/fallback、artifact/worktree path、project contract path
- 既存 command runner の変更や、それを repository profile から選択する routing

その run だけ自動読込を無効にする場合は `-IgnoreRepositoryConfig` を使う。別名設定や一時 override が必要な場合は `-Config` を併用でき、明示 file は自動設定より後に merge される。明示 `-Config` は利用者が指定した trusted input として通常の full config schema を受け付ける。

~~~powershell
pwsh ./hdo.ps1 run -Issue 123 -IgnoreRepositoryConfig `
  -Config ./.hdo/alternate.json
~~~

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
  "activeProfile": "claude-only",
  "profiles": {
    "claude-only": {
      "steps": {
        "plan": "claude-planner",
        "implement": "claude-implementer",
        "review": "claude-reviewer",
        "fix": "claude-implementer"
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
    "implement": "claude-implementer",
    "review": "claude-reviewer",
    "fix": "claude-implementer"
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
  -SetStep implement=claude-ollama-implementer `
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
| `reasoningEffort` | no | harness が対応する effort。Claude cloud は `low`/`medium`/`high`/`xhigh`/`max` のみ、Claude/Ollama routeでは指定不可 |
| `contextTokens` | no | Codex、または Claude/Ollama runner へ要求する context window（1024–1048576）。Claude cloud では configuration error。command は `{contextTokens}` token で明示利用 |
| `sandbox` | yes | `read-only` または `workspace-write` |
| `timeoutSeconds` | yes | 1–86400 |
| `passEnvironment` | yes | runner へ明示継承する environment 名 |
| `extraArgs` | yes | executable へ追加する argument array。Claude runner は空配列必須（adapter が argument surface を専有） |
| `promptTransport` | command only | `stdin` または `{promptFile}` を使う `file` |
| `allowedTools` | Claude only | Claude CLI の `--allowedTools` permission allowlist へ渡す tool 名の配列 |

### 4.1 Step ごとの権限

- plan / review: `read-only` 必須
- implement / fix: `workspace-write` 必須

権限が逆の runner binding は `Test-HdoConfiguration` が拒否する。

### 4.2 Codex adapter

Codex runner は概ね次を組み立てる。

~~~text
codex exec --ephemeral --ignore-user-config --ignore-rules --json --color never
  --sandbox <sandbox> --cd <worktree>
  [--model <model>]
  [--config model_reasoning_effort="..."]
  [--config model_context_window=...]
  --output-schema <schema>
  --output-last-message <file>
  -
~~~

`provider` が `ollama` または `lmstudio` の場合は `--oss --local-provider <provider>` を加える。prompt は stdin で渡す。

HDO が model、provider、sandbox、schema を含む実行契約を組み立てるため、個人の `config.toml` と execpolicy rules は読み込まない。Codex 組み込みおよび repository の instruction は引き続き読み込まれる。

Codex の `contextTokens` は requested value として CLI へ渡し execution plan に残す。command runner は `extraArgs` の `{contextTokens}` token で利用できる。Claude adapter には context-window argument も、Ollama の Anthropic-compatible endpoint 向けの per-request override もないため、cloud runner で `contextTokens` を設定すると configuration error になる。Claude/Ollama runner（4.3 参照）では別経路（derived local model）で強制するため設定できる。

Codex runner は `cloud`、`ollama`、`lmstudio` に対応する。Claude runner は `cloud` と `ollama`、command runner は上記に加えて任意 harness を表す `custom` を選べる。現在の Ollama hybrid example は、Qwen 3.8 が Codex CLI 0.152.1 の local tool 名を互換形式で返さないため、Claude CLI を local tool harness として使用する。

### 4.3 Claude adapter

Claude runner は概ね次を組み立てる。

~~~text
claude -p --output-format json --no-session-persistence --safe-mode
  --permission-mode <plan|acceptEdits>
  [--json-schema <normalized schema JSON>]
  [--model <model>]
  [--effort <low|medium|high|xhigh|max>]
  [--allowedTools <name,name,...>]
~~~

prompt は stdin で渡す。stdout の result envelope（単一 JSON object）は `envelope.json` として保存し、`structured_output`（なければ `result`）を final JSON として取り出したうえで、正規の schema で再検証する。Ollama routeではCLIのSDKが任意model IDを拒否する `--json-schema` を使わず、正規化したtransport schemaをpromptへ付加する。

- **schema の正規化**: Claude CLI は `--json-schema` を Ajv strict mode で検証するため、adapter は CLI へ渡す直前に transport copy だけを正規化する（`$schema` 宣言の除去、既定値どおりの `minContains: 1` の除去、array keyword を持つ subschema への `type: "array"` 補完、document root の `oneOf`/`allOf`/`anyOf` の除去）。`schemas/*.schema.json` が唯一の編集元であることは変わらず、step 出力は元の厳密な schema で再検証するため、検証強度は落ちない。
- **API 側のトップレベル制約**: Ajv strict mode（CLI 内）とは別に、Anthropic API 自体が `tools[].custom.input_schema` の document root に `oneOf` / `anyOf` / `allOf` を置くことを許可しない（`400: input_schema does not support oneOf, allOf, or anyOf at the top level`）。CLI の Ajv 検証はこの制約を検査しないため通ってしまい、review step 開始直後の API 呼び出しで初めて失敗する。`$defs` などネストした位置の合成 keyword は対象外。adapter は正規化の一環として document root のみからこれらを除去する（`review-result.schema.json` の root `allOf` が該当。`$defs.finding.allOf` はネストのため対象外で保持される）。
- **`--safe-mode`**: 利用者の CLAUDE.md、plugin、hook、MCP server、skill を HDO の agent run へ持ち込まないための固定 flag である。再現性と、untrusted な Issue input に対する安全性の両方を目的とする。
- **sandbox の意味**: `read-only` は `--permission-mode plan`、`workspace-write` は `--permission-mode acceptEdits` に対応する。これは Claude Code の permission mode であって OS-level sandbox ではない。`acceptEdits` の runner に対して worktree 外への書込や network access を OS が阻止するわけではない点は command adapter と同じであり（Codex の `workspace-write` とは保証が等価でない）、必要に応じて low-privilege account、VM/container、firewall 等の host policy を併用する。なお `acceptEdits` は `allowedTools` 未設定でも Bash 等のコマンド実行を許可し、`plan` は書込・実行をブロックする（claude 2.1.250 で実測）。つまり既定 profile の implementer/fixer は build・test を実行できる。
- **extraArgs**: Claude runner では使用できず configuration error になる。`--safe-mode` や `--permission-mode` などの隔離保証を per-run に迂回できないよう、adapter が claude の argument surface 全体を専有する。独自の argument 構成が必要な場合は `command` runner を使う。
- **`reasoningEffort`**: Claude CLI の `--effort` は `low`、`medium`、`high`、`xhigh`、`max` のみを受け付け、他の値は警告だけを出して既定値で続行する。HDO はこの silent degradation を防ぐため、Claude cloud runner にそれ以外の値を設定すると configuration error にする。Ollama model IDではCLI側のcloud catalog検証に失敗するため、Claude/Ollama runnerでは指定自体を拒否する。
- **`allowedTools`**: permission allowlist（`--allowedTools`）として渡す。利用可能な組み込み tool 集合の限定（`--tools`）ではない。
- **認証**: HDO は runner process から `ANTHROPIC_API_KEY` と、名前が `TOKEN` / `SECRET` / `PASSWORD` / `API_KEY` で終わる環境変数（`CLAUDE_CODE_OAUTH_TOKEN` を含む）を既定で除外する。`claude` の OAuth login（`~/.claude` の credential store）はそのまま動作する。環境変数で認証する場合は、当該 runner の `passEnvironment` へ `ANTHROPIC_API_KEY` または `CLAUDE_CODE_OAUTH_TOKEN` を明示追加する（sensitive 名として warning が出る）。
- **Ollama route**: `provider: ollama` では adapter が `ANTHROPIC_BASE_URL` を loopback の `http://127.0.0.1:11434` に固定し、非secretの local token、空の API key、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を設定する。Anthropic endpoint、OAuth login、Claude 利用枠は使用しない。repository config から endpoint や環境変数を差し替えることはできない。
- **Ollama tool boundary**: local worker には `Read` / `Write` / `Edit` / `Glob` / `Grep`（read-only runner は読み取り3種）だけを `--tools` で公開する。shell、git、npm、validation gate は worker に実行させず、trusted project contract を持つ HDO 本体が実行する。これにより、local model が plan 中の検査手順を反復して unattended permission denial と token 消費を起こす経路を閉じる。
- **失敗 envelope**: Claude が非ゼロ終了しても stdout の JSON envelope を解析し、`result`、`terminal_reason`、permission denial を一次診断として保持する。stderr は二次情報として併記し、model warning が実際の API error を覆い隠さないようにする。
- **`contextTokens`（Ollama route のみ）**: cloud runner では configuration error になる。Ollama は `ollama ps` の `CONTEXT` 列が示す実行時 context window をモデル読み込み時に決めており、これはモデルの advertised 最大値よりずっと小さいことが多い（環境依存で 2048〜32768 程度）。しかも Claude CLI にも Ollama の Anthropic-compatible endpoint にもこれをリクエスト単位で上げる方法がない。小さい疎通確認では成功し、実サイズの repository file を読む実タスクで初めてこの上限を超えて `no user query found in messages` のような不可解な 500 として失敗する（境界を超えた瞬間に会話の先頭が暗黙に落ちるとみられる）。これを避けるため、`contextTokens` を設定した claude+ollama runner では、agent step の直前（および `doctor` の preflight）で HDO が `FROM <model>` / `PARAMETER num_ctx <contextTokens>` の Modelfile から `ollama create hdo-ctx-<model>-<contextTokens>` を実行して派生モデルを作り、`--model` にはそちらを渡す。`ollama create` はモデルの manifest を書くだけで重みを複製もロードもしない軽量操作なので、毎 run 実行しても実用上のコストは小さい。`ollama create` 自体が失敗した場合（Modelfile の構文エラーや base model 不在など）は ollama の stderr を含めて fail-closed する。ただし `ollama create` は num_ctx がハードウェアやモデルの実際の上限を超えていても manifest 作成自体は成功しうるため、それを超える `contextTokens` を要求した場合の失敗は実際の推論（agent step の実行時）まで顕在化しないことがある。requested output の `model` は引き続き設定ファイル上のモデル名を報告し、派生モデル名は内部の transport 詳細として `stderr.log` からのみ確認できる。
- **npm shim の制約**: `--json-schema` はファイルパスを受け付けないため（実測）、正規化した schema JSON を inline argument として渡す。`claude` が npm install の `.cmd` shim に解決される環境では、cmd.exe の argument 再解釈と 8191 文字上限がこの inline JSON を壊し得る。doctor が shim 解決を warning として報告するので、native install を推奨する。

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

## 5. 既定 claude-only profile

`config/hdo.default.json` は model ID を固定せず、Claude CLI の configured default model を使う。Codex も Ollama もインストールされていない「Claude のみの PC」が既定のサポート対象である。

| Step | Runner | Provider | Sandbox | Timeout |
|---|---|---|---|---:|
| plan | `claude-planner` | cloud | read-only | 900s |
| implement | `claude-implementer` | cloud | workspace-write | 3600s |
| review | `claude-reviewer` | cloud | read-only | 1200s |
| fix | `claude-implementer` | cloud | workspace-write | 3600s |

この profile の doctor は Codex/Ollama を要求せず、`provider:ollama` check を `skipped` として返す。

`claude` command の存在は preflight するが、account/model の実利用可否は agent step の実行時にも検証される。事前に `claude` で login を完了しておくか、4.3 の `passEnvironment` による環境変数認証を設定する。

model を明示したい場合は `config/examples/claude-only.json`（plan/review が `opus`、implement/fix が `sonnet`）を出発点にできる。

### 5.1 Codex cloud profile

Codex を使う一時的な構成は `config/examples/cloud-only.json` を明示的に選択する。repository の既定にする場合は、制限付き repository schema に合わせた file を `.hdo/config.json` として commit する。

~~~powershell
pwsh ./hdo.ps1 doctor `
  -Config ./config/examples/cloud-only.json `
  -Profile cloud-only -DryRun
~~~

Codex CLI の authentication/configuration は事前に完了しておく。

## 6. Ollama hybrid profile

`config/examples/ollama-hybrid.json` は明示 `-Config` 用の full config example、`config/examples/repository-ollama-hybrid.json` は自動読込用の制限付き example である。後者を対象 repository の `.hdo/config.json` として commit すれば、実行時の `-Config` / `-Profile` は不要になる。

| Step | Runner | Provider |
|---|---|---|
| plan | `codex-cloud-planner` | cloud |
| implement | `claude-ollama-implementer` | ollama |
| review | `codex-cloud-reviewer` | cloud |
| fix | `claude-ollama-implementer` | ollama |

~~~powershell
pwsh ./hdo.ps1 doctor `
  -Config ./config/examples/ollama-hybrid.json `
  -Profile ollama-hybrid -DryRun
~~~

repository の既定にする例:

~~~powershell
New-Item -ItemType Directory ./.hdo -Force | Out-Null
Copy-Item ./config/examples/repository-ollama-hybrid.json ./.hdo/config.json
git add .hdo/config.json
git commit -m "Configure HDO Ollama implementation runner"

pwsh ./hdo.ps1 config -Json
pwsh ./hdo.ps1 run -Issue 123
~~~

Ollama route を使う host では、Ollama 0.33.2 以降、tool calling 対応 model、Claude CLI command が必要である。Claude CLI は Ollamaのlocal tool harnessとしてだけ使い、Anthropic認証やClaude利用枠は不要である。HDO は service 起動や model pull を行わないため、事前に次を実行する。

~~~powershell
ollama --version
ollama serve
ollama pull qwen3.8:27b-q4_K_M
ollama list
~~~

`ollama serve` は foreground process なので、すでに service として起動している場合は重ねて起動しない。

実providerを通常のCIから呼ばない opt-in smoke は次で実行する。隔離した一時Git repositoryを作り、plan/reviewがCodex cloudのまま、implement/fixだけがClaude CLI harness経由のOllamaであることを検査してから、指定modelにファイル作成、byte単位の検証、構造化worker resultの返却まで実行する。`test-results/ollama-smoke-last-result.json` にはrunning heartbeat、process exit、検証結果、終了時刻をatomicに保存するため、親のIPC切断後も結果を判定できる。一時directoryは成功・失敗のどちらでも削除し、raw artifactも必要な調査では明示的に `-KeepArtifacts` を付ける。receiptの保存先は `-ResultPath` で変更できる。

~~~powershell
pwsh -NoProfile -File ./tests/test-ollama-smoke.ps1 -Run
~~~

2026-09-03の実測では Codex CLI 0.152.1 から同modelを直接使うと、Qwenが `shell`、`apply_patch`、MCP-prefixed nameなどCodex routerに未登録のtool名を返し、通常実装を完遂できなかった。一方、Claude CLIをOllama Anthropic-compatible endpointへ向けた場合は、Ollama 0.33.2 と `qwen3.8:27b-q4_K_M` でlocal file editに成功した。このためhybrid exampleとsmokeは後者を採用する。

この profile を選んだときだけ HDO は次を検査する。

1. `ollama` command
2. `ollama list` の成功
3. runner が指定した model の存在
4. （claude+ollama runner が `contextTokens` を設定している場合）4.3 で説明した derived context model を実際に `ollama create` できること

model がなければ導入方法を自動実行せず fail する。Ollama が不調でも cloud runner へ暗黙 fallback しない。

`claude-ollama-implementer` は既定で `contextTokens: 65536` を設定している（Ollama 自身が Claude Code 向けに公開している推奨値）。これを外す、または元のモデルの実行時 context window より小さい値のままにすると、疎通確認レベルの小さいタスクは成功するのに、実サイズの repository file を読む実タスクだけが上記の 500 エラーで失敗する、というこの profile の既知の落とし穴を再び踏む。

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
  "activeProfile": "claude-only",
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
| repository config が読まれない | `.hdo/config.json` が `HEAD` に commit 済みか。`config -Json` の `repositoryConfig` |
| 別の repository config を使いたい | `-Config ./.hdo/alternate.json`。複数なら comma 区切り、後勝ち |
| runner が undefined | profile の step 名と `runners` key |
| review/plan sandbox error | runner を `read-only` にする |
| implement/fix sandbox error | runner を `workspace-write` にする |
| route hint error | Issue の route 名が merge 済み `profiles` に存在するか |
| Claude effort error | Claude runner の `reasoningEffort` を `low`/`medium`/`high`/`xhigh`/`max` にする |
| Claude extraArgs error | Claude runner の `extraArgs` を空にする。独自 argument が必要なら `command` runner |
| Claude 認証 error | `claude` の login 状態。環境変数認証なら `passEnvironment` に認証変数を追加したか |
| Claude step で schema/JSON error | doctor の `runner:*:shim` warning。npm の `.cmd` shim ではなく native claude install を使う |
| Ollama が突然必要 | active execution plan に `provider: ollama` がないか |
| model missing | `ollama list` と runner.model。HDO は pull しない |
| gate unknown | Issue の Validation Gate IDs と `.hdo/project.json` |
| GitHub actor rejected | `github.trustedActors` と ready label event / `gh api user` |
| write-back を止めたい | run に `-NoWriteBack`、または `github.writeBack: none` |
