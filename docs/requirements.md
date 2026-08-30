# Hybrid Dev Orchestrator 要件定義書

- 文書種別: MVP 要件定義書
- 対象リポジトリ: kkb-hub/hybrid-dev-orchestrator
- MVP 対象OS: Windows native
- ステータス: Draft for review
- 最終更新: 2026-08-30

## 1. 概要

Hybrid Dev Orchestrator（以下 HDO）は、クラウド上の高性能LLMとローカルLLMを役割分担させる、ソフトウェア開発向けオーケストレーション基盤である。

MVPでは Claude Code を Planner / Reviewer、Codex CLI + Ollama 上のローカルLLMを Implementer として利用する。

目的は、ローカルLLMを Claude と同等にすることではない。高頻度な実装・テスト・修正をローカルへ移し、Claude の能力と利用量を、タスク整理・設計判断・レビュー・難易度の高い判断へ集中させることである。

基本フロー:

~~~text
Developer
   |
   v
Claude Code
Planner / Reviewer
   |
   | implementation contract
   v
HDO PowerShell Orchestrator
   |
   +--> Preflight / Policy
   +--> Isolated Git Worktree
   |
   v
Codex CLI --oss
   |
   v
OpenAI-compatible provider boundary
   |
   v
Ollama
   |
   v
Local Coding LLM
   |
   +--> source changes
   +--> tests / build / lint
   |
   v
diff + test result + worker summary
   |
   v
Claude Code Review
   |
   +--> approve
   +--> request_changes --> Local Worker
   +--> escalate
~~~

## 2. 背景

フロンティアモデルは、既存リポジトリの理解、曖昧な要求の整理、複雑なデバッグ、設計判断、コードレビューにおいて、ローカル20B〜35B級モデルより強い。

一方、RTX 4090 24GBクラスのGPUでは、30B前後の量子化モデルを実用的な速度で動作させることができる。単純・定型・中難度の実装をすべてクラウドLLMへ依頼する必要はない。

HDOはモデル性能差を隠すのではなく、role separation、worktree isolation、sandbox、provider abstraction、structured review、bounded fix loop、run artifacts、benchmarkability により、性能差を前提として利用する。

## 3. MVPの目的

MVPは以下を実現する。

1. Claude Code が実装タスクを整理できる。
2. Claude Code が実装そのものを行わず、ローカルworkerへ委譲できる。
3. ローカルworkerが隔離されたGit worktree内でコードを変更できる。
4. ローカルworkerがbuild / lint / testを実行できる。
5. Claude Codeが差分とテスト結果をレビューできる。
6. レビュー指摘をローカルworkerへ返して修正させられる。
7. 修正ループを有限回で停止できる。
8. 実行内容・差分・テスト結果・レビュー結果を追跡できる。
9. ローカルLLM providerを設定で切り替えられる。

成功条件は、Windows native環境でClaude Codeから実装タスクを依頼し、planning -> local implementation -> test -> Claude review -> local fix -> re-test -> final review が手作業のコピー＆ペーストなしで完了することである。

## 4. 非目的

MVPでは以下を対象外とする。

- ローカルLLMをClaude / GPT等のフロンティアモデルと同等の能力にすること
- Claude CodeまたはCodex CLIのfork
- 独自LLM inference engine
- 独自OpenAI-compatible HTTP proxy
- MCP serverによる常駐daemon化
- WSL2 / Linux / macOS対応
- 複数GPU最適化
- 自動commit / push / PR
- 無制限の自律実行
- GPUを必要とするGitHub-hosted CI

## 5. 前提環境

MVP reference environment:

- OS: Windows 11
- Shell: PowerShell 7
- GPU: NVIDIA RTX 4090 24GB
- System RAM: 128GB
- Git: Git for Windows
- Claude Code: Windows native
- Codex CLI: Windows native
- Ollama: Windows native
- Local LLM: `qwen3.8:27b` (Ollama)

RTX 4090 / RAM 128GBはreference environmentであり、HDOそのものがこのハードウェアだけに依存してはならない。

## 6. 役割分担

### 6.1 Human

Humanは最終的な権限主体である。task開始、security-sensitive action、network-enabled profile、最終成果物、commit、push、PRを最終承認する。

### 6.2 Claude Code

Claude Codeの役割は Planner / Task Framer / Reviewer / Escalation Judge とする。

