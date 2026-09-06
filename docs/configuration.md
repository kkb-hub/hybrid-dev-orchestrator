# HDO Configuration Guide

- 対象: configuration schema version 1
- runtime: `Get-HdoConfig` / `Test-HdoConfiguration`
- schema: `schemas/hdo-config.schema.json`
- 既定値: `config/hdo.default.json`

## 1. 設定の読込順

HDO は JSON object を deep merge し、後の source で同名値を上書きする。

1. HDO checkout の `config/hdo.default.json`
2. `%APPDATA%/hdo/config.json` が存在する場合（`APPDATA` が未定義の環境では .NET の ApplicationData 既知フォルダーへ fallback する。Linux では `$XDG_CONFIG_HOME/hdo/config.json`、既定 `~/.config/hdo/config.json`）
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
| `contextTokens` | no | Codex、または Claude/Ollama runner へ要求する context window（1024–1048576）。Claude/Ollama では派生モデルの `num_ctx` と CLI の compaction 基準の両方になり、下限は 57344（4.3 参照）。Claude cloud では configuration error。command は `{contextTokens}` token で明示利用 |
| `sandbox` | yes | `read-only` または `workspace-write` |
| `timeoutSeconds` | yes | 1–86400 |
| `passEnvironment` | yes | runner へ明示継承する environment 名 |
| `extraArgs` | yes | executable へ追加する argument array。Claude runner は空配列必須（adapter が argument surface を専有） |
| `promptTransport` | command only | `stdin` または `{promptFile}` を使う `file` |
| `allowedTools` | Claude only | Claude CLI の `--allowedTools` permission allowlist へ渡す tool 名の配列 |

`command` の解決は Application-type の実行ファイル（`.exe`/`.com`/`.cmd`/`.bat`）に限る。`.ps1` shim は選択されない（Issue #35）。npm グローバル install のように同名の `.ps1` と `.cmd` shim が両方存在するレイアウトでは `.cmd` 側が解決される。Claude runner が `.cmd`/`.bat` shim に解決された場合、`doctor` は `runner:<name>:shim` warning を返す（Windows では TypeScript ランタイムが `cmd.exe` の quote parity を追跡して安全に argument を渡すため、この review step は実際には壊れない。PowerShell 実装は依然として同じ入力を壊れた形で渡しうるため warning 自体は両実装向けに残している。4.3 の「npm shim の制約」も参照）。

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

transport schema の正規化は、OpenAI Structured Outputs が document root は元より **ネストした位置を含むあらゆる深さで** `oneOf` を受け付けないため（Anthropic API がトップレベルの `oneOf`/`allOf`/`anyOf` だけを拒否するのと異なる制約）、`allOf` と同じ扱いで `oneOf` を除去する（Issue #22）。`anyOf` は対象外で、除去せず残す。

