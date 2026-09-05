# PowerShell 7 継続 vs TypeScript / Node.js 採用の評価

- 対象 Issue: #18（HDO の中長期 primary runtime を決定する）
- 関連 Issue: #15（WSL2 / Linux 正式対応）、#25（Windows cleanup の longpath 障害）
- 評価対象バージョン: HDO 0.3.0、PoC は `poc/typescript/`（本 branch 時点）
- 対応 AC: AC-01, AC-03, AC-06, AC-07, AC-08

## 1. 目的と評価方法

Issue #18 は、HDO の責務が単純な shell script を超えて成長した場合に、PowerShell 7 を primary runtime として維持すべきか、TypeScript / Node.js 24 へ移行すべきかを技術的根拠付きで決定することを求めている。リライトの完了は目的ではなく、比較・PoC・ADR による意思決定が目的である。

評価は次の3つの情報源に基づく。

1. 現行実装 `src/HybridDevOrchestrator/Private/*.ps1`、`hdo.ps1`、`tests/*.ps1` の実際のコードと関数名。
2. `poc/typescript/` に実装した最小 PoC（config merge、Ajv 2020-12 validation、bounded child process 実行、GitClient、State machine、Claude Code plugin 起動経路）と、Windows 実機・Ubuntu 24.04 (Docker) での実行結果（`results/*.json`, `results/*-test-output.txt`）。
3. `docs/architecture.md` / `docs/requirements.md` / `docs/configuration.md` に記載された契約。

評価しなかったもの（PoC の非目標。`poc/typescript/README.md` 「非目標」節）:

- GitHub API 連携（Issue pickup、claim、label 同期）。
- Codex / Claude 実 runner adapter（`codex exec` / `claude -p` の起動そのもの）。
- Workflow の全 orchestration（plan→implement→validate→review→fix loop の実行）。
- `.hdo/project.json` の validation gate 実行（trusted command 起動、exit class 判定）。
- 本番移行のコスト・スケジュールそのもの（ADR の「Migration strategy」で扱う）。

これらは「未実証」であり、本評価もその前提で判断している。

## 2. 現行 PowerShell 実装の実態

### 2.1 行数とモジュール構成

`wc -l` 実測（本 branch、テストコード込み）:

| ファイル | 行数 |
|---|---:|
| `src/HybridDevOrchestrator/Private/Common.ps1` | 803 |
| `src/HybridDevOrchestrator/Private/Configuration.ps1` | 584 |
| `src/HybridDevOrchestrator/Private/Git.ps1` | 224 |
| `src/HybridDevOrchestrator/Private/GitHub.ps1` | 697 |
| `src/HybridDevOrchestrator/Private/Runner.ps1` | 963 |
| `src/HybridDevOrchestrator/Private/State.ps1` | 95 |
| `src/HybridDevOrchestrator/Private/Workflow.ps1` | 544 |
| `hdo.ps1` | 157 |
| `workers/hdo-ollama-worker.ps1` | 447 |
| `tests/*.ps1`（`run-tests.ps1` 1023 行含む全10ファイル） | 2316 |
| **合計** | **6830** |

実装本体（`src/` + `hdo.ps1` + `workers/`）だけで約 4514 行、test harness を含めると 6830 行。「7k-line」という規模観はこの実測に基づく。

### 2.2 Test harness

`tests/run-tests.ps1`（1023行）は Pester 等の framework を使わず、`Assert-Hdo` という自前 helper（`Condition`/`Message` を受け取り pass/fail をカウント）でテストを記述する手書き harness である。`tests/test-suite.ps1`（22行）は `test-plugin.ps1`・`run-tests.ps1`・`test-process-output.ps1`・`test-cli.ps1`・`test-claude-contract.ps1`・`test-lean-worker.ps1` の6本をまとめて実行する。`test-schemas.ps1` は単体で実行するスクリプトであり `test-suite.ps1` には含まれず、CI（`test-suite.yml`）でも実行されない。GPU/Ollama 実 provider を要する `test-ollama-smoke.ps1` と `test-lean-worker-smoke.ps1` は `-Run` opt-in で通常 CI に含まれない。

### 2.3 既存のクロスプラットフォーム分岐と Windows-only assumption

`$IsWindows` を参照する箇所は現行コードに2箇所しかない。

- `src/HybridDevOrchestrator/Private/Git.ps1:37`（`Get-HdoComparableFullPath`）: 非 Windows では Win32 final-path resolution をスキップしてそのまま normalized path を返す。
- `src/HybridDevOrchestrator/Private/Git.ps1:175`（`Test-HdoPathWithinRoot`）: path 比較の大小文字区別を `$IsWindows` で `OrdinalIgnoreCase` / `Ordinal` に切り替える。

一方、次は Windows 前提のまま残っている。

- `src/HybridDevOrchestrator/Private/Configuration.ps1:179-180`（`Get-HdoConfig`）: `$env:APPDATA` を直接参照し、存在すれば `hdo/config.json` を読む。Linux/WSL2 では `APPDATA` が定義されないため、この user config source は静かに無効化される（fail ではなく単に読まれない）。
- `config/hdo.default.json:81-82`: `paths.worktreeRoot` / `paths.artifactRoot` の既定値が `%LOCALAPPDATA%/hdo/worktrees` 及び `.../runs` 固定。
- `src/HybridDevOrchestrator/Private/Common.ps1` 冒頭の `Add-Type` ブロック（`FinalPathResolver`、`BoundedProcessCapture`）は Win32 API（`GetFinalPathNameByHandleW`、`CreateJobObject`/`SetInformationJobObject`/`AssignProcessToJobObject`）への P/Invoke。`FinalPathResolver.Resolve` は非 Windows では `Path.GetFullPath` にフォールバックするが、`BoundedProcessCapture` の `KillOnCloseJob.TryAttach` は `RuntimeInformation.IsOSPlatform(OSPlatform.Windows)` が false なら単に Job Object を使わず何もしない（2.4 節参照）。
- Issue #25 が報告する `hdo cleanup` の `Filename too long` 障害は、`Remove-HdoRunWorktree`（`Git.ps1:179-224`）と `New-HdoWorktree`（`Git.ps1:87-116`）のどちらも `core.longpaths` を設定しないという Windows 固有の未対応から生じている。

つまり Issue #15 が指摘する残存 Windows 前提（`APPDATA`/`LOCALAPPDATA` 直参照、junction/symlink 境界検査の Linux 未検証、Job Object 依存の process 終了）は、現行コードの読解で裏付けられる。

### 2.4 Windows 依存が最も強い箇所: Job Object