Claude Codeは通常フローで実装コードを直接変更してはならない。レビューNGの場合もClaude自身が修正せず、actionableな指摘をローカルworkerへ返す。

### 6.3 Local Worker

Local Workerは repository exploration、implementation、refactoring、test追加、build、lint、test実行、review findingへの修正を担当する。

Local Workerは Codex CLI の非対話モードをagent harnessとして利用する (§6.4)。

### 6.4 Codex CLI

Codex CLIはローカルLLMと開発ツールを接続するagent harnessとして利用する。HDOからは原則として非対話モード (`codex exec`) で呼び出す。

HDOがCodex CLIへ要求する機能は以下とする。

- OSS / local provider機構によるローカルモデル接続
- workspace-write相当のsandbox指定
- 機械可読なevent stream出力 (JSONL)
- 最終メッセージのファイル保存

具体的なCLIフラグ名およびconfigキー名は要件ではなく実装詳細として扱い、単一のCodex adapter層へ閉じ込める。orchestration logicはadapterのみを呼び出し、Codex CLI引数を全体へ散在させない。

Codex CLIはフラグおよびconfigキーの仕様変更が発生しうるため、動作確認済みバージョンを設定値として保持し、preflightで検出したバージョンと突き合わせる。

## 7. Provider設計

Ollamaをreference implementationとする。

HDOの内部設計はOllama固有APIへ密結合させず、OpenAI-compatible APIを前提とした provider / config / capability abstraction を持つ。

MVPでは独自HTTP proxyを作成しない。

Provider profileは最低限以下を扱う。

- providerName
- baseUrl
- wireApi
- modelId
- contextTokens
- responses capability
- tools capability
- streaming capability
- reasoning capability
- healthCheck

将来的に Ollama、LM Studio、llama.cpp server、vLLM、その他OpenAI-compatible endpoint を追加可能とする。

context長の扱いには特に注意を要する。OpenAI-compatible endpoint経由の場合、provider側が実際にロードする実効context長と、harness側が想定するcontext長は独立に決まる。いずれかが小さいと入力が黙って切り詰められ、workerの失敗原因がモデル能力の問題と区別できなくなる。

したがってcontextTokensはartifactへの記録専用の値ではなく、実際に適用する値とする。HDOはprofileのcontextTokensをprovider側とharness側の双方へ明示的に適用し、適用された値をartifactへ記録する。適用値を確認できない状態でworkerを実行してはならない。

provider側のconversation stateへ依存せず、HDO自身が task、run、iteration、review findings、diff、test result、worker summary、model profile、execution status をsource of truthとして保持する。

## 8. モデルプロファイル

モデル名をorchestration logicへhard-codeしてはならない。

| Profile | modelId (Ollama) | 重みサイズ | 想定用途 | 初期Context |
|---|---|---:|---|---:|
| balanced | `qwen3.8:27b` | 18GB | 通常実装 | 32K |
| long-context | `devstral-small-2:24b` | 15GB | repo理解・長めのcontext | 64K |
| reasoning | `qwen3.6:35b` | 23GB | 高難度タスク | 16K |
| experimental-large | `qwen3-coder-next` | 52GB | RAM offload実験 | 16K |

balanced を初期defaultとし、MVPのreference/default modelは Ollama の `qwen3.8:27b` とする。

HDOでは1回の最大能力よりも、Implement -> Test -> Review -> Fix -> Test -> Review の time-to-correct-solution が重要である。

`qwen3.8:27b` はMVPで実際に利用する基準モデルとして扱う。ただしmodelIdは設定値として保持し、orchestration logicへhard-codeしない。

### 8.1 初期Contextの根拠

上表の初期Contextはモデルの最大context長ではない。列挙した4モデルはいずれも公称256K以上のcontext長を持つ。

制約となるのはreference environmentのVRAM 24GBであり、実際に確保できるcontext長は「VRAM - 重みサイズ」で決まるKV cache容量に依存する。すなわちprofile間の差はモデルの最大context長ではなく、VRAM内で実効的に確保できるcontext長である。long-contextプロファイルが成立するのは、`devstral-small-2:24b` の重みが4モデル中最小でKV cacheへ回せるVRAMが最も大きいためである。