Codex の `contextTokens` は requested value として CLI へ渡し execution plan に残す。command runner は `extraArgs` の `{contextTokens}` token で利用できる。Claude adapter には context-window argument も、Ollama の Anthropic-compatible endpoint 向けの per-request override もないため、cloud runner で `contextTokens` を設定すると configuration error になる。Claude/Ollama runner（4.3 参照）では別経路（derived local model の `num_ctx` と CLI 側の compaction 基準）で強制するため設定できる。

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
- **`contextTokens`（Ollama route のみ）**: cloud runner では configuration error になる。Ollama route では **上限と、その上限に収める仕組みの両方**を意味し、HDO は 1 つの値から 2 つの lever を導出する。

  この route が壊れやすいのは、上限を決める側と会話量を決める側が別々で、どちらも既定値のままでは噛み合わないため:

  - **Ollama 側（上限）**: モデル読み込み時に決まる実行時 context window（`ollama ps` の `CONTEXT` 列）は、モデルの advertised 最大値よりずっと小さいことが多い（環境依存で 2048〜32768 程度）。リクエスト単位で上げる方法は Claude CLI 側にも Ollama の Anthropic-compatible endpoint 側にも無い。
  - **Claude CLI 側（会話量）**: Claude CLI は Anthropic 自身のモデルの context window しか知らないため、custom base URL 越しの未知の model ID に対しては **200000 tokens と仮定**し、auto-compaction もその値を基準に働く。つまり local model の実際の window がいくつであろうと、CLI 側は 200000 に達するまで会話を伸ばし続ける。

  この 2 つが揃うと、agentic な複数ターンのタスクでは会話履歴がターンごとに単調増加し、CLI が compaction を始めるよりはるか手前で Ollama 側の上限を超える。超えた時点で Ollama は `num_ctx` に収めるため**会話の先頭から切り詰め**、user turn そのものが落ちた prompt を chat template renderer が拒否して、`no user query found in messages` という原因を誤解させる 500 になる。数ターンで終わる疎通確認では両方の境界に届かないため成功し、実タスクだけが失敗する。

  `contextTokens` を設定すると HDO は両側を同時に閉じる:

  1. **上限を上げる**: agent step の直前（および `doctor` の preflight）に `FROM <model>` / `PARAMETER num_ctx <contextTokens>` の Modelfile から `ollama create hdo-ctx-<model>-<hash>-<contextTokens>` で派生モデルを作り、`--model` にはそちらを渡す。`ollama create` は manifest を書くだけで重みを複製もロードもしない軽量操作なので、毎 run 実行しても実用上のコストは小さい。
  2. **上限に収める**: runner 環境へ `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<contextTokens>` を渡し、Claude CLI が 200000 ではなく実際の window を基準に auto-compaction するようにする。ターンを重ねて履歴が伸びていく分はこれで要約され、Ollama 側の切り詰めに到達しなくなる。

  1 だけでは「失敗するまでのターン数が増える」だけで、十分に長いタスクはやはり失敗する。**構造的に効くのは 2 であり、1 はその作業領域を広げる**という関係にある。

  ただし 2 が抑えられるのは**ターンの積み重ねによる増加**だけで、window を単独で超えるような巨大な tool result（大きなファイルの一括読み込みなど）は compaction では追い出せない。この場合 Claude CLI は `compaction cannot help` を記録したうえで送信し、Ollama は黙って切り詰めるため、**エラーではなく「切り詰められた内容に基づく誤った回答」になり得る**。unattended 運用ではこちらのほうが厄介なので、local worker には巨大ファイルの一括読み込みを伴うタスクを渡さない前提で使う。

  **`contextTokens` には実用下限がある（57344）。** Claude CLI は宣言した window から固定の予備枠を先に差し引く: 未知のモデルでは `maxOutputTokens` が 32000 になり、そのうち 20000 が出力用に留保され、さらにその残りの 3000 手前で送信自体を拒否する。つまり実際に prompt へ使えるのは `contextTokens - 23000` しかない。実測（Claude CLI 2.1.250 + Ollama 0.33.2 + `qwen3.8:27b-q4_K_M`、README を 1 ファイル読むだけの些細なタスク）:

  | `contextTokens` | 結果 |
  | --- | --- |
  | 32768 | `terminal_reason: blocking_limit` / `Prompt is too long` |
  | 40960 | 同上 |
  | 49152 | 同上 |
  | 57344 | 成功 |
  | 65536 | 成功 |

  このため HDO は claude+ollama runner の `contextTokens` が 57344 未満なら configuration error にする。`CLAUDE_CODE_MAX_OUTPUT_TOKENS` でこの予備枠を縮められないことも実測で確認済み（未知のモデルでは無視され `maxOutputTokens` は 32000 のまま）。

  なお Ollama の `num_ctx` は prompt と生成の両方を収める必要があるが、CLI が留保するのは 20000 で、報告される `maxOutputTokens` は 32000 である。理論上は prompt 上限 + 生成上限が `num_ctx` を超え得る（未観測）。

  なお Ollama route の context window は runner 定義だけが決める。`Get-HdoSafeEnvironment` は secret 以外の環境変数をそのまま runner process へ渡すため、operator が export した `CLAUDE_CODE_MAX_CONTEXT_TOKENS` は claude+ollama runner では破棄したうえで `contextTokens` から再設定する。cloud runner では破棄しない。HDO は cloud runner の endpoint を固定しないので gateway 経由の未知 model ID という構成があり得るが、cloud では `contextTokens` 自体が configuration error であるため、環境変数以外に window を宣言する手段が無いためである。

  `ollama create` 自体が失敗した場合（Modelfile の構文エラーや base model 不在など）は ollama の stderr を含めて fail-closed する。ただし `ollama create` は num_ctx がハードウェアやモデルの実際の上限を超えていても manifest 作成自体は成功しうるため、それを超える `contextTokens` を要求した場合の失敗は実際の推論（agent step の実行時）まで顕在化しないことがある。`contextTokens` を設定しない claude+ollama runner は上記の落とし穴をそのまま踏むため、doctor が warning を出す。requested output の `model` は引き続き設定ファイル上のモデル名を報告し、派生モデル名は内部の transport 詳細として `stderr.log` からのみ確認できる。なお `no user query found in messages` で失敗した場合、HDO は failure detail に context window 超過である旨の診断を追記する。