`Common.ps1:128-180` の `BoundedProcessCapture.KillOnCloseJob` は `CreateJobObject` → `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`LimitFlags = 0x00002000`）を `SetInformationJobObject` で設定 → `AssignProcessToJobObject` で子プロセスを Job に割り当てる。この Job には breakaway フラグを一切設定していないため、直接の子プロセスだけでなくその子孫全員が同じ Job に含まれ、ハンドルを閉じる（`Dispose`）だけで全員を確実に終了させる。この保証は OS 機能そのものであり、「Node.js には Job Object 相当 API が無い」と表現するのは不正確である: libuv も `detached: true` を付けずに spawn した**直接の**子プロセスを、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`・`BREAKAWAY_OK`・`SILENT_BREAKAWAY_OK` を設定した、Node プロセスごとに1つのグローバル Job（全ての非 detached な直接の子が共有）に自動的に割り当てている。ただし `SILENT_BREAKAWAY_OK` が付いているため、Job メンバーがさらに生成した子プロセス（孫）は `detached` の指定に関わらず一切 Job に入らない。孫がホストと道連れになるのは中間プロセス自身も Node（libuv）である場合に限られ、`cmd.exe`・`pwsh`・`git`・`claude.exe`・`codex.exe` のような非 libuv の中間プロセスを挟むと連鎖は途切れる（実測: host → cmd → node の3階層で host を kill すると cmd は終了するが node は生存する）。HDO 側が実際に欠いているのは (a) timeout 発生時に明示的に close できる **per-child** の Job ハンドル、(b) 孫プロセスを Job のメンバーにする手段そのもの（`SILENT_BREAKAWAY_OK` により構造的に不可能で、`detached` を禁止しても解決しない）、の2点であり、この2点のせいで Windows Job Object 相当の確実性を失う（3.3節、PoC README「既知の制約」参照)。

## 3. 評価軸ごとの比較

### 3.1 Architecture / Maintainability

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| workflow / state machine の型表現 | `State.ps1`（95行）は文字列ベースの遷移表を `[ordered]` hashtable（`switch` は使わない）で保持し、実行時に検査する。コンパイル時の網羅性検査はない | `src/core/state/index.ts` は `RunState` を union type、`EXPLICIT_TRANSITIONS` を `Record<RunState, readonly RunState[]>` として定義し、TypeScript が全 state のキー網羅を型検査する（漏れがあればコンパイルエラー） | 同じ遷移表を PoC で再現できたが、TypeScript は「新しい state を追加して分岐を1つ忘れる」を型検査で検出できる点が実質的な差 |
| runner abstraction の拡張性 | `Runner.ps1`（963行）が codex/claude/command の分岐を `if/elseif` チェーンで持つ（`Invoke-HdoAgentStep`、472-698行目） | PoC は `ProcessRunner`/`PlatformAdapter` を interface として core に置き、実装を `platform/`・`process/` に分離。新 adapter 追加は新しい実装クラスを足すだけで済む形を実証した | PowerShell でも同型の抽象化は可能だが、言語機能として強制されない。TypeScript は interface 実装漏れをコンパイル時に検出する |
| module / package 境界の作りやすさ | PowerShell module は `.psd1`/`.psm1` の export 制御のみで、"internal からのみ import 可能" のような依存方向強制はできない | `src/core/boundary.test.ts` が「core が import してよい非相対 specifier は `node:path`/`ajv`/`ajv-formats` の allow-list のみ、相対 import は `src/core/` の外に出てはならない」ことをソーステキスト静的検査で機械的に強制する（deny-list ではなく allow-list 方式。`node:child_process`/`node:os`/`node:fs`/`../platform`/`../process`/`../git`/`../cli` はこの allow-list に無い一例に過ぎない。テストとして実行、違反すれば fail） | 現状は「テストによる強制」であり型システムそのものではない。PowerShell の現行コードにはこの検査を行うものは無いが、`Select-String` ベースの同種の静的検査や PSScriptAnalyzer custom rule で同等のことを実現するのは技術的には可能。TypeScript 側の実質的な優位は型検査と IDE のリファクタリング精度にある |
| large codebase 化した場合の保守性 | 6830行のスクリプト集合で、IDE support は変数・関数の静的解析に限定的（PSScriptAnalyzer は lint であり型検査ではない） | `tsconfig.json`（`strict: true`）と `tsc --noEmit` による型検査。IDE の go-to-definition/rename 精度が高い | 将来 GitHub App、複数 reviewer、DAG workflow などで module 数が増えるほど、型検査と機械的境界強制の複利効果は大きくなる |
| unit / integration test の書きやすさ | `tests/run-tests.ps1`（1023行）は framework なしの手書き `Assert-Hdo` helper。mocking や非同期テストの支援はない | `node:test`（`node --test`）が標準搭載。PoC は追加パッケージなしで80 test（`schemaFixtures.test.ts`、`boundary.test.ts`、`runner.test.ts` 等）を記述・実行した | Node は標準 test runner を持つ点で PowerShell より軽量。ただし PowerShell の現行 test も実際に動作しており「書けない」わけではない |
| static typing / refactoring support | `Set-StrictMode -Version Latest`（`hdo.ps1:26`）は未定義変数アクセス等を実行時に検出するのみで、コンパイル時型検査ではない | `strict: true` + `erasableSyntaxOnly` により、型不整合はビルド前の `tsc` で検出される | もっとも明確な非対称。PowerShell の型注釈は任意かつ実行時チェックのみ |