上表の値は初期目標値であり、確定値ではない。実際に確保できる値はquantization、KV cache精度、GPU上の他プロセスのVRAM使用量に依存するため、profileごとに実測して確定する。

reasoningプロファイルは重みだけでVRAMの大半を占めるため初期値を16Kとしたが、thinkingトークンがcontextを消費するため不足する場合がある。実測により調整するか、KV cache量子化の適用を検討する。

profileの追加・変更時は、long-contextのcontextTokensがbalancedを下回らないことを設定validationで確認する。

### 8.2 thinking制御

`qwen3.8` および `qwen3.6` はthinkingがdefaultで有効である。thinkingの有無とreasoning effortはworkerの実行時間およびcontext消費へ直接影響するため、profileの設定値として制御可能とする。制御できない場合でも、どの設定で実行したかをartifactへ記録する。

### 8.3 導入経路

MVP時点では上記4モデルはいずれもOllama library tagとして取得可能であり、GGUFからのimportを必須としない。

ただしprofileごとの導入元と導入コマンドは `config/models.json` に保持し、§20 preflightでモデル未導入時にユーザーへ提示する情報として利用する。library tagが存在しないモデルを将来profileへ追加する場合に備え、導入元としてlibrary tagとModelfile importの双方を表現できるschemaとする。

### 8.4 experimental-large

`qwen3-coder-next` は52GBでありVRAM 24GBへ収まらないためRAM offloadが前提となる。

ただし本モデルはMoEでありactive parameterが小さいため、同一サイズのdense modelほどoffloadによる速度低下を受けない可能性がある。MVPではexperimental扱いを維持し、実用可否はbenchmark suiteのtime-to-correct-solutionで再評価する。

## 9. Git Worktree隔離

ローカルworkerはユーザーの現在のworking treeを直接変更してはならない。

各runごとに専用のGit worktreeを作成する。既定保存先は %LOCALAPPDATA%\hdo\worktrees\<run-id> とし、設定で変更可能とする。

Lifecycle:

1. repository状態確認
2. base commit固定
3. run-id生成
4. dedicated branch生成
5. worktree生成
6. worker実行
7. diff取得
8. review
9. approve / request_changes / escalate
10. Humanによる成果物確認
11. 明示的cleanup

Workerは commit、push、force push、destructive reset、main branch更新を実行してはならない。Workerは未コミット差分を残す。

## 10. Sandboxと権限

Windows native MVPではCodexのWindows sandboxを利用する。

推奨:

- Windows sandbox: elevated
- execution sandbox: workspace-write
- network access: false

無制限のsandbox bypassモードはMVPで利用しない。

CodexのelevatedサンドボックスはOSレベルのセットアップ (低権限sandboxユーザーの作成、ACL設定、firewall規則、logon right付与) を必要とし、UAC拒否や企業ポリシーにより失敗して、より保護の弱いunelevatedモードへfallbackする場合がある。

HDOはelevated / unelevatedのいずれで実行したかを判定してartifactへ記録し、期待するsandboxを満たせない場合の扱い (警告して継続 / 停止) を設定可能とする。既定は停止とし、sandbox強度の低下を黙って受け入れない。

Local Workerの外部ネットワークアクセスは既定で禁止する。workerの判断だけで npm install、pip install、curl、Invoke-WebRequest、git fetch、任意外部APIアクセスを許可しない。

必要な場合はユーザーが明示的にnetwork-enabled profileを選択する。

Local Workerへ不要なcredentialを継承してはならない。特に Anthropic API credential、OpenAI API credential、GitHub token、cloud provider credentials、unrelated application secrets を可能な限りworker環境から除外する。

Ollama endpointは原則localhostに限定し、既定は http://localhost:11434 とする。不用意にLANへ公開しない。

network denyの対象は、workerがsandbox内で実行するコマンドである。Codex CLI自身がlocal provider endpointへ行うmodel API呼び出しはこれとは別経路であり、両者を混同しない。この2経路がWindows sandbox上で実際に分離されることの確認は§30の未解決事項とする。

## 11. Claude Reviewer制約

Claudeを実装しないReviewerにする要件はpromptだけに依存してはならない。

Claude reviewerが利用可能:

- Read
- Grep
- Glob
- git status
- git diff
- test log閲覧
- HDO worker invocation

通常フローで禁止:

- Write
- Edit
- git commit
- git push
- git reset --hard
- destructive filesystem operations