- **npm shim の制約**: `--json-schema` はファイルパスを受け付けないため（実測）、正規化した schema JSON を inline argument として渡す。`claude` が npm install の `.cmd` shim に解決される環境では、この inline JSON は cmd.exe を経由して子プロセスへ渡る。TypeScript ランタイムは `buildCmdShimCommandLine`（`src/core/process/cmdShim.ts`）が cmd.exe の quote parity を行全体で累積追跡し、review step の `--json-schema` を含む review-result transport schema（`"pattern": "^[a-f0-9]{40}..."` を含む）についても実機検証済みで、review step は npm の `.cmd` claude install 上でも正しく動作する（8191 文字上限は依然として有効な上限であり、それを超える場合のみ spawn 前に throw する）。PowerShell 実装（`.NET Process.Start` 経由）は同じ入力を保護なしで渡すため、この inline JSON を silently 壊す（例: schema の `^` anchor が消える）。doctor は依然として `runner:*:shim` warning を返す（PowerShell 実装向けの注意喚起として、および 8191 文字上限自体は両実装に共通するため）。

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
- `{hdoRoot}`

shell evaluation は行わない。command adapter の `sandbox` は HDO の routing policy として検査されるが、任意 executable に OS-level sandbox を自動付与するものではない。

`{hdoRoot}` は HDO 自身の install 先を指す。command runner の process working directory は対象 repository の worktree なので、HDO と一緒に配布される worker（6.1 参照）は相対パスでは指せず、この token が無いとマシンごとに異なる絶対パスを config へ直書きする必要がある。

repository config は command runner を定義・変更・選択できない（3.1 参照）。command runner を選べるのは explicit / user configuration だけであり、任意 executable を起動する経路は operator の明示的な選択に限定されている。

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
5. （claude+ollama runner が `contextTokens` を設定していない場合）長い run で確実に失敗する構成である旨の warning

model がなければ導入方法を自動実行せず fail する。Ollama が不調でも cloud runner へ暗黙 fallback しない。

`claude-ollama-implementer` は既定で `contextTokens: 65536` を設定している（Ollama 自身が Claude Code 向けに公開している推奨値）。これを外すと、疎通確認レベルの小さいタスクは成功するのに実タスクだけが 4.3 の 500 エラーで失敗する、というこの profile の既知の落とし穴を再び踏む。

この値は VRAM とのトレードオフになるが、**この profile では下げて妥協するという選択肢が無い**。`num_ctx` を上げるほど KV cache が VRAM を占め、モデル本体が GPU に載りきらなくなった時点で推論速度が大きく落ちる（実測例: RTX 4090 + `qwen3.8:27b-q4_K_M` では 32768 を超えると顕著に遅くなる）。しかし 4.3 の実測表のとおり、`contextTokens` を 57344 未満に下げると Claude CLI の予備枠だけで prompt 領域が尽き、些細なタスクすら `Prompt is too long` で失敗する（HDO は configuration error として事前に弾く）。

つまり **VRAM が 65536 tokens 分の KV cache を保持できないマシンでは、この profile は速度面で実用にならない**。この場合の選択肢は、implement/fix も cloud runner へ回すか、次の lean worker profile へ切り替えるかのどちらかで、`contextTokens` を下げて凌ぐことはできない。

## 6.1 Ollama lean worker profile

`config/examples/ollama-lean-worker.json` は、local step を Claude CLI ではなく HDO 同梱の `workers/hdo-ollama-worker.ps1` に `type: command` runner として実行させる。plan / review が cloud のままである点は 6 と同じで、違うのは local 側の harness だけである。

**この profile が存在する理由は context の固定費にある。** 4.3 のとおり Claude CLI は宣言 window から 23000 tokens を先に差し引くため、汎用の対話型 agent としての機能と引き換えに `contextTokens` の下限が 57344 になる。lean worker は HDO が必要とする tool 定義と system prompt しか積まないため、同じ仕事の固定費が桁違いに小さい。