### 3.2 Cross-platform

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| Windows 11 | 正式対応（現行実装そのもの） | PoC を Windows 11（Node v24.19.0）で実行し80件中75 pass / 0 fail / 5 skip（`results/windows-test-output.txt`） | 両方とも動く。Windows 実行時の skip 5件は POSIX 専用ケース（`resolveToken` の POSIX フォールバック、`isReparsePointInPath` の POSIX symlink ケース、`isPathWithinRoot` の POSIX ルート `/` 向けケース3件） |
| WSL2 + Ubuntu | 未検証（Issue #15 のスコープ）。`$IsWindows` 分岐は存在するが Linux CI がない | 未検証。PoC の Ubuntu 実行は `ubuntu:24.04` コンテナ（Docker Desktop、WSL2 kernel）であり、ネイティブ WSL2 interop（`/mnt/c` 等）は検証していない | どちらの runtime でも WSL2 固有の検証は本 PoC・現行実装ともに未実施。4節で詳述 |
| native Linux + Ubuntu LTS | 未検証。CI は `windows-latest` のみ（`.github/workflows/test-suite.yml`） | PoC を `ubuntu:24.04` Docker コンテナ（Node v24.9.0）で実行し80件中72 pass / 0 fail / 8 skip（`results/ubuntu-test-output.txt`）。ただし `os.release()` が `5.15.167.4-microsoft-standard-WSL2` を返しており、ベアメタル Ubuntu ではなく Docker Desktop の WSL2 backend 上のコンテナである点に注意（4節） | 「ベアメタル Linux」はどちらの runtime でも未実証 |
| path handling | `Get-HdoNormalizedFullPath`/`Get-HdoComparableFullPath`（`Git.ps1:20-57`）が `.NET` の `Path.GetFullPath` を使う | `node:path` の `resolve`/`normalize`/`join` を使う。PoC の `PlatformAdapter.pathEquals` が Windows/POSIX で大小文字比較を切り替える（`windows.ts:106-108`, `posix.ts:71-77`） | 両者とも OS 標準ライブラリに委譲しており、実装量に大差はない |
| symlink / junction handling | `Test-HdoReparsePointInPath`（`Runner.ps1:756-779`）が `FileAttributes.ReparsePoint` を検査 | `PlatformAdapter.isReparsePointInPath`（`windows.ts:123-136`, `posix.ts:95-108`）が同等ロジックを実装し、PoC test で Windows junction・directory symlink・POSIX symlink の3ケースを実機検証した（`platform/index.test.ts`、boundary 内訳は結果ファイル参照）。root containment 側（`isPathWithinRoot`/`comparableFullPath`, `git/index.ts`）も `resolve` で `..` を先に畳んでから最深の実在祖先を realpath する形へ直し、traversal を拒否するテストを追加した（`git/index.test.ts` の `'..' traversal above root is rejected`、`a sibling directory that merely shares root as a string prefix is rejected` 等）。この realpath 正規化は最初の PoC 実装には無く、レビュー中に見つかった不具合として追加した | 検証範囲は同等。どちらも「起動前の point-in-time check」であり TOCTOU は残る（両実装のコメントで明記） |
| executable resolution | `Get-Command $Command`（`Common.ps1:718`）が PowerShell の provider 解決に依存 | `PlatformAdapter.resolveExecutable` を PoC で自前実装（Windows は `PATH`+`PATHEXT` 走査を `.exe`/`.com` のみに絞り込み、POSIX は `PATH`+実行ビット確認、`windows.ts:30-63`, `posix.ts:10-20`）。`probe` で実測: Windows は `C:\Program Files\Git\mingw64\bin\git.exe`、Ubuntu は `/usr/bin/git`（`results/windows.json`, `results/ubuntu.json`） | Node には `Get-Command` 相当の標準 API がなく、自前実装が必要だった（`windows.ts` 全体で159行）。加えて Windows 側は Node の `spawn()` が `shell: true` なしでは `.cmd`/`.bat` を起動できない（EINVAL, CVE-2024-27980）ため npm グローバルの `claude.cmd`/`codex.cmd` シムを解決できないという Node 固有のコストを負う（6節「no shell string / ArgumentList 分離」参照）。ただし PowerShell 側も無条件に有利ではない: `Invoke-HdoProcess` は `.cmd` の実パスを明示的に渡した場合は動く（`tests/run-tests.ps1:972` の `mock-claude.cmd` はこの経路で `Invoke-HdoAgentStep` から実行される）が、bare なコマンド名では `Get-Command npm` が `npm.cmd` より先に `npm.ps1` を解決してしまい、`Invoke-HdoProcess -Command npm` は実測で THROW する（`-Command npm.cmd` と明示すれば動く）。`config/hdo.default.json` の既定 `"command": "claude"` が今日動くのも native installer が shim ではなく `claude.exe` を提供しているからに過ぎない。差は『`.cmd` を明示すれば動く(PS)』vs『`.cmd` を渡しても EINVAL(Node)』に限られ、bare な npm-global shim の解決はどちらの実装でも成立しない |
| environment variable / user config path | `%APPDATA%`/`%LOCALAPPDATA%` 固定（2.3節） | PoC の `posix.ts:49-57`（`resolveToken`）が `LOCALAPPDATA`/`APPDATA` トークンを XDG (`XDG_DATA_HOME`) にフォールバックさせる設計を実証。実測: Windows `userConfigDir()` は `%APPDATA%`、Ubuntu は `~/.config`（未設定時） | Node 版 PoC はこの fallback を最初から作り込んでいるが、`resolveToken` は `LOCALAPPDATA` と `APPDATA` のどちらも `defaultDataDir()`（`XDG_DATA_HOME`）へ寄せており、`userConfigDir()`（`XDG_CONFIG_HOME`）とは別系統になっている。`APPDATA`（config 用）を data dir にマッピングするのは本来疑わしく、本番では `XDG_CONFIG_HOME` に振り分けるべき（`posix.ts:49-57` 内の分岐は本番移行時に見直しが必要）。PowerShell 側は同等の fallback をこれから実装する必要がある（Issue #15 の scope） |
| process / process-group lifecycle の OS 差分 | `KillOnCloseJob`（Windows Job Object）に加え、非 Windows では `KillTree`（`Common.ps1:301-304`、`Process.Kill(entireProcessTree: true)`、.NET の cross-platform API）を実装済み。ただし Linux での実機検証はない | PoC は Windows で `taskkill /T /F /PID`、POSIX で `detached: true` + `process.kill(-pid, 'SIGKILL')` を使い分け（`windows.ts:114-121`, `posix.ts:83-93`）。実機で timeout 時に process tree 全体が停止することを test で検証（`runner.test.ts` の `timeout terminates the whole process tree`）。ただし Windows では孫プロセスは `detached` の指定に関わらず `SILENT_BREAKAWAY_OK` により libuv の Job に一切含まれないため、直接の子が既に exit した後（孤児化した後）では `taskkill /T` が辿る生きた根を失い、孫が生き残ることがある（3.3節参照） | Node へ移行しても Windows/POSIX の process 差分は消えない、という Issue #18 前提のとおり。Node 側は両OSで動く経路を実装したが、Windows 側は taskkill であり Job Object の確実性は持たない（3.3節で詳述） |

