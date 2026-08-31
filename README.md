# Hybrid Dev Orchestrator

Hybrid Dev Orchestrator（HDO）は、GitHub Issue を実装契約へ正規化し、専用 Git worktree で planning、implementation、validation、review、fix を有限回実行する Windows / PowerShell CLI です。

各 AI step は runner として設定します。既定は Codex CLI を使う cloud-only 構成で、Ollama は不要です。必要な場合だけ implementation / fix を Ollama へ切り替えられます。Claude や任意 command adapter も runner type として利用できます。

## 前提

- Windows 11 と PowerShell 7.2 以上
- Git for Windows
- GitHub CLI `gh` と GitHub 認証
- 既定構成では Codex CLI `codex` と利用可能な cloud 認証
- 対象 repository に、レビュー済みの `.hdo/project.json`
- 対象 GitHub repository に HDO Issue Form と label

Ollama は optional です。Ollama route を選んだ場合だけ `ollama` command、service、設定した model が必要になります。HDO は model を自動 pull しません。

## 5分で試す

以下は HDO checkout と、HDO を適用する対象 repository が別 directory にある例です。

```powershell
$hdo = 'C:\src\hybrid-dev-orchestrator\hdo.ps1'
$repoPath = 'C:\src\owner\target-repository'
$repo = 'owner/target-repository'

gh auth login
gh auth status
```

### 1. 対象 repository を準備する

対象 repository に次を commit してください。

- `.hdo/project.json`: validation gate と project policy
- `.github/ISSUE_TEMPLATE/hdo-task.yml`: HDO task 用 Issue Form

この repository の [.hdo/project.json](.hdo/project.json) と [.github/ISSUE_TEMPLATE/hdo-task.yml](.github/ISSUE_TEMPLATE/hdo-task.yml) を出発点にできます。validation command は Issue 本文ではなく `.hdo/project.json` だけに定義します。実行前に内容を必ずレビューしてください。

設定と read-only preflight を確認します。

```powershell
pwsh -NoProfile -File $hdo config `
  -RepositoryPath $repoPath -Json

pwsh -NoProfile -File $hdo doctor `
  -RepositoryPath $repoPath -DryRun
```

既定 profile は `cloud-only` です。`doctor -DryRun` でも GitHub、runner、選択済み local provider、project contract は読み取りますが、path probe file は作りません。

### 2. label を用意する

最初の command は差分確認だけ、`-Apply` 付きは label の作成・更新です。

```powershell
pwsh -NoProfile -File $hdo labels `
  -RepositoryPath $repoPath -Repository $repo

pwsh -NoProfile -File $hdo labels `
  -RepositoryPath $repoPath -Repository $repo -Apply
```

HDO は `hdo:ready`、相互排他的な `hdo:status/*`、priority/risk label、設定済み profile に対応する `hdo:route/*` を同期します。HDO namespace 外の label は変更しません。

### 3. Issue を作る

GitHub の New Issue 画面で **HDO implementation task** を選び、少なくとも次を入力します。

- Problem / Context
- Goal
- Acceptance Criteria
- In Scope
- Validation Gate IDs
- Priority と Risk

Validation Gate IDs は `.hdo/project.json` に存在する ID だけを指定します。Issue 本文の command は実行されません。

内容と依存関係を確認した maintainer が、最後に `hdo:ready` を付けます。

```powershell
$issue = 123
gh issue edit $issue --repo $repo --add-label 'hdo:ready'
```

Issue Form 自体は `hdo:ready` を自動付与しません。

### 4. 読み取りと dry-run

```powershell
pwsh -NoProfile -File $hdo issues `
  -RepositoryPath $repoPath -Repository $repo

pwsh -NoProfile -File $hdo inspect -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -Json

pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -DryRun -Json
```

`run -DryRun` は Issue 契約、profile、step routing、project contract、preflight を確認し、execution plan を返します。worktree、run artifact、claim comment、label、assignee、AI runner process は作成しません。

### 5. 実行する

GitHub へ claim/status を書き戻す通常実行:

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo
```

GitHub を変更せず、同じ implementation / validation / review cycle を実行する場合:

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -NoWriteBack
```

自動 pickup では `-Issue` の代わりに `-Pick` を使います。

```powershell
pwsh -NoProfile -File $hdo run -Pick `
  -RepositoryPath $repoPath -Repository $repo -DryRun -Json
```