| harness | 送信前の固定費 | `contextTokens` の下限 |
| --- | --- | --- |
| Claude CLI（6 の profile） | 予備枠 23000 + 独自 system prompt + tool 定義 | 57344 |
| lean worker（本 profile） | 数百 tokens | schema 下限の 1024 |

実測（Ollama 0.33.2 + `qwen3.8:27b-q4_K_M`、`num_ctx: 32768`）では、1 ファイルの off-by-one 修正が read → edit の 3 ターンで完了し、ピークの prompt は 712 tokens だった。**同クラスのタスクが Claude CLI では 32768 で `Prompt is too long` になる**のに対し、lean worker は window の 2% しか使っていない。このため example は 24GB VRAM の GPU に完全に載る `contextTokens: 32768` を既定にしている。

設計上の性質:

- **派生モデルが不要**: Ollama の native `/api/chat` は `num_ctx` を request option として受け付けるため、4.3 の `ollama create` による派生モデルは要らない。`contextTokens` がそのまま `options.num_ctx` になる
- **tool boundary は同じ**: 公開するのは workspace 配下の `read_file` / `list_files` / `search_files`（および read-only でない場合は `write_file` / `edit_file`）だけで、shell、git、build、validation gate は実行しない。workspace 外への path は拒否する。read-only の制約は tool 一覧から外すだけでなく、実際に file system へ触れる dispatch 地点でも強制する
- **tool result に上限がある**: 1 回の tool result は既定 20000 文字で切り詰め、切り詰めた事実をモデルへ返す。4.3 で述べた「単一ターンの巨大な tool result が黙って切り詰められて誤答になる」問題を、harness 側で制御できる形にしている
- **turn 上限**: 既定 40 ターンで打ち切り、未完了分を `blockers` として報告させる
- **取得量を model 側から絞れる**: `read_file` は `start_line` と `max_lines`、`search_files` は `max_results`（既定 100 件）を取り、必要な範囲だけを返す。system prompt でも「既存 file の変更は `write_file` ではなく `edit_file`」「まず `search_files`、次に範囲指定の `read_file`」を指示する
- **context を使い切る前に履歴を圧縮する**: 下記の automatic context compaction

### automatic context compaction

固定費が小さいことは会話が伸びないことを意味しない。tool result と tool arguments は turn ごとに積み上がり、実測では 1 ターンあたり +8,000〜16,000 tokens で、`contextTokens: 65536` でも 6 ターン程度で天井に達する（issue #47）。worker は Ollama が返す `prompt_eval_count` に「まだ送っていない直近 message の推定分」を足した値を監視し、`contextTokens` の `-CompactAtPercent`（既定 65）に達した時点で、provider 側の silent truncation より先に履歴を書き換える。

圧縮後の履歴は次の 4 つだけになる。

1. 元の system prompt（無変更）
2. 元の task message（無変更。compaction が書き換えたり失われたりすることはない）
3. 圧縮 block 1 通
4. 直近 `-KeepRecentMessages`（既定 6）message。境界が tool result の場合は、その tool call を出した assistant turn まで巻き戻すので、tool result が呼び出し元から切り離されることはない

圧縮 block は 2 つの節を明示的に分けて持つ。前半は **worker 自身が観測した事実**（変更した file と操作回数、直近の action、tool error、読んだ file、検索した pattern、turn 数、compaction 回数）で、model の記憶には依存しない。後半は **model が生成した working summary**（current state / remaining work / failed attempts / decisions / files changed / files inspected / constraints / goal）で、schema を強制した別会話として取得する。要約要求は session の続きではなく毎回新規の 2 message 会話であり、入力は破棄対象を切り詰めた digest（window の約 35% を上限）に限られるため、上限付近で compaction 自体が失敗することはない。要約が失敗・空・不正 JSON の場合は観測事実だけの block へ縮退し、step は落とさない。

各節の項目は、continuation で重要な情報を先頭に並べている。節ごとの上限（`MaxBlockHalfTokens`）を超えた分は末尾から切り詰められるため、末尾に置いた項目ほど先に失われる。goal / constraints は保護されている元の task message と重複するため末尾に、`current state` / `remaining work` / `files changed` / 直近の action は他では得られないため先頭に置いている。

保持した直近 message だけで閾値を超える場合（巨大な tool result や `write_file` の full content が 1 通に入っている場合）は、閾値を下回るまで保持数を半減する。そうしないと reclaim できないまま毎 turn 圧縮を試み、要約呼び出しだけを繰り返すことになる。保持境界は要約より **先に** 決める。後から決めると、要約対象からも保持対象からも外れる message が黙って消える。