### 3.3 Process Orchestration

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| stdin / stdout / stderr streaming | `Invoke-HdoProcess`（`Common.ps1:700-803`）が `ProcessStartInfo` の non-blocking pipe を C# `BoundedProcessCapture.CaptureAsync` で読む | `NodeProcessRunner.run`（`process/runner.ts`）が `child.stdout`/`child.stderr` の `data` event を都度 append する。主たる待機対象は `exit`（`close` ではない）で、`close` が未到達なら `outputDrainSeconds`（既定2秒）だけ追加で待ってから諦める（F-02。以下 `F-`/`G-`/`H-` は PoC README で採番した PoC 内 finding ID） | 両者とも stream 実装。数値契約と挙動の一致範囲は下記「bounded output capture」「timeout / cancellation」および6節「process timeout / output limit」参照 |
| bounded output capture | `MaximumOutputBytes`（既定 33554432 = 32 MiB）超過で `LimitExceeded` → process 終了、`OutputTailBytes`（既定 65536 = 64 KiB）だけ tail 保持（`Common.ps1:700-716`, C# `BoundedProcessCapture`） | `BoundedCapture` class（`runner.ts:36-77`）が同じ 32 MiB / 64 KiB既定値でリングバッファ tail を実装し、超過時に `killTree()` を呼ぶ（`runner.ts:357-366` の `maybeEnforceLimit`） | PoC は PowerShell の数値契約をそのまま再現。テスト `enforces bounded stdout and retains only a diagnostic tail once truncated` で実測検証済み |
| timeout / cancellation | `TimeoutSeconds`（1-86400）超過で exit code 124（`Common.ps1:706,772`） | `options.timeoutSeconds` 超過で `terminationReason: "timeout"` → exit code 124。同じ仕組みで `outputLimit`→125、`inputError`→126、`captureError`→127 も単一の `terminationReason` として確定する（最初に確定した原因が勝ち、以後は上書きしない。`types.ts` の `TerminationReason` コメント、`runner.ts` の `exitCodeFor`） | 数値契約は一致（124/125/126/127、drain 2秒）。生きた process tree に対する timeout kill はテスト済み（`timeout terminates the whole process tree`）。詳細は6節「process timeout / output limit」 |
| child process / process tree termination | Job Object（Windows、`Common.ps1` の `KillOnCloseJob`）。非Windows側も `KillTree`（`Common.ps1:301-304`、`Process.Kill(entireProcessTree: true)`、cross-platform な .NET API）で実装済みだが、Linux での実機検証はない | Windows: `taskkill /T /F /PID`。POSIX: `detached` process group + `process.kill(-pid, ...)`。両方とも「孫プロセスの再親化」に対して脆弱（PoC README「既知の制約」に明記）。さらに Windows では孫プロセスは `detached` の指定に関わらず `SILENT_BREAKAWAY_OK` により libuv の Job に一切含まれないため、`taskkill /T /F` が唯一孫へ到達できる手段であるにもかかわらず、直接の子が既に exit して孤児化した孫にはその生きた根が無く届かない。実際に PowerShell 側の非 breakaway な孫プロセス fixture（`tests/fixtures/runtime/hold-output-handle.ps1`、.NET `Process.Start` で生成、libuv の Job とは無関係）を PoC の runner に通すと 127（`outputDrainTimedOut: true`）で孫が生存したまま返り、同じ fixture を PowerShell 本体で実行すると exit 0 かつ孫は終了する（`tests/test-process-output.ps1`。`runner.test.ts` の `bounded output drain: a surviving detached grandchild does not block the result` は PoC 自身の `detached: true` fixture でこの生存を確認したもの） | **Node へ移行しても Windows の確実な process tree kill は後退する。** PowerShell の `KillOnCloseJob` は明示的な Job ハンドルを close するだけで breakaway していない子孫を確実に終了できるのに対し、PoC の bounded drain は `outputDrainSeconds` 分の遅延で呼び出し側をアンブロックするだけで孫プロセスの解放は保証しない。Job Object 相当を得るには native addon か外部ツールが必要（proposal 9節・ADR「Consequences」で扱う） |
| signal handling | PowerShell 側の `Ctrl+C`/`STOP` 伝播は明示実装なし（未確認） | Node の `process.on('SIGINT'/'SIGTERM')` は標準だが、PoC はこれを実装・検証していない（未実証） | 双方とも daemon 化時の signal 設計は post-MVP。proposal 9節「Open questions / risks」で扱う |
| environment filtering | `Get-HdoSafeEnvironment`（`Common.ps1:666-684`）が `GH_TOKEN`/`GITHUB_TOKEN`/`ANTHROPIC_API_KEY` 等の固定 blocklist と `(?i)(TOKEN\|SECRET\|PASSWORD\|API_KEY)$` 正規表現で除外。実際に配線済み: agent step（`Get-HdoRunnerEnvironment`、`Runner.ps1:337`）、command runner（`Runner.ps1:407`）、validation gate 実行（`Runner.ps1:831`）の3箇所すべてがこの関数を経由する。唯一の例外は `Invoke-HdoGit` で、この関数を経由せず呼び出し元環境をそのまま継承する | PoC は同じ deny-list（固定名 + 同一正規表現）を `getSafeEnvironment()`（`core/process/safeEnvironment.ts`）として pure 関数に移植し単体テスト済みだが、`doctor`/`probe`/`GitClient` のどこからも呼び出していない（F-09）。`GitClient.exec` も今も呼び出し元プロセスの環境をそのまま継承する。`ProcessRunOptions.env` を明示指定した場合は「その内容だけ」を渡す設計だが、Windows では libuv が `HOMEDRIVE`/`HOMEPATH`/`LOGONSERVER`/`PATH`/`SYSTEMDRIVE`/`SYSTEMROOT`/`TEMP`/`USERDOMAIN`/`USERNAME`/`USERPROFILE`/`WINDIR` を無条件に追加注入する（`explicitEnvExtraKeys`: Windows 11件、`results/windows.json`）。POSIX はこの注入がない（`explicitEnvExtraKeys: []`、`results/ubuntu.json`）。.NET `ProcessStartInfo.Environment.Clear()` は何も注入せず、与えた変数（実測: `MARKER`/`SYSTEMROOT` の2つのみ）だけがそのまま子プロセスに渡る。`SYSTEMROOT` を欠いた状態で `node` を起動すると CSPRNG の初期化 assertion に失敗して exit 134 になる。`Invoke-HdoProcess` はこの `Clear()` を `-Environment` を明示指定した場合にのみ呼ぶ（`Common.ps1:733-736`）。指定しなければ呼び出し元の環境をそのまま継承する | PowerShell は runner/validation 起動で配線済み、Git のみ未配線。PoC はどこにも配線していない。Windows の明示 env は「呼び出し元が書いた変数」+「libuv が足す固定11変数」であり、純粋な allow-list としては不完全（この点は両実装とも未実装） |
| working directory isolation | `WorkingDirectory` を `ProcessStartInfo.WorkingDirectory` に設定、`Invoke-HdoValidation`（`Runner.ps1:781-870`）が worktree 外・junction/symlink 境界を検査 | `ProcessRunOptions.cwd` を `spawn` の `cwd` に設定。PoC の `GitClient.isContainedWorktree`（`git/index.ts:98-102`）が root 内包含チェックを実装し test 済み。gate 実行そのものは未実装（PoC 非目標） | 境界検査ロジックの型は再現したが、`.hdo/project.json` の gate 実行という統合部分は未実証 |

Node.js へ移行しても Windows/POSIX の process 差分そのものは解消しない、という Issue #18 前提はこの PoC でも成立する。差分は「別の言語で書き直しても残る」が、`platform/` 配下に閉じ込める設計自体は TypeScript でも PowerShell と同様に機械的に実証できた。

### 3.4 CLI / Distribution

配布・起動方式の詳細な trade-off は5節の表にまとめる。ここでは `hdo doctor` / `hdo run --issue 123` 相当の標準 CLI としての比較のみ述べる。

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| 起動コマンド | `pwsh -File hdo.ps1 doctor` | `node src/cli/main.ts doctor`（ビルド不要、Node のネイティブ type stripping） | Node 22.18/23.6 以降は `--experimental-strip-types` フラグ無しで `.ts` を直接実行できる（`package.json` の `"cli": "node src/cli/main.ts"`、実測: Windows Node v24.19.0、Ubuntu Node v24.9.0） |
| 実行前提 | `pwsh` 7.2+ の別途導入（Windows 11 は Windows PowerShell 5.1 のみ同梱） | `node` 24 の別途導入（両OSともプリインストールなし） | 「ランタイム導入が要らない」はどちらの側の優位でもない。Windows は winget/MSI/Store、Node は nodejs.org installer/winget/nvm を使う |
| 単一バイナリ化 | 存在しない（`pwsh` 本体が前提） | Node SEA は experimental（bundling必須、~100MB、platform 別ビルド、署名要考慮）。`bun build --compile` の方が実務的に成熟（8節） | どちらの runtime も「1ファイル配布」は弱いが、Node/Bun エコシステムには複数の選択肢がある |

### 3.5 Ecosystem / Future Expansion

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| MCP | 公式 SDK なし。PowerShell から MCP server/client を実装する一次情報源がない | `@modelcontextprotocol/sdk`（TypeScript）と Python SDK はどちらも公式・対等な位置づけだが、TypeScript SDK がプロトコルの reference implementation である | PowerShell には公式 SDK の選択肢自体がなく、ロードマップにある MCP 対応を見据えると TypeScript が明確に有利 |
| GitHub App | REST/GraphQL 呼び出し自体は `gh` CLI 経由で両方可能。ただし公式 Octokit / GitHub App 向け SDK エコシステムは JS-first | `@octokit/*` 一式、webhook 検証、JWT 署名ライブラリが充実 | 将来 GitHub App 化する場合、TypeScript の方がライブラリ調達コストが低い |
| Web API / Web UI | PowerShell で HTTP server framework を書くことは可能だが実例が薄い | Node の HTTP server エコシステム（Express、Fastify、標準 `node:http`）が豊富 | 将来 Web UI/API を追加する場合の初期コストが低い |
| parallel agents / daemon / scheduler | PowerShell の非同期処理は `Start-Job`/runspace 等があるが、event loop ベースの並行 I/O とは設計思想が異なる | Node の event loop は多数の I/O 待ち child process を扱う設計と親和的 | 複数 reviewer・並列 agent を見据えると Node のモデルが素直 |
| OpenAI-compatible provider 追加 | `Invoke-HdoProcess` ベースの command runner で追加可能（現状もこの形） | 同様に `ProcessRunner`/adapter 追加で対応可能 | 両者とも既存の adapter 抽象化で吸収でき、この観点での差は小さい |