pickup は eligible な Issue を priority、作成日時、Issue number の順で決定的に並べます。明示 `-Issue` でも open と `hdo:ready`、必須 section、validation gate の検証は省略されません。

## DryRun と NoWriteBack

| 動作 | 通常実行 | `-DryRun` | `-NoWriteBack` |
|---|:---:|:---:|:---:|
| GitHub / Issue の読み取り | yes | yes | yes |
| Issue 契約・設定・preflight | yes | yes | yes |
| AI runner の実行 | yes | no | yes |
| worktree / run artifact 作成 | yes | no | yes |
| validation / review / fix | yes | no | yes |
| claim comment / status label / assignee | yes | no | no |

`-NoWriteBack` は dry-run ではありません。コードを変更する full cycle であり、専用 worktree に未 commit の変更を残します。

## Cloud-only と Ollama hybrid

既定 [config/hdo.default.json](config/hdo.default.json) は全 step を Codex cloud runner へ割り当て、Ollama を probe しません。

Ollama hybrid の設定例では plan/review は cloud、implement/fix は Ollama です。

```powershell
$hybridConfig = 'C:\src\hybrid-dev-orchestrator\config\examples\ollama-hybrid.json'

pwsh -NoProfile -File $hdo config `
  -RepositoryPath $repoPath -Config $hybridConfig `
  -Profile ollama-hybrid -Json

pwsh -NoProfile -File $hdo doctor `
  -RepositoryPath $repoPath -Config $hybridConfig `
  -Profile ollama-hybrid -DryRun
```

一時的に step の runner だけを変える場合は、定義済み runner を指定します。

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo `
  -Config $hybridConfig -Profile ollama-hybrid `
  -SetStep implement=codex-ollama-implementer -DryRun -Json
```

provider/model の暗黙 fallback はありません。選択した runner が使えない場合、別 runner へ切り替えず preflight または当該 step で停止します。

## CLI

```text
help      CLI usage を表示
doctor    Git、gh auth、project contract、選択 runner/provider、保存先を検査
config    merge・profile 解決後の execution plan を表示
issues    pickup 候補を一覧
inspect   1件の Issue と正規化契約・validation result を表示
run       Issue の dry-run または full cycle を実行
status    artifact の run.json を読み取る
cleanup   明示した run の worktree を安全条件付きで除去
labels    label catalog の差分表示または同期
```

正確な構文は次で確認できます。

```powershell
pwsh -NoProfile -File $hdo help
```

## 成果物と cleanup

既定では次へ保存します。

- worktree: `%LOCALAPPDATA%\hdo\worktrees\<run-id>`
- artifact: `%LOCALAPPDATA%\hdo\runs\<run-id>`

run ID は実行結果に表示されます。

```powershell
pwsh -NoProfile -File $hdo status -RunId '<run-id>' `
  -RepositoryPath $repoPath -Json

pwsh -NoProfile -File $hdo cleanup -RunId '<run-id>' `
  -RepositoryPath $repoPath -Force -WhatIf
```

worktree には意図的に未 commit の変更が残るため、通常の cleanup は拒否されます。`final/diff.patch` と必要な新規ファイルを確認・退避した後だけ、`-Force` を付けて実行してください。cleanup 後も run artifact と作成済み branch は残ります。

## 安全境界

- implement/fix は現在の working tree ではなく専用 worktree だけを変更します。
- plan/review runner は `read-only`、implement/fix は `workspace-write` でなければ設定 validation に失敗します。
- GitHub token と名前が secret/token/password/API key に該当する環境変数は worker/validation process から既定で除外します。
- validation gate の working directory は worktree 内に限定し、junction/symbolic-link boundary を拒否します。
- 外部 process の stdout/stderr は各32 MiBで打ち切り、process tree を停止します。
- Issue、comment、外部リンクは untrusted input です。
- commit、push、PR、Issue close、merge、成果物の自動適用は行いません。
- cloud runner/reviewer を使うと Issue、関連コード、diff が cloud provider へ送信され得ます。

MVP の command adapter と validation command に対して、HDO 自身が OS firewall、任意 filesystem access の遮断、command interception を提供するわけではありません。信頼できない repository では low-privilege account、VM/container、runner sandbox、実行環境側の policy を構成してください。

## 詳細文書

- [要件](docs/requirements.md)
- [設定](docs/configuration.md)
- [アーキテクチャ](docs/architecture.md)
- [GitHub Issue 契約](docs/issue-contract.md)
- [レビュー基盤](docs/review-platform.md)