MVPではClaude Code SkillとHooksを併用する。PreToolUse hookは対象のtool callを実行前にdenyできるため、禁止操作の強制はprompt依存ではなくhookで実装する。

Skillは意図を伝える手段、hookは強制する手段として役割を分ける。

## 12. Claude Code Skill

MVPでは .claude/skills/local-implement/SKILL.md を提供する。

Skillの責務:

1. ユーザー要求をimplementation contractへ変換する。
2. PowerShell orchestratorを呼び出す。
3. run manifest、diff、test results、worker summaryを読む。
4. strict reviewを実施する。
5. approve / request_changes / escalate のいずれかを返す。
6. request_changes の場合、実装せずにworkerへ修正要求する。
7. 最大iteration数で停止する。

## 13. Orchestrator

Windows native MVPではPowerShellをorchestration layerとする。

MCP serverやdaemonはMVPでは導入しない。

理由:

- process lifecycleを単純化できる
- Windows nativeとの相性が良い
- Claude Code Skillから直接呼べる
- Codex CLIとの接続が容易
- デバッグが容易
- MVPで不要な常駐サービスを増やさない

post-MVPではMCP interfaceを検討できるが、PowerShell CLIとの互換性を可能な限り維持する。

## 14. 状態モデル

Runは最低限以下の状態を持つ。

~~~text
CREATED
  -> PREFLIGHT
  -> WORKTREE_READY
  -> IMPLEMENTING
  -> TESTING
  -> REVIEW_PENDING
       -> APPROVED
       -> CHANGES_REQUESTED -> IMPLEMENTING
       -> ESCALATED

任意のnon-terminal state
  -> FAILED      (回復不能なエラー)
  -> CANCELLED   (ユーザーによる中断)
~~~

FAILEDおよびCANCELLEDはREVIEW_PENDING固有ではない。preflight失敗、worker timeout、VRAM OOM、policy violationはIMPLEMENTINGやTESTINGからも発生するため、任意のnon-terminal stateからの遷移先とする。

APPROVED / ESCALATED / FAILED / CANCELLED を終端状態とし、終端状態からの遷移を許可しない。

不正な状態遷移を許可しない。状態遷移はstate-machine testで検証する。

## 15. Review / Fix Loop

Claudeのレビュー結果は自然言語だけで保持せず構造化する。

review resultの最低フィールド:

- decision
- summary
- findings — finding objectの配列 (空配列を許容)

各findingの最低フィールド:

- severity
- path
- line
- message
- requiredAction

許可するdecisionは approve / request_changes / escalate とする。decisionが request_changes の場合、findingsを空にしてはならない。

review resultの構造はJSON Schemaとして `schemas/` へ定義し、CIで検証する。

レビュー→修正ループは既定で最大3回とする。最大回数到達後は自動継続せずHumanへescalateする。無制限値は禁止する。

## 16. Worker Prompt

初回worker promptは Task Contract、Repository Context、Constraints、Required Validation から構成する。

修正回は Original Task、Current Implementation State、Claude Review Findings、Previous Test Result、Constraints から構成する。

provider固有のconversation historyへ依存しない。

## 17. Test / Build / Lint

Local Workerは可能な範囲でrepository既存の検証方法を自動検出する。

優先順位:

1. repository instruction
2. AGENTS.md / CLAUDE.md等のproject instruction
3. package/build metadata
4. configured HDO validation commands
5. safe fallback

テスト未実行を成功扱いにしてはならない。実行できない場合は理由をartifactへ残す。

## 18. Run Artifacts

runごとに実行情報をrepository外へ保存する。

既定保存先は %LOCALAPPDATA%\hdo\runs\<run-id> とする。

保存対象:

- run.json
- environment.json
- worker prompt
- worker JSONL events
- worker final message
- diff patch
- test log
- review result
- metrics

artifactには run id、repository、base commit、worktree path、branch、model/profile、実際に適用されたcontext長、thinking設定、Codex CLI version、判定されたsandbox mode、iteration、start/end time、exit code、worker events、git diff、test output、review result、failure category、timing metrics を記録可能とする。

context長・sandbox mode・Codex CLI versionは「設定値」ではなく「実際に適用・検出された値」を記録する。設定値と実際値が異なる場合は両方を記録する。