### 3.6 Security

Security の詳細な境界別確認は6節にまとめる。ここでは総括のみ述べる。

| 観点 | PowerShell 7 | TypeScript / Node.js 24 | 所見 |
|---|---|---|---|
| 実装済み境界の再現性 | 稼働中の実装（`Get-HdoSafeEnvironment`, `Test-HdoReparsePointInPath`, `Invoke-HdoValidation` 等）ですべて実証済み | PoC は `argv` 分離起動（`shell: true` を一切使わない）、secret redaction（`redact.ts`）、bounded output、junction/symlink 検査、worktree 封じ込めを実証。GitHub 連携・runner adapter・validation gate 実行は未実証 | TypeScript でも同種の防御は原理的に再現可能だが、本番相当のカバレッジはまだ無い（未実証部分は本番移行の作業そのもの） |
| supply chain | PowerShell module に外部依存なし（`Add-Type` はインライン C#、.NET BCL のみ） | 直接依存は `ajv`/`ajv-formats` の2つ（`package.json`）。ただし推移的依存を含めると `package-lock.json` に記録された実行時 package は6個（`ajv`, `ajv-formats`, `fast-deep-equal`, `fast-uri`, `json-schema-traverse`, `require-from-string`）。`npm ci --ignore-scripts` は npm install 時の lifecycle script（`postinstall` 等）実行だけを止める運用であり、実行時に読み込まれるコード自体の量は変わらない | PowerShell は依存ゼロという明確な優位を持つ。TypeScript は直接依存を1ライブラリ（Ajv）に抑える方針を PoC が実証しているが、supply chain surface は「直接2・推移的込み6 package」で評価すべきで、`--ignore-scripts` はその surface を縮小しない |

## 4. OS 差分の整理（AC-03）

`probe --json` で実測した値（`results/windows.json`, `results/ubuntu.json`）。

| 項目 | Windows 11 (Node v24.19.0) | Ubuntu 24.04 (Docker, Node v24.9.0) |
|---|---|---|
| `path.sep` | `\` | `/` |
| `path.delimiter` | `;` | `:` |
| 一時ディレクトリの大文字小文字区別 | 区別しない | 区別する |
| `git` 実行可能ファイルの解決 | `C:\Program Files\Git\mingw64\bin\git.exe` | `/usr/bin/git` |
| `PATHEXT` | `.COM;.EXE;.BAT;.CMD;.VBS;...` | 存在しない（`null`） |
| `userConfigDir()` | `C:\Users\<user>\AppData\Roaming` | `~/.config`（`XDG_CONFIG_HOME` 未設定時） |
| `defaultDataDir()` | `C:\Users\<user>\AppData\Local` | `~/.local/share`（`XDG_DATA_HOME` 未設定時） |
| process tree 終了方式 | `taskkill /T /F /PID`（PoC の timeout kill は Job Object を明示的に制御しない。libuv の process-wide Job は Node 本体終了時のみ効き、per-child の明示 close はできない） | `process.kill(-pid, 'SIGKILL')`（`detached: true` の process group） |
| `process.kill(-pid, ...)` | 非対応 | 対応 |
| `os.EOL` | `"\r\n"` | `"\n"` |
| 8.3 短縮名パスと Git 出力の比較 | GitHub-hosted runner の `%TEMP%` は `C:\Users\RUNNER~1\...`。`git worktree list` は `C:/Users/runneradmin/...` を返すため文字列比較は不一致。`realpathSync.native` で final path に展開して比較する（`GitClient.worktreePathEquals`。PS 版 `Get-HdoComparableFullPath`（`Git.ps1:33-57`）と同じ対策。本 PR の初回 CI 実行で顕在化し修正） | 該当なし |
| symlink 作成 | 成功（Developer Mode/権限あり環境。EPERM で失敗する環境もあり得る） | 成功 |
| junction / directory symlink 検知 | 検知成功（`mklink /J`、`fs.symlinkSync(..., 'dir')` 双方をテスト） | 該当なし（symlink のみで検証、成功） |
| 環境変数の個数 | 100（開発機実測） | 6（最小コンテナ） |
| `PATH` と `Path` の扱い | 同一キー扱い（大小文字区別なし） | 別キー（`Path` は未定義） |
| `os.release()` | `10.0.26200` | `5.15.167.4-microsoft-standard-WSL2` |

テストスイートは両OSで合計 **80件、0 fail**。Windows は **75 pass / 5 skip**（POSIX 専用ケース5件 - `resolveToken` の POSIX フォールバック、`isReparsePointInPath` の POSIX symlink ケース、`isPathWithinRoot` の POSIX ルート `/` 向けケース3件（H-03 で追加した「`/` は `/` 自身の内側ではない」ケースを含む） - を skip）、Ubuntu は **72 pass / 8 skip**（Windows 専用ケース8件 - junction 検知、directory symlink 検知、`resolveExecutable('npm')` の `.exe`/`.com` 限定解決、`.cmd` 直接起動時の EINVAL→127 変換（以上4件）、および `comparableFullPath`/`isPathWithinRoot` のドライブルート `C:\` 向けケース4件（H-03 で追加した「`C:\` は `C:\` 自身の内側ではない」ケースを含む） - を skip）。skip の組は完全に相補的（`results/windows-test-output.txt`, `results/ubuntu-test-output.txt`）。

executable resolution はどちらの OS も `PlatformAdapter.resolveExecutable` に抽象化され（`platform/windows.ts`, `platform/posix.ts`）、path 差分は `PlatformAdapter.pathEquals`/`isReparsePointInPath` に閉じ込められている。PowerShell 側も `Get-HdoComparableFullPath`/`Test-HdoReparsePointInPath`（`Git.ps1`, `Runner.ps1`）で同種の抽象化を持つため、この観点では両実装とも「OS差分を限定領域に閉じ込める」という設計方針そのものは達成している。

**残存リスク（未実証）**: `results/ubuntu.json` の実行環境は `ubuntu:24.04` コンテナを Docker Desktop（WSL2 backend）上で動かしたものであり、`os.release()` が `5.15.167.4-microsoft-standard-WSL2` を報告している。すなわち「ベアメタル Ubuntu」ではなく WSL2 kernel 越しの値である。CI の `poc-typescript.yml` が使う `ubuntu-latest` も GitHub Actions のホスト型 VM であり、ネイティブ Ubuntu ハードウェアそのものではない。WSL2 の Windows-host 相互運用パス（`/mnt/c/...` 経由でのファイルアクセス、Windows 側プロセスとの連携）はこの PoC・現行 PowerShell 実装のどちらでも検証していない。

## 5. CLI 配布の trade-off（AC-06）

| 方式 | 前提 runtime | install 手順 | offline 実行 | 更新方法 | plugin からの呼び出し | security surface | 成熟度 |
|---|---|---|---|---|---|---|---|
| (a) `pwsh -File hdo.ps1`（現行） | `pwsh` 7.2+ | winget/MSI/Store で `pwsh` を導入 | 可（`pwsh` があれば追加取得なし） | repository を `git pull` するだけ | `commands/run.md` が `pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1"` を直接呼ぶ（実装済み） | 外部依存ゼロ、.NET BCL のみ | 本番稼働中 |
| (b) npm package + `bin`（repository-local, `npm ci`） | `node` 24+ を PATH に | `git clone` 後 `npm ci` を1回実行 | 可（`npm ci` 済みなら追加通信なし） | `git pull` + 必要なら `npm ci` 再実行 | plugin から `node <path>/main.ts` を呼ぶだけで動作を実証済み（`plugin-surface/hdo-poc-doctor.md`, `results/plugin-surface-windows.md`） | `package-lock.json` 固定、`npm ci --ignore-scripts` 可能。ただし `ajv`/`ajv-formats` という外部依存が新たに増える | PoC で実証済み（doctor/probe が実際に動作） |
| (c) 全域 `npm i -g` | `node` 24+ + npm global install | `npm i -g hdo` 相当 | install 時のみ通信要 | `npm update -g` | 未検証（PATH 解決や version 固定の挙動は未確認） | global install はバージョン混在・supply chain 露出面が repository-local より広い | 未実証 |
| (d) Node SEA / `bun build --compile` | 単一 native binary（配布先には runtime 不要） | 実行ファイルを配置するだけ | 可 | 実行ファイル差し替え | 未検証 | 署名・配布物の改ざん検知が新たな検討事項になる | Node SEA は experimental（bundling必須、~100MB、platform別ビルド、コード署名の考慮要）。`bun build --compile` の方が実務上こなれている（8節） |
| (e) plugin-root 経由（`${CLAUDE_PLUGIN_ROOT}`, PoC の `plugin-surface`） | `node` 24+ を PATH に | plugin install（`.claude-plugin/plugin.json` 経由）＋ checkout 内で `npm ci` | (b)と同じ | plugin バージョン更新と同じ | **実証済み**: `commands/doctor.md` 相当の command body invocation、`bin/hdo-poc`（POSIX）、`bin/hdo-poc.cmd`（Windows）の3経路すべてを Windows で実行し exit 0（`results/plugin-surface-windows.md`）。呼び出し元 cwd に依存しないことも実証（`/tmp/hdo-poc-cwd-test` から実行して成功） | (b) と同じ | PoC で実証済み。ただし **現行 `.claude-plugin/plugin.json`/`.codex-plugin/plugin.json` にはこの経路は登録されていない**（`poc/typescript/plugin-surface/hdo-poc-doctor.md` 冒頭のコメントに明記の通り、Issue #18 検証専用の artifact） |

