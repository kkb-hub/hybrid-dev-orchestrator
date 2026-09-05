# HDO ランタイム評価 PoC: TypeScript / Node.js

Issue #18（PowerShell 7 を維持するか TypeScript/Node.js を主ランタイムに採用するか評価する）の
受け入れ基準 AC-02〜AC-05 に対応する検証用実装。`docs/architecture.md` に定義された契約
（config merge 順序、JSON Schema、Git worktree、bounded process execution、State machine、
プラグイン起動経路）を Node.js でどこまで、どれだけのコード量で再現できるかを実証する。

## 目的

- 既存 PowerShell 実装 (`src/HybridDevOrchestrator/`) の主要な契約を Node.js 24 (native type
  stripping, ビルドレスで `.ts` を直接実行) 上で再現し、実測可能な差分を得る。
- config merge、JSON Schema validation (Ajv 2020-12)、Git worktree 操作、bounded な
  子プロセス実行（timeout・出力上限・process tree 終了）、State machine、Claude Code
  プラグインからの起動経路、の 6 点を実コードと実行結果で示す。
- Windows 実機と Ubuntu 24.04 (Docker) の両方で同じテストスイートを走らせ、観測できた
  OS 差分を `results/*.json` として記録する。

## 非目標（このPoCが証明しないこと）

- GitHub API 連携（Issue pickup、claim、label 同期）は実装しない。
- Codex / Claude 実 runner adapter（`codex exec` / `claude -p` の起動）は実装しない。
  `ProcessRunner` と `GitClient` という土台だけを示す。
- Workflow の全 orchestration（plan→implement→validate→review→fix loop）は実装しない。
  `core/state` に型付き state machine の骨組みだけを用意する。
- `.hdo/project.json` の validation gate 実行（trusted command 起動、exit class 判定）は
  実装しない。Schema validation のみ実施する。
- 本番移行の意思決定そのものはこの PoC のスコープ外（Issue #18 の別セクションで判断する）。

## 実行方法

### Windows

```sh
cd poc/typescript
npm ci
npm run typecheck
npm test
node src/cli/main.ts probe --json
node src/cli/main.ts doctor --json
```

### Ubuntu 24.04 (Docker)

リポジトリルートから実行する（PoC が `../../config`、`../../schemas`、
`../../tests/fixtures` を相対参照するため、ビルドコンテキストはリポジトリルート）。

```sh
bash poc/typescript/scripts/verify-linux.sh
```

内部で `docker build -f poc/typescript/scripts/Dockerfile.ubuntu .` を実行し、
`npm ci` → `npm run typecheck` → `npm test` → `probe --json` → `doctor --json` を
コンテナ内で実行して `results/ubuntu.json` と `results/ubuntu-test-output.txt` を
ホストへ書き出す。Git Bash では `docker run -v` の絶対パスがパス変換されてしまうため
`MSYS_NO_PATHCONV=1` を付けている（このリポジトリでは実際にこれが必要だった）。

### CI

`.github/workflows/poc-typescript.yml` が `poc/typescript/**`、`schemas/**`、
`config/**`、`tests/fixtures/**`、`.hdo/**`、ワークフロー自身の変更時にのみ `windows-latest` / `ubuntu-latest` の
両方で `npm ci` → typecheck → test → probe → doctor を実行する。既存の
`test-suite.yml`（PowerShell 本体の gate）は変更していない。

## ディレクトリ構成と依存方向

```
poc/typescript/
  src/
    core/        core は node:child_process / node:os / node:fs / ../platform / ../process
                 / ../git / ../cli を import しない（src/core/boundary.test.ts が機械的に検査）。
                 純粋なロジック + 注入されたインターフェースのみ。node:path と ajv/ajv-formats
                 のみ例外的に許可。
      contracts/   config / project contract / review result の型（手書きサブセット）+ Ajv wrapper
      config/      deep merge、%VAR%/~ 展開（環境変数解決は注入）、source 合成
      state/       RunState union + 遷移表（データ）+ transition(from,to)
      process/     ProcessRunner interface + BoundedProcessResult 型 + secret redaction
    platform/    PlatformAdapter の Windows/POSIX 実装（core より外側、node:fs/child_process を使う）
    process/     NodeProcessRunner（実際に子プロセスを spawn する実装）
    git/         GitClient（ProcessRunner の上に構築した git ラッパー）
    cli/         main.ts が composition root。core + platform + process + git を配線する。

  依存方向:  cli -> {git, process, platform, core}
             git -> {core, platform}
             process -> {core, platform}
             platform -> {core}
             core -> (何も上位に依存しない)
```