runがFAILEDまたはCANCELLEDで終了した場合も、その時点までに取得できたartifactを保存する。

## 19. Logging / Privacy

- environment variableの全量dumpを禁止する
- known secret patternをredactする
- credentialをpromptへ埋め込まない
- artifactをrepositoryへ自動commitしない
- retention policyを将来設定可能にする

Claude reviewを利用する場合、diffおよび関連コードがクラウド側へ送信され得ることを明示する。

Local Implementerという名称は、レビューを含む全処理がローカルであることを意味しない。

## 20. Preflight

worktree作成前に以下を検査する。

- Gitが存在する
- repository内である
- base revisionが取得可能
- PowerShell version
- Codex CLIが存在する
- Codex CLI versionが動作確認済み範囲である
- Ollamaが到達可能
- 指定modelが存在する
- profileのcontextTokensを適用可能である
- required disk space
- worktree rootが書込可能
- profileがvalid
- iteration limitがvalid
- sandbox policyがvalid
- Codex sandboxのsetup状態 (elevated / unelevated) を判定できる

modelが存在しない場合、HDOが自動で巨大モデルをpullしない。`config/models.json` のprofile定義に基づき必要なコマンドをユーザーへ提示し、終了する。

Codex CLI versionが動作確認済み範囲外の場合、およびelevated sandboxを要求していてunelevatedへfallbackする場合は、既定で停止する。設定により警告のうえ継続を許可できるが、いずれの場合も判定結果をartifactへ記録する。

## 21. Error Taxonomy

| Error | HDO behavior |
|---|---|
| Git不在 | worktree作成前にfail |
| Codex不在 | worktree作成前にfail |
| Codex CLI version不一致 | 既定で停止、設定により警告のうえ継続 |
| Ollama不在 | retry後fail |
| Model未導入 | pullせず導入方法を提示 |
| Context適用失敗 | 黙って続行せずfail |
| CUDA/VRAM OOM | profile変更候補を提示して停止 |
| Worker timeout | process tree停止、artifact保存 |
| User cancel | process tree停止、artifact保存、CANCELLEDで終了 |
| Policy violation | 即時停止 |
| Network violation | 即時停止 |
| Sandbox格下げ | 既定で停止、設定により警告のうえ継続 |
| Test failure | iteration範囲内でworkerへ返す |
| No diff | 実装タスクなら異常扱い |
| Max iterations | Humanへescalate |
| Dirty worktree cleanup | force削除せずrecovery情報を残す |

HDOが黙ってcontext量、model、量子化方式、network policy等を変更して再試行してはならない。再現性を優先する。

## 22. Timeout / Cancellation

- worker実行にはtimeoutを設定できる
- ユーザーがrunを中断できる
- 中断時はchild processを残さない
- 中断時も可能なartifactを保存する
- dirty worktreeを自動force deleteしない

## 23. Configuration

最低限以下を設定可能とする。

- worktreeRoot
- runArtifactRoot
- provider
- providerBaseUrl
- modelProfile
- modelId
- contextTokens
- thinkingMode / reasoningEffort
- maxIterations
- workerTimeout
- networkAccess
- sandboxMode
- onSandboxDowngrade (stop / warn)
- expectedCodexCliVersion
- onCodexVersionMismatch (stop / warn)
- validationCommands
- retention

設定優先順位は CLI arguments > project config > user config > defaults を想定する。

secretをproject configへ保存しない。

## 24. 想定リポジトリ構成

~~~text
hybrid-dev-orchestrator/
├── docs/
│   ├── requirements.md
│   ├── architecture.md
│   └── security.md
├── .claude/
│   ├── skills/local-implement/SKILL.md
│   ├── agents/hybrid-reviewer.md
│   └── settings.json
├── config/models.json
├── schemas/
├── scripts/
├── tests/powershell/
├── .github/workflows/ci.yml
├── .gitignore
└── README.md
~~~

初回PRでは本要件定義書のみを追加する。

## 25. CI要件

GitHub-hosted CIではGPUやOllama巨大モデルを要求しない。

通常CIで検証するもの:

- PowerShell syntax
- Pester tests
- PSScriptAnalyzer
- JSON Schema validation
- state-machine tests
- mocked Codex execution
- mocked Ollama endpoint
- secret-redaction tests
- Windows path tests