Claude Code CLI 自体は npm 配布の Node.js アプリケーションで、native install（プラットフォーム別バイナリ）は Bun でコンパイルされている（手元の `claude.exe` に Bun 1.4.1 / JavaScriptCore のマーカーを確認）。どちらの配布形態も **plugin から呼ばれるサブプロセスに `node` を PATH へ渡す保証はない**。Codex CLI は Rust 製で何もバンドルしない。したがって「plugin からは Node が無料で手に入る」という前提は成立せず、(b)/(e) はいずれも呼び出し先ホストに `node` 24+ が PATH 上に存在することを前提とする。PoC の doctor（`src/cli/doctor.ts:10-19`）は Node バージョンチェックをこの前提の検査として実装しているが、これが検査できるのは「起動できた Node が 22.18 以上か」だけであり、`node` が PATH に無いケースそのものは検出できない（`doctor` 自身が Node 上で動くため、node が無ければプロセス起動自体が失敗し、doctor のどの check にも到達しない）。

package manager については PoC は npm + `package-lock.json` を使っている。pnpm（strict な `node_modules`、content-addressable store）も本番移行時の選択肢として成立するが、lockfile 形式が npm と別になる（`pnpm-lock.yaml`）ため、本 PoC では評価していない。この選択は決定を左右する差ではない。

## 6. Security boundary の項目別確認（AC-07）

`docs/architecture.md` 14節および Issue #18 の Security 節に列挙された境界を1行ずつ確認する。