`src/core/boundary.test.ts` がこの依存方向を実際に強制する（許可された import 以外を
見つけたら fail する）。

## Ajv options

`src/core/contracts/validate.ts` は Ajv を次の設定で構築している。

```ts
new Ajv2020({ strict: false, allErrors: true });
```

- **`strict: false` が必須**: `schemas/*.json` は PowerShell の `Test-Json`
  (.NET/Newtonsoft ベース) 向けに書かれており、このPoCでは一切変更していない。デフォルトの
  `strict: true` のまま `schemas/hdo-config.schema.json` や
  `schemas/review-result.schema.json`（`if`/`then`/`allOf` の組み合わせ、`contains` +
  `minContains` など）を `ajv.compile()` すると strict-mode の例外が発生したため
  `strict: false` にしている。schema ファイル自体は無編集。
- **`allErrors: true`**: 1 件目のエラーで打ち切らず、`validate <schemaName> <file>` の
  出力やテストの失敗メッセージに複数エラーを列挙できるようにするため。
- `ajv-formats`（`addFormats(ajv)`）を追加登録している。`format: date-time` /
  `format: uri` を使う schema（`review-result.schema.json` 等）が実際に format を
  検査するようにするため（Ajv 本体は `format` キーワードを構文的に許容するだけで、
  `ajv-formats` を足さないと意味的な検証をしない）。
- 実装上の注意点: `ajv-formats` の `.d.ts` は ESM の `export default` として書かれているが
  コンパイル後の実体は `module.exports = exports = formatsPlugin` という CJS。
  `moduleResolution: nodenext` 環境ではこの default import の型が「呼び出し不可能な
  namespace 型」に解決されてしまう（実行時の値は関数そのものなので実害はない）。
  `validate.ts` 内で 1 箇所だけ `as unknown as (ajv: Ajv2020) => Ajv2020` にキャストして
  この不一致を吸収している（コメントで理由を明記）。

## 観測した OS 差分

`results/windows.json`（Windows 11, Node v24.19.0, ネイティブ実行）と
`results/ubuntu.json`（Ubuntu 24.04 コンテナ, Node v24.9.0, `docker run` 経由）を
`probe --json` で採取して比較した結果。