実GPU integration testは将来self-hosted Windows runner等へ分離する。

## 26. 非機能要件

### Reproducibility

同一runについて base commit、model profile、prompt、diff、validation result、review result、iteration が後から確認できること。

### Safety

- main working treeをworkerから隔離する
- network denyをdefaultにする
- secretをworkerへ不要に渡さない
- destructive commandを禁止する
- infinite loopを禁止する

### Observability

少なくとも wall-clock duration、worker duration、iteration count、test duration、changed files、additions/deletions、worker exit status、model/profile、取得可能なtoken/usage metricsを計測可能とする。

### Extensibility

local model、local provider、reviewer model、validation commands、future orchestration frontend を交換可能にする。

### Usability

通常利用で、ユーザーがworker promptやreview findingを手作業でコピー＆ペーストする必要がないこと。

## 27. MVP Acceptance Criteria

- AC-01 Windows native環境でClaude Codeからlocal implementation workflowを開始できる。
- AC-02 HDOが専用Git worktreeを生成し、現在のworking treeを変更しない。
- AC-03 Codex CLIがOllama上の指定local modelを利用してworktree内のファイルを変更できる。
- AC-04 workerが対象repositoryで必要なvalidationを実行できる。
- AC-05 HDOがgit diff、test result、worker summaryをClaude reviewerへ渡せる。
- AC-06 Claude reviewerが approve / request_changes / escalate の構造化decisionを返せる。
- AC-07 request_changesの場合、Claudeが直接修正せずfindingをlocal workerへ返せる。
- AC-08 最大3iterationでループが停止し、それ以上はHumanへescalateする。
- AC-09 workerがcommit/pushを行わない。
- AC-10 workerのnetwork accessがdefaultでdenyされている。
- AC-11 Claude/OpenAI/GitHub等の不要credentialをworkerへ渡さない。
- AC-12 各runのmanifest、diff、test result、review result、主要logがrepository外へ保存される。
- AC-13 Ollama停止時に安全な状態で明確にfailする。
- AC-14 model未導入時に自動pullせず必要操作を提示する。
- AC-15 ユーザーがrunをcancelでき、child processが残存しない。
- AC-16 MVPのCIがGPUなしのGitHub-hosted Windows runnerで実行できる。
- AC-17 profileのcontextTokensがproviderおよびharnessへ実際に適用され、適用値がartifactへ記録される。
- AC-18 実行時のsandbox mode (elevated / unelevated) が判定されartifactへ記録され、期待するsandboxを満たせない場合は既定で停止する。
- AC-19 runがFAILEDまたはCANCELLEDで終了した場合も、その時点までのartifactが保存される。
- AC-20 review resultがJSON Schemaへ適合し、request_changes時にfindingsが空でない。

## 28. Roadmap

### Phase 1 — Windows native MVP

- PowerShell orchestrator
- Claude Code Skill
- Claude reviewer restriction
- Codex CLI --oss
- Ollama
- OpenAI-compatible provider abstraction
- Git worktree isolation
- structured review
- bounded fix loop
- run artifact
- mocked CI

### Phase 2 — Hardening

- Claude Code Hooks強化
- secret filtering
- policy engine
- recovery UX
- benchmark suite
- self-hosted GPU integration tests
- model routing evaluation

### Phase 3 — WSL2

- WSL2 filesystem
- Linux-style path/process abstraction
- Claude sandbox利用
- Codex Linux sandbox利用
- Windows/Ollama接続方式検証

### Phase 4 — Linux / Provider Expansion

- Linux native
- LM Studio
- llama.cpp server
- vLLM
- cross-platform process layer
- optional MCP server

## 29. 設計上の重要判断

### 29.1 Claudeに直接修正させない

Claudeがレビュー後に小さな修正を直接行える設計にすると、ローカル実装へ処理を移すというHDOの目的が崩れる。

MVPは意図的に、Claude = 判断する、Local = 変更する、Human = 最終承認する、と分離する。

### 29.2 最大モデルをdefaultにしない

RTX 4090 + 128GB RAMでは大規模モデルをRAM offloadで動作させることは可能である。しかしHDOの最適化対象は1回の回答能力ではなく、review/fixを含むtime-to-correct-solutionである。

MVPでは `qwen3.8:27b` をdefaultとし、review/fixを含むtime-to-correct-solutionを基準に評価する。大規模モデルや代替モデルはprofileで選択可能にする。