| 境界 | PowerShell 実装（function） | TypeScript での実現 | 備考 |
|---|---|---|---|
| Issue/comment を untrusted input として扱う | `ConvertTo-HdoIssueContract`（GitHub.ps1、prompt生成側で明示区切り） | 未実証（PoC は GitHub 連携を実装していない） | 設計上可能（prompt 組み立て層の責務であり runtime 非依存）だが本 PoC では検証していない |
| secret / token / credential filtering | `Get-HdoSafeEnvironment`（`Common.ps1:666-684`、固定 blocklist + 正規表現）、`Protect-HdoText`/`Protect-HdoObject`（stdout/stderr/JSON の redaction） | PoC で実証: `redactSecrets`/`redactObject`（`src/core/process/redact.ts`）が同種の正規表現（`ghp_`/`github_pat_`/`sk-ant-`/`sk-proj-`/`xox[baprs]-`、`(TOKEN\|SECRET\|PASSWORD\|API_KEY)` 系キー）でテキスト・オブジェクト両方を redact する。`NodeProcessRunner.run` は返却前に必ず `redactSecrets` を通す（`runner.ts:155-156` の `finalize`）。`Get-HdoSafeEnvironment` の deny-list 自体も `getSafeEnvironment()`（`core/process/safeEnvironment.ts`）として pure 関数に移植・単体テスト済み | environment の deny-list（`getSafeEnvironment`）は移植済みだが `doctor`/`probe`/`GitClient` のどこからも呼び出されていない（F-09）。redaction（出力テキスト側）は配線済み、environment filtering（入力環境側）は未配線、という非対称が残る |
| validation working directory boundary | `Test-HdoPathWithinRoot`/`Test-HdoReparsePointInPath`（`Git.ps1:167-177`, `Runner.ps1:756-779`） | 実証済み: `PlatformAdapter.isReparsePointInPath`（`windows.ts:123-136`, `posix.ts:95-108`）と `GitClient.isContainedWorktree`（`git/index.ts:98-102`）が同種のロジックをテスト付きで再現。root containment 側の `isPathWithinRoot`/`comparableFullPath`（`git/index.ts:131-187`）は `resolve()` で `..` を先に代数的に畳んだ上で、最深の実在祖先を `platform.realPath` で解決してから比較する形にしており、traversal を拒否するテストが揃っている（`git/index.test.ts` の `'..' traversal above root is rejected even when the target does not exist`、`a sibling directory that merely shares root as a string prefix is rejected`、`a candidate equal to root itself is rejected` 等）。ただし `.hdo/project.json` の gate 実行文脈での適用（`Invoke-HdoValidation` 相当）は未実装 | この realpath 正規化は PoC の最初のバージョンには無く、存在しない候補パスに対して未解決の `..` 付き文字列をそのまま比較していた不具合をレビュー中に発見・修正したもの（率直に言えば「PoC が教えてくれた」修正）。ロジックの型は実証済みだが、gate 実行に組み込んだ統合検証は未実施 |
| repository 外 artifact / worktree | `Test-HdoConfiguration`（`Configuration.ps1:333-357`、worktreeRoot/artifactRoot が repositoryPath 外かつ非重複であることを検査） | 未実証（PoC は config の schema validation のみで、この cross-field semantic rule は移植していない） | 設計上可能（`deepMergeConfig` 後の追加検証関数として実装できる）が未実装 |
| runner sandbox contract | `Test-HdoConfiguration`（`Runner.ps1`外, `Configuration.ps1:441-450`、plan/review=read-only、implement/fix=workspace-write の強制） | 未実証（PoC は runner adapter 自体を実装していない） | 未実証 |
| validation command は trusted project contract だけから解決する | `Invoke-HdoValidation`（`Runner.ps1:781-870`）が `ProjectContract.validationGates` から `gateId` を解決し、Issue 側が指定できるのは既存 gate の ID のみ | 未実証（PoC は GitHub 連携・validation gate 実行のどちらも実装していない） | 未実証（PoC 非目標） |
| GitHub token の runner opt-in を拒否する | `Test-HdoConfiguration`（`Configuration.ps1:268-501`、`passEnvironment` に `GH_TOKEN`/`GITHUB_TOKEN` が含まれる場合を拒否、`Configuration.ps1:486`） | 未実証（PoC は runner 設定の semantic validation を実装していない） | 未実証（PoC 非目標） |
| no implicit fallback / no model auto-pull | `Test-HdoConfiguration`（`Configuration.ps1:455-456`、runner が `fallback` を宣言すると error）。model auto-pull はそもそも実装しない設計（README） | 未実証（PoC は runner adapter・model 選択ロジックを実装していない） | 未実証（PoC 非目標） |
| model output を直接 GitHub command にしない | `Protect-HdoGitHubText`（`GitHub.ps1:598-606`、`<!--`/`-->`/`@` をエスケープしてから comment に書き込む） | 未実証（PoC は GitHub 連携を実装していない） | 未実証（PoC 非目標） |
| process timeout / output limit | `Invoke-HdoProcess`（`Common.ps1:700-803`、32 MiB / 64 KiB既定、timeoutSeconds 1-86400、exit code 124） | exit code の数値そのもの（124/125/126/127）と drain 2秒は一致するが、導出方法とテスト済み範囲は異なる。PowerShell は固定の優先順位チェーン（`Common.ps1:772`: timeout(124) > outputLimit(125) > inputError(126) > captureError(127) > 実終了コード、`Common.ps1:375-376` の post-hoc back-fill を含む）で決めるのに対し、PoC は `terminationReason` に**最初に確定した原因**を記録し以後上書きしない先着順（`types.ts`、`runner.ts` の `setTermination`）。テストで一致を確認できたもの: 正常終了・出力上限超過(125)・出力捕捉失敗(127, stdout path がディレクトリ)・timeout(124)。126 は PoC 側のみテスト済みで、PowerShell の 126 パスは未テストかつ実測で非決定的だった（126/3/3）。spawn 失敗（コマンドが見つからない）は PowerShell が例外を throw する（`Common.ps1:718-719`）のに対し PoC は値として 127 を返すため、この点は**不一致**。複数の終了原因が同時に発生した場合も PowerShell は固定優先順位で1つを選ぶのに対し PoC は先着順であり、両者は一致しない | 挙動が異なるもう一つのケース: 孫プロセスが出力 handle を握ったまま直接の子が終了するケース。PowerShell 版の非 breakaway な孫プロセス fixture（`tests/fixtures/runtime/hold-output-handle.ps1`、.NET `Process.Start` で生成した孫。libuv の Job には無関係）を実行すると、Windows は breakaway フラグ無しの `KillOnCloseJob`（`Common.ps1:128-180`）が孫プロセスごと確実に終了させ exit 0 になる（`tests/test-process-output.ps1`）。同じ fixture を PoC の `NodeProcessRunner` に通すと、孫プロセスは `SILENT_BREAKAWAY_OK` により最初から libuv の Job に入っておらず（`detached` の指定とは無関係）、直接の子が既に exit した後は `taskkill /T` が辿る生きた根が無いため孫は生き残ったまま 127（`outputDrainTimedOut: true`）を返す。最初の PoC 実装はこのシナリオで timeout そのものが強制されず（`close` 待ちで 15 秒ハングする）不具合だったものを、`exit` 待ち + bounded drain（F-02）へ修正して直したのが現状。「一致」ではなく「一部挙動は異なり、修正後に残る gap は detached breakaway に限らずあらゆる孫プロセスに及ぶ、より広いもの」が正確な要約 |
| commit / push 等の禁止 policy | `.hdo/project.json` の `workerPolicy.allowCommit/allowPush`（policy宣言）＋ worktree 運用そのもの（agentはcommitしない前提） | 未実証（PoC は worker 実行そのものを行わない） | 未実証。ただし HDO の防御は「worker に commit させる runner 呼び出しをしない」という orchestration 層の設計によるものであり、runtime 言語に依存しない |
| path traversal / symlink escape 対策 | `Test-HdoReparsePointInPath`（上記） | 実証済み（上記「validation working directory boundary」と同一。realpath 正規化と traversal 拒否テストを含む） | — |
| no shell string / ArgumentList 分離 | `ProcessStartInfo.ArgumentList.Add`（`Common.ps1:732`）、`Invoke-Expression` 不使用 | 実証済み: `spawn(options.command, options.args, ...)`（`runner.ts:251`）は常に argv 配列。`shell: true` は PoC 全体で一度も使用していない（`windows.ts` コメントで明記）。この設計の帰結として、`resolveExecutable` は `.exe`/`.com` のみを解決し、npm グローバルの `.cmd`/`.bat` シム（`claude`/`codex` 等）は `shell: true` なしでは spawn できない（EINVAL, CVE-2024-27980） | 両実装とも shell 文字列を経由しない設計を確認。`.cmd`/`.bat` を明示パスで渡した場合に限り PowerShell の `Invoke-HdoProcess` は実行できるが、bare コマンド名での npm-global shim 解決（`claude`/`codex` 等）はどちらの実装でも成立しない（3.2節「executable resolution」参照） |
| dangerous flag rejection | `Test-HdoConfiguration`（`Configuration.ps1:464-474`、`danger-full-access`/`dangerously-bypass`/`dangerously-skip`/`--search` 等を正規表現で拒否） | 未実証（PoC は runner 設定の semantic validation を実装していない） | 未実証。ただし Ajv schema 自体は移植可能（`hdo-config.schema.json` は無編集で PoC でも validate 成功、`schemaFixtures.test.ts`） |
| repository config 制限付き schema | `Merge-HdoRepositoryConfig`/`Assert-HdoRepositoryRoutingSafety`（`Configuration.ps1:69-136`、command runner 追加禁止、runner type 固定） | 未実証（PoC は repository config の自動読込・snapshot binding を実装していない） | 未実証。`schemas/hdo-repository-config.schema.json` 自体の Ajv 検証は `SCHEMA_BY_FIXTURE_PREFIX` に含まれ実証済みだが、merge 時の semantic rule は未移植 |
| worktree snapshot 再照合 | `Assert-HdoRepositoryConfigSnapshot`（`Configuration.ps1:138-154`、blob/SHA-256 再比較） | 未実証 | GitHub 連携・repository config 自動読込のどちらも PoC 非目標のため未評価 |
| GitHub API 経由の claim/label/actor 検証 | `GitHub.ps1`（697行、`trustedActors`、`author_association` 検証等） | 未実証（PoC 非目標） | 未実証 |