| 項目 | Windows | Ubuntu 24.04 (Docker) |
|---|---|---|
| `path.sep` | `\` | `/` |
| `path.delimiter` | `;` | `:` |
| 一時ディレクトリの大文字小文字区別 | 区別しない（`A.tmp` と `a.tmp` が同一ファイル） | 区別する |
| `git` 実行可能ファイルの解決 | `C:\Program Files\Git\mingw64\bin\git.exe`（PATH + PATHEXT 探索） | `/usr/bin/git`（PATH + 実行ビット確認） |
| `PATHEXT` | `.COM;.EXE;.BAT;.CMD;.VBS;...` | 存在しない（`null`） |
| `userConfigDir()` | `%APPDATA%` (`C:\Users\<user>\AppData\Roaming`) | `$XDG_CONFIG_HOME` 未設定時は `~/.config`（コンテナ内 `/root/.config`） |
| `defaultDataDir()` | `%LOCALAPPDATA%` (`...\AppData\Local`) | `$XDG_DATA_HOME` 未設定時は `~/.local/share`（`/root/.local/share`） |
| プロセスツリー終了の仕組み | `taskkill /T /F /PID`（PID の親子関係を辿るのみ。libuv 自体のグローバル Job（Node プロセスごとに 1 つ、全ての非 detached な直接の子が共有）は直接の子までしかカバーしない - 詳細は下記「既知の制約」） | `process.kill(-pid, 'SIGKILL')`（`detached: true` で作った process group） |
| `process.kill(-pid, ...)` のサポート | 非対応（Windows は負の PID を解釈しない） | 対応 |
| 明示的な `env` を渡した子プロセスへの環境変数の注入 | libuv が無条件に `HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE, WINDIR` を注入する（`explicitEnvExtraKeys` で実測） | 注入なし（`env` に書いた変数だけがそのまま子プロセスに渡る） |
| npm グローバルインストールの実行ファイル形式（例: `claude`/`codex`） | `.cmd` シム（`node <script>` を起動するラッパー）。Node の `spawn()` は `shell: true` なしでは `.cmd`/`.bat` を起動できず（EINVAL, CVE-2024-27980）、この PoC の `resolveExecutable` は `.exe`/`.com` のみ解決する。本番移行時はシムを辿って実体の `node <script>` を起動するか、`.exe` を含むインストーラ版を使う必要がある | シムの区別なし。実行ビットが付いた実体ファイルをそのまま `spawn()` できる |
| `os.EOL` | `"\r\n"` | `"\n"` |
| 8.3 短縮名（`RUNNER~1` 等）を含むパスと Git が報告するパスの比較 | GitHub-hosted `windows-latest` では `%TEMP%` が `C:\Users\RUNNER~1\...` の短縮名になり、`git worktree list` は長い名前 `C:/Users/runneradmin/...` を返す。文字列比較（`pathEquals`）では一致せず、`realpathSync.native`（Win32 final path）で展開する必要がある（`GitClient.worktreePathEquals`。PowerShell 版は `Get-HdoComparableFullPath` が同じ理由で final path を使う。本 PR の初回 CI で発見） | 該当なし（8.3 名は存在しない） |
| 一時ディレクトリでのシンボリックリンク作成 | 成功（このマシンでは Developer Mode/権限あり。EPERM で失敗する環境もあり得る） | 成功 |
| junction / directory symlink をパスに含む場合の検知 | `isReparsePointInPath` で検知（`mklink /J` と `fs.symlinkSync(..., 'dir')` の両方をテストし成功） | 該当なし（symlink のみで検証、こちらも検知成功） |
| 環境変数の個数 (`process.env` キー数) | 100（開発マシンの実環境） | 6（最小構成コンテナ） |
| `process.env.PATH` と `process.env.Path` | 同じキーとして扱われる（大文字小文字を区別しない。`envPathUpperAndMixedKeysAlias: true`） | 別々のキー（`Path` は未定義。`envPathUpperAndMixedKeysAlias: false`） |
| Node バージョン | v24.19.0（ホストにインストール済み） | v24.9.0（`Dockerfile.ubuntu` が `nodejs.org` から直接取得したバージョン） |
| `os.release()` | `10.0.26200` | `5.15.167.4-microsoft-standard-WSL2`（Docker Desktop の Linux VM が WSL2 kernel 上で動作しているため、"生の Ubuntu" ではなく WSL2 越しの値である点に注意） |

テストスイート自体は合計 80 件、両OSで **0 fail**。内訳は Windows が
**75 pass / 5 skip**（POSIX 専用ケースを 5件 skip: `resolveToken` の POSIX フォールバック、
`isReparsePointInPath` の symlink(POSIX) ケース、および G-04/H-03 で追加した
`isPathWithinRoot` の POSIX ルート (`/`) 向けケース 3件）、Ubuntu が **72 pass / 8 skip**
（Windows 専用ケース - junction・directory symlink・npm の `.exe`/`.com` 限定解決・`.cmd`
直接起動時の EINVAL 変換（以上 4件、F-04 のテスト追加分）、および G-04/H-03 で追加した
ドライブルート (`C:\`) 向けの `comparableFullPath`/`isPathWithinRoot` ケース 4件 - を
8件 skip）で、skip の組は完全に相補的だった（Windows 専用ケースが F-04 のテスト追加で
2件から 4件に増え、さらに G-04 のテスト追加で 4件から 7件に、H-03 のテスト追加で
7件から 8件に増えたぶん、Ubuntu 側の skip 数もそれぞれ同数増えている。F-04 で増えた 2件、
G-04 で増えた 3件、H-03 で増えた 1件はいずれも Windows 専用ケースで、F-03 のテストは
増えていない）。

## Bounded process execution: 終了コードと `terminationReason`

`NodeProcessRunner.run()` は「実行を最後までやり遂げられなかった」状況をすべて戻り値として
表現する（例外を投げない）。実際に発生した終了原因は `terminationReason` に単一の値として
記録され（複数の原因が同時に起こり得ても、**最初に確定した原因が勝つ** - 後から他の原因が
判定されても上書きしない）、`exitCode` はその値から一意に導出される。

| `terminationReason` | `exitCode` | 意味 |
|---|---|---|
| `""`（空文字） | 子プロセスの実際の終了コード（不明なら `1`） | 通常終了 |
| `"timeout"` | 124 | `timeoutSeconds` を超過し、process tree を kill した |
| `"outputLimit"` | 125 | stdout/stderr のいずれかが `maximumOutputBytes` を超過し、process tree を kill した |
| `"inputError"` | 126 | `inputText` を stdin へ書き込めなかった（子が消費前に終了した場合の EPIPE/EOF 等） |
| `"captureError"` | 127 | 実行そのものができなかった、または出力の捕捉に失敗した（下記参照） |

`"captureError"`（127）は次のいずれかをまとめて表す catch-all: プロセスの spawn 自体が
失敗した（ENOENT、あるいは `.cmd`/`.bat` を渡したときの EINVAL - F-04）、作業ディレクトリが
存在しなかった、`stdoutPath`/`stderrPath` への書き込みに失敗した（例: 指定パスが既存の
ディレクトリだった、EISDIR - F-07）、または stdout/stderr の pipe が `outputDrainSeconds`
以内に `close` を報告しなかった（`outputDrainTimedOut: true` - F-02、下記参照）。127 は
シェルの「コマンドが実行できなかった」を表す慣用的なコードとして選んだ
（`src/core/process/types.ts` の `TerminationReason` のコメントに理由を明記）。PowerShell の
`Invoke-HdoProcess` は「コマンドが見つからない」場合を例外として投げる点が異なる。

### F-02: 出力 pipe の bounded drain

以前の実装は子プロセスの `close` イベント（すべての stdio pipe が EOF に達すること）を
主たる待機対象にしていたため、直接の子プロセスが終了していても、孫プロセスが同じ pipe
ハンドルを継承して握ったままだと `close` がいつまでも来ず、2秒の timeout 指定が実測 15 秒
かかって返ってくる、という不具合があった（F-02）。修正後は:

1. `exit`（または `error`）イベントを主たる待機対象にする（`close` は待たない）。
2. `close` がまだ来ていなければ、`outputDrainSeconds`（デフォルト 2 秒、PowerShell の
   `Invoke-HdoProcess -OutputDrainSeconds` に対応）だけ追加で待つ。
3. それでも `close` が来なければ、process tree に再度 kill を試みたうえで
   `stdout`/`stderr` ストリームを強制的に `destroy()` し、`outputDrainTimedOut: true` を
   記録して抜ける（`terminationReason` が未確定ならここで `"captureError"` になる）。

これにより、孫プロセスが生き残っていても呼び出し側は `outputDrainSeconds` 分の遅延だけで
確実に結果を受け取れるようになった。ただし **孫プロセス自体を確実に終了させられるとは
限らない** - 次の項を参照。

## 既知の制約 / 未検証

- **Windows の Job Object は libuv 内部で自動使用されているが、孫プロセスは対象外**
  （13 件の実験と libuv 本体のソース `src/win/process.c` で検証済み）: Windows で
  Node/libuv は、`detached: true` なしに spawn した直接の子プロセスだけを、
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK | BREAKAWAY_OK` を設定した、
  Node プロセスごとに 1 つのグローバル Job（全ての非 detached な直接の子が共有）に
  割り当てる。Node プロセスがどのような形で終了しても非
  detached な直接の子はカーネルにより終了させられる。しかし `SILENT_BREAKAWAY_OK` に
  より、Job メンバーが生成した子プロセス（孫）は一切 Job に入らない。孫がホストと道連れ
  になるのは中間プロセスも Node の場合に限られ、`cmd.exe`・`pwsh`・`git`・`claude.exe`
  のような非 libuv の中間プロセスを挟むと連鎖は途切れる。`detached: true` は「Job から
  breakaway する」のではなく「最初から Job に割り当てられない」だけで、孫の生死には
  関係しない。PoC の `taskkill /T /F /PID` は PID 親子関係を辿る唯一の孫到達手段で、
  直接の子が既に終了していれば孤児化した孫には届かない（F-02 のテスト
  `bounded output drain: a surviving detached grandchild does not block the result`
  で孫が生き残る実際の理由は、breakaway ではなく、`killProcessTree(child.pid)` が呼ばれる
  時点で既に直接の子プロセスが exit しており、`taskkill /T` が辿る生きた根が無いことに
  よる）。孫プロセス自体はテストの `t.after` で `taskkill /F /PID <grandchild-pid>` に
  よって明示的に後始末する。この PoC の bounded drain（上記）は、この孫プロセスを
  終了させられなくても呼び出し側を `outputDrainSeconds` 分の遅延でアンブロックすることで
  実害を緩和しているが、孫プロセスというリソースそのものの解放は保証しない。対して
  PowerShell 版 (`src/HybridDevOrchestrator/Private/Common.ps1` の `KillOnCloseJob`) は
  breakaway フラグを持たない Job を HDO 側が明示的に保持するため、直接の子が生成した
  あらゆる子孫が Job に含まれ、ハンドルを close するだけで全員を確実に終了させられ、
  さらに `OutputDrainSeconds` で同様の drain 上限を設けている。Node で同等の保証を得る
  には、native addon/FFI で自前の Job Object を作成・保持する以外の手段はない。