### 29.3 独自HTTP proxyをMVPで作らない

OllamaとCodex CLIが既にOpenAI-compatible/local-provider接続を提供するため、HDO独自proxyはMVPに不要である。

必要なのはnetwork hopではなくprovider設定とcapabilityの抽象化である。

### 29.4 MCPをMVPで導入しない

MCPは将来のinterfaceとして有用だが、MVPではPowerShell CLIで要件を満たせる。最初からdaemon/process lifecycle/schema/trust boundaryを増やさない。

## 30. 未解決事項

以下は実装PRで検証しながら最終決定する。

1. PreToolUse hookによるWrite/Edit denyの網羅性。特にmatcher定義から漏れる経路の洗い出し。
2. workerコマンドのnetwork denyと、Codex CLI自身のlocal provider通信を、Windows sandbox上で両立させる最小設定 (§10)。
3. Codex CLIのバージョン差異を吸収するadapterの粒度と、動作確認済みversion範囲の表現方法。
4. AGENTS.md / CLAUDE.md等をworkerへどの範囲まで渡すか。
5. repositoryごとのvalidation command自動検出ルール。
6. artifact retentionのdefault期間。
7. network-enabled profileの明示承認UX。
8. HDO自身のbenchmark suiteに採用する実タスク。
9. profileごとのcontextTokens初期値のVRAM実測による確定 (§8.1)。
10. thinkingの有効/無効およびreasoning effortが time-to-correct-solution へ与える影響 (§8.2)。

これらはMVP着手を妨げるblocking issueではない。

## 31. 参考資料

一次資料を優先する。

Codexのドキュメントは `developers.openai.com/codex/*` から `learn.chatgpt.com/docs/*` へ恒久リダイレクトされるため、リダイレクト後のURLを記載する。

### Codex

- OpenAI Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- OpenAI Codex Advanced Configuration: https://learn.chatgpt.com/docs/config-file/config-advanced
- OpenAI Codex Non-interactive Mode: https://learn.chatgpt.com/docs/non-interactive-mode
- OpenAI Codex Agent Approvals & Security: https://learn.chatgpt.com/docs/agent-approvals-security
- OpenAI Codex Windows Sandbox: https://learn.chatgpt.com/docs/windows/windows-sandbox
- OpenAI Codex WSL: https://learn.chatgpt.com/docs/windows/wsl

### Claude Code

- Anthropic Claude Code Skills: https://code.claude.com/docs/ja/skills
- Anthropic Claude Code Hooks: https://code.claude.com/docs/ja/hooks
- Anthropic Claude Code Sandboxing: https://code.claude.com/docs/ja/sandboxing

### Ollama

- Ollama Windows: https://docs.ollama.com/windows
- Ollama Codex CLI Integration: https://docs.ollama.com/integrations/codex
- Ollama OpenAI Compatibility: https://docs.ollama.com/api/openai-compatibility
- Ollama Authentication: https://docs.ollama.com/api/authentication
- Ollama Usage: https://docs.ollama.com/api/usage

### モデル

- Ollama qwen3.8: https://ollama.com/library/qwen3.8
- Ollama devstral-small-2: https://ollama.com/library/devstral-small-2
- Ollama qwen3.6: https://ollama.com/library/qwen3.6
- Ollama qwen3-coder-next: https://ollama.com/library/qwen3-coder-next
- Qwen3.6-35B-A3B (upstream): https://huggingface.co/Qwen/Qwen3.6-35B-A3B
- Devstral Small 2 24B (upstream): https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512
- Qwen3-Coder-Next (upstream): https://huggingface.co/Qwen/Qwen3-Coder-Next

### その他

- Git Worktree: https://git-scm.com/docs/git-worktree

## 32. 次の実装PR

本要件PRのmerge後は、以下を次のPR候補とする。

1. config/models.json と設定schema (profile、導入元、contextTokens、thinking設定)
2. schemas/ の review result schema
3. Test-HdoEnvironment.ps1 によるpreflight
4. worktree lifecycle
5. Codex/Ollama worker実行 (Codex adapter層を含む)
6. Claude Code Skill + review loop

実装は一度に全機能を作らず、preflight -> worktree -> worker -> review loopの順に積み上げる。