総括: PoC が実証したのは「process 起動・出力・redaction・path 境界」という**runtime/OS 直結の低レイヤ**の再現性であり、ここは高い確度で TypeScript でも同等以上の実装が可能と言える。一方「configuration の cross-field semantic validation」「GitHub 連携」「runner adapter 統合」「repository config の trust boundary」は**HDO 固有のドメインロジック**であり、これらは言語を問わず本番移行時に新規実装が必要な作業であって、PoC の非目標として最初から範囲外にしている。

## 7. Python 短評（AC-08）

Python は Issue #18 の比較対象に含めてよいが第一候補にはしない、という前提のもとで短く評価する。

| 観点 | Python |
|---|---|
| JSON Schema / 型 | `pydantic` + `jsonschema` で同等のバリデーションは可能 |
| プロセス実行 | `asyncio.subprocess` で bounded capture・timeout は実装可能 |
| CLI 配布 | `uv`、`PyInstaller` はあるが、Node/npm エコシステムと比べて「plugin から呼ばれる CLI」としての配布の枯れ具合に明確な優位はない |
| MCP | 公式 SDK はあるが（TypeScript SDK と対等な公式扱い）、TypeScript SDK が reference implementation である |
| GitHub App / Octokit | JS ほど充実していない |

**候補から外す**: Node/TypeScript に対して明確に優る決定的理由が無い一方、MCP・GitHub Ecosystem・plugin 配布のいずれでも TypeScript が一次言語である。Python を採用する動機（既存資産、チームのスキルセット等）も本 repository には存在しない。よって Issue #18 の AC-08 に従い、Python は正式候補から外す。

## 8. Bun 短評

Bun は「将来のランタイム選択肢」として一つの subsection で評価し、今回は不採用とする。

- **利点**: `bun build --compile` は Node SEA より実務的に成熟した単一バイナリ生成手段であり、5節の (d) 選択肢を将来強化しうる。
- **懸念**: process/signal 周りのエッジケース報告がある。JSON Schema の built-in support はない（Ajv 相当の依存が必要な点は Node と同じ）。native addon 周りは注意が必要: V8 の C++ API に直接依存する addon（V8 engine embedding 前提のもの）は Bun（JavaScriptCore ベース）と非互換。一方 Node-API（N-API）ベースの addon（`koffi` を含む）は Bun が独自に実装しており概ね動作するとされるが、この PoC では未検証。Claude Code CLI 自身の native install が Bun でコンパイルされている事実（3.4節）を踏まえると、Bun の Windows 実績が浅いと単純に決めつけるのは不正確で、正しくは「HDO 固有の process 制御挙動が Bun 上で未検証」という点に絞られる。
- **両対応を維持する具体策**: Issue #18 のコメントで提示された tsconfig 制約（`erasableSyntaxOnly: true`、`types: ["node"]` で `@types/bun` を入れない、相対 import に `.ts` 拡張子を明記、`paths` エイリアス不使用、`node:` プレフィックス + Web 標準 API のみ使用）を採用すればよい。**PoC の `tsconfig.json`（`erasableSyntaxOnly: true`, `types: ["node"]`, `allowImportingTsExtensions: true`）と `src/**/*.ts` の import は実際にこの制約に従っており**、Bun でも動く可能性を潰していない（Bun での実行そのものは未検証）。

**結論**: 現時点で Bun を primary runtime として採用する理由はないが、コーディング規約を Node 専用にしないことで将来の選択肢として残す。

## 9. 総合評価

| 評価軸グループ | 判定 | 根拠（要約） |
|---|---|---|
| Architecture / Maintainability | TypeScript 優位 | 型システムによるコンパイル時検査、`node:test` 標準搭載、`boundary.test.ts` による依存方向の機械的強制 |
| Cross-platform | 同等 | 両者とも OS 差分を limited adapter に閉じ込める設計は実証可能。「Node にすれば自動解消する」問題ではない |
| Process Orchestration | PowerShell 優位（Windows 限定） | PowerShell は breakaway フラグ無しの Job ハンドル（`KillOnCloseJob`）を明示的に保持し、直接の子が生成したあらゆる子孫を確実に終了できるのに対し、Node/libuv の process-wide Job Object は直接の子までしか対象にせず（`SILENT_BREAKAWAY_OK`）、孫プロセスは `detached` の指定に関わらず一切 Job のメンバーになれない。HDO 側が持つのは PID 親子関係を辿るだけの `taskkill /T` であり、直接の子が既に exit していれば孤児化した孫には届かない。この gap は「detached な孫が breakaway する」場合に限らず、あらゆる孫プロセスに及ぶ、より広いものである |
| CLI / Distribution | 同等〜TypeScript がやや優位 | どちらもランタイム別途導入が前提。TypeScript はビルドレス実行・plugin 経由起動を実証済みだが、単一バイナリ化はどちらも未成熟 |
| Ecosystem / Future Expansion | TypeScript 優位 | MCP 公式 SDK、GitHub App/Octokit エコシステム、Web API/UI 実装資産が JS 側に厚い |
| Security | 同等（実証範囲に差） | 低レイヤ（process/redaction/path境界）は PoC で同等性を確認。ドメイン固有の semantic validation・GitHub 連携は両実装とも作り込みが必要（PowerShell は既に実装済み、TypeScript は未実装） |

意思決定を実際に左右するのは cross-platform 対応そのものではない（両者とも十分に対応可能）。決め手は次の3点である。

1. **将来ロードマップとの適合性**: MCP、GitHub App、Web API、parallel agents という Issue #18 が明示する拡張方向のいずれも、TypeScript/Node.js のエコシステムが一次言語または最有力の選択肢になっている。
2. **型付き module 境界による大規模化への耐性**: `boundary.test.ts` が実証したように、TypeScript は依存方向を機械的に強制できる。6800行規模から更に成長する場合、この保守性の差は複利的に効いてくる。
3. **static typing によるリファクタリング安全性**: `Set-StrictMode` の実行時検査に対し、`tsc --strict` はビルド前に型不整合を検出する。

一方、移行に反対する最も強い論拠は次の通りであり、ADR の「Consequences」でこれらを正面から扱う。

- 現在稼働中で6830行相当のテストされた実装（`tests/run-tests.ps1` 他）を持つこと自体が資産であり、書き直しは regression risk を伴う。
- Windows Job Object という OS 保証への到達手段が、Node には native addon や外部ツール抜きには存在しない。
- PowerShell 7 は `Test-Json` を組み込みで持ち、TypeScript は Ajv という追加依存を必要とする（この PoC でも唯一の runtime dependency として明示的に選んでいる）。
- 依存関係が一つ増えるごとに supply chain surface が増える（PowerShell 実装は外部パッケージ依存ゼロ）。
- リライトそのものにかかる工数とその期間中の機能停滞というコストは、Issue #18 が「リライトコストを主要な制約にしない」と明言していても実際の意思決定では無視できない。