置換 block 自体にも上限がある（閾値の 35%、観測事実と model summary で折半）。上限が無いと、compaction のたびに前回の summary を含めて要約するため block が成長し、やがて block だけで閾値を超えて圧縮が何も回収できなくなる。この値は保持量を決めるときの予約枠でもあるため、`contextTokens` ではなく閾値に対する比率で決めている。window 基準にすると `CompactAtPercent` が低い構成で予約枠が使える枠の過半を占め、直近 message を 1 通も残せなくなる。

なお window が極端に狭く、system prompt と tool 定義と 1 往復だけで閾値に届く構成では、保持できる直近 message が 0 通になることがある。これは計算どおりの結果であって、その場合は置換 block だけで継続する。

`read_file` を範囲指定または途中打ち切りで読んだ場合、観測事実には `(partial)` を付けて記録する。system prompt は「full で読んだ file を読み直すな」と指示しているため、部分読みを「読んだ file」として記録すると、圧縮で本文が消えたあと再取得もできなくなる。

なお使用量の推定は文字数ではなく **UTF-8 byte 数 / 3** で行う。「1 token = 4 文字」は ASCII でしか成り立たず、この repository のように prompt や issue 本文が日本語だと 4 倍近い過小評価になって compaction が間に合わない。byte / 3 は日本語でほぼ 1 文字 1 token、ASCII では 3 割ほど過大に見積もる。過大側は「少し早めに圧縮する」だけで害が無く、過小側だけが失敗になる。

保持境界は「tool result を呼び出し元の assistant turn から切り離さない位置」＝ tool 以外の message の位置から、**保持量が最大になるもの** を選ぶ。1 回の assistant turn が大量の並列 tool call を返した場合など、どの位置でも収まらないときは何も保持せず、置換 block だけで継続する。

閾値到達で起動した compaction は、必ず最低 1 往復を落とす。起動の根拠は provider 自身の `prompt_eval_count` であり、window の逼迫について権威があるのは HDO 側の推定ではなくそちらである。両者が食い違ったときに「推定ではまだ余裕がある」として圧縮を見送ると、window を超えた request がそのまま送られてしまう。

model が tool を一切呼ばず終了 turn を返した場合も、loop を抜ける直前に同じ閾値判定を行う。tool result と違い assistant の返答本文には `MaxToolResultChars` のような上限が無いため、饒舌な local model は最後の 1 turn だけで閾値を超えうる。この判定を loop の break より後回しにすると、その turn は in-loop compaction からも最終縮約からも漏れて未圧縮のまま最終 request に載ってしまう。

tool loop 終了後、schema を強制する最終 turn の前にも同じ縮約を行う。最終 turn は済んだ作業を整形するだけなので、長い run で最も無駄な再送になりやすい。ただし縮約するのは **すでに 1 回でも compaction が起きたか、履歴（または保護 prefix 直後の 1 通）が閾値に達している場合だけ** である。まだ十分収まっている履歴を捨てると、model 側の summary が未生成のまま観測事実だけで最終報告を書かせることになり、実際のコストより大きい損をする。message 数だけでこの判定をすると、system・task に続く 1 通の巨大な終了 turn（合計 3 通、閾値超）を「短い session」と誤認して見送ってしまうため、token 推定も必ず併用する。

1 通だけ落として block と入れ替えても、その 1 通が並より小さければ差し引きゼロで要約呼び出しだけが無駄になるため、そのケースはスキップする。ただし、その 1 通が置換 block の上限を超えて巨大な場合は別で、そこでは実際に縮まるのでスキップしない。

実際に message を落とす場合は要約を 1 回取得する。落とす対象は定義上「前回 compaction 以降の turn」であって既存 summary の範囲外なので、既存 summary を使い回すと最終報告が途中までの経緯しか語らなくなる。ただし tool 呼び出しの無い終了 turn 自体が閾値超で、その場で in-loop compaction が実際に走った場合（保護 prefix 直後の 1 通だけでなく、それ以前の turn も含めて複数 message を落とせた場合）は、直後の最終縮約を重ねて行わない。保持境界の決定時点で置換 block の上限を差し引いた余裕を確保しているため、直後に再度縮約しても通常は何も削れず、要約呼び出しだけが無駄になる。