- **H-04: 出力上限超過時にストリームを `destroy()` すると、`stderr` キャプチャファイルが
  子プロセスの EPIPE トレースで終わることがある**: `maybeEnforceLimit`（`process/runner.ts`）
  が超過側の Readable を `destroy()` するとそのパイプの片端が閉じるため、子プロセスの次の
  書き込みは失敗する - POSIX では書き込み元に EPIPE が返る（`SIGPIPE` を処理/無視して
  いなければそのシグナルで終了する）。Windows に `SIGPIPE` は無いが、子プロセスが Node の
  場合、閉じたパイプへの次の書き込みはその子プロセス自身の中で例外を送出し、キャッチされて
  いなければ unhandled-error/uncaught-exception のトレースとして現れる。閉じられたのが
  `stderr` 側で `stderrPath` が指定されていた場合、そのトレースはパイプが完全に閉じるまで
  引き続き捕捉されるため、`stderr` キャプチャファイルの末尾に子プロセス自身のエラー
  トレースが残ることがある。
- **POSIX の `detached` + process group kill も万能ではない**: 子プロセスが自分で
  `setsid()` を呼んで新しい process group を作った場合、親の `process.kill(-pid, ...)`
  はその子孫まで届かない。
- **`isReparsePointInPath` は起動前の point-in-time チェック**: PowerShell 版と同様、
  実行中に別 path を辿る TOCTOU 的な迂回までは防げない。