`read_file` の結果を「full で読んだ」か「部分的にしか読んでいないか」の判定は、返却テキストを正規表現で走査するのではなく、`Invoke-WorkerTool` 側が読み取りの分岐そのものから構造的に確定する。テキスト側で判定すると、この worker 自身の source のように truncation marker の文言をたまたま含むファイルを検査対象にした場合、full 読みが誤って partial と記録される。また同一 path に対する記録は 1 file 1 entry に統合し、「一度でも full で読んだ」を優先する。path 文字列で区別せず「path」と「path (partial)」を別々の list entry として両方保持すると、同じ file について矛盾した状態が block に同時に現れる。

診断は stdout に出る。

~~~text
turn 5: prompt_tokens=21980 tool_calls=1
compaction: turn=5 reason=threshold prompt_tokens_before~23110 prompt_tokens_after~4820 messages=12->5 kept_recent=2
final: prompt_tokens=5210 turns=9 num_ctx=32768 compactions=1
~~~

`-CompactAtPercent 0` を渡すと compaction は完全に無効になり、閾値未到達の場合と同じく従来どおりの動作になる。

調整は runner の `extraArgs` に引数を足して行う。HDO の config schema には現れない worker 自身の引数である。

| 引数 | 既定 | 意味 |
| --- | --- | --- |
| `-CompactAtPercent` | 65 | compaction を起動する `contextTokens` の使用率（%）。0 で無効 |
| `-KeepRecentMessages` | 6 | compaction 後に残す直近 message 数 |
| `-MaxToolResultChars` | 20000 | 1 回の tool result の文字数上限 |
| `-MaxTurns` | 40 | tool loop の turn 上限 |

制約:

- command runner なので repository config からは選択できない（4.4 参照）。explicit / user configuration で明示的に選ぶ必要がある
- Claude CLI が持つ汎用機能（sub-agent、MCP、hook など）は無い。狙いは「HDO の implement/fix step を最小の context で回すこと」に限定されている

検証は `tests/test-lean-worker.ps1`（stub server を使い実 Ollama 不要、CI で実行）と `tests/test-lean-worker-smoke.ps1 -Run`（実 Ollama を使う opt-in）で行う。

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

`%LOCALAPPDATA%` / `%APPDATA%` は環境変数が定義されていればそれを使い、未定義なら .NET の既知フォルダー（Windows: LocalApplicationData/ApplicationData、Linux: `$XDG_DATA_HOME` または `~/.local/share` / `$XDG_CONFIG_HOME` または `~/.config`）へ fallback する。両方とも得られない場合は設定エラーになる。`config/hdo.default.json` の既定値は OS 共通のまま `%LOCALAPPDATA%/hdo/...` を維持する（ADR-0001 で両実装共通の契約としている）。これは Linux を正式対応にするものではない（ADR-0001 参照）。

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

`%APPDATA%/hdo/config.json`（Windows。他 OS の fallback は 1 節参照）は partial overlay にできる。

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
| Claude step で schema/JSON error | doctor の `runner:*:shim` warning。canonical CLI（PowerShell）実行なら npm の `.cmd` shim ではなく native claude install を使う（TypeScript ランタイムは `.cmd` shim を安全に扱うため必須ではないが、8191 文字上限には引き続き注意する） |
| Ollama が突然必要 | active execution plan に `provider: ollama` がないか |
| model missing | `ollama list` と runner.model。HDO は pull しない |
| gate unknown | Issue の Validation Gate IDs と `.hdo/project.json` |
| GitHub actor rejected | `github.trustedActors` と ready label event / `gh api user` |
| write-back を止めたい | run に `-NoWriteBack`、または `github.writeBack: none` |
| `hdo cleanup` が `Filename too long` で失敗する、または失敗後に worktree ディレクトリだけが残る | Windows で worktree 配下（`node_modules/.pnpm` 等）のパスが `MAX_PATH` (260) を超えている。HDO は git 呼び出しに `-c core.longpaths=true` を付けるが、global / system config に `core.longpaths=false` があると git はそちらを優先する。`git worktree remove` が admin entry を消した後に失敗した場合、HDO は同じ cleanup 内でディレクトリを削除し `git worktree prune` する。既に残骸だけになった worktree（`git worktree list` に無い）は、run の branch がまだ存在していれば `hdo cleanup -RunId <id> -Force` で削除できる。恒久対策は `git config --global core.longpaths true` |