- **`Get-HdoSafeEnvironment` の deny-list は core 関数として移植済みだが、どこからも
  配線されていない（F-09）**: `src/core/process/safeEnvironment.ts` の
  `getSafeEnvironment()` が `Common.ps1` の deny-list（ブロックする変数名の固定リストと
  `(?i)(TOKEN|SECRET|PASSWORD|API_KEY)$` の正規表現）をそのまま純粋関数として持つが、
  `doctor`/`probe`/`GitClient` のどれもこれを呼び出していない。特に `GitClient.exec` は
  今も呼び出し元プロセスの環境変数をそのまま継承する - これは `Invoke-HdoGit` が
  `Get-HdoSafeEnvironment` を経由せず `Invoke-HdoProcess` にそのまま委譲しているのと
  パリティが取れている（安全な既定値が必要な呼び出し元は、明示的に `env` を組み立てて
  渡す設計）。
- **schema validation のみで、`.hdo/project.json` の validation gate 実行は未実装**。
- **GitHub 連携・実 runner adapter・workflow の完全な bounded loop は未実装**（意図的な
  非目標。上記「非目標」参照）。
- **`results/ubuntu.json` の `os.release()` は Docker Desktop の WSL2 backend の値**
  であり、ベアメタル Linux とは異なる可能性がある。
- ソースコード行数（テストを除く `src/**/*.ts`、`*.test.ts` を除外、`wc -l` および
  空行・コメント除外のフィルタで計測）は raw で約 2100 行、空行を除くと約 1900 行、
  さらにコメント行（`//`・`/*`・`*` で始まる行）も除くと約 1560 行で、"roughly 1500"
  の目安は非コメント実装行としてはおおよそ達成している。raw 行数が多いのはコメント
  （契約の出典や設計判断の記録）を削らない方針を優先した結果。
