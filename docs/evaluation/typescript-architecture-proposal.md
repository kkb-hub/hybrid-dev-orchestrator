# TypeScript 採用時の Architecture Proposal

- 対象 Issue: #18（AC-04, AC-05）
- 前提: `docs/evaluation/powershell-vs-typescript.md` の評価結果と `poc/typescript/` の実装
- 本書は package/module 境界、dependency direction、主要 interface、runtime 規約、plugin 統合、配布、テスト戦略、既知の risk を扱う

## 1. 目的

Issue #18 の Proposed TypeScript Architecture（`packages/{core,cli,platform,git,github}/...`）を、実際に動く最小 PoC で検証した結果として、本番移行時に採用すべき package/module 構成を提案する。単純な `.ps1 -> .ts` の逐語移植ではなく、core と adapter を分離した構成であることを実証（`poc/typescript/src/core/boundary.test.ts`）した上での提案である。

## 2. Package / module boundary

### 2.1 レイアウト

PoC が実装した構成（`poc/typescript/README.md` 「ディレクトリ構成と依存方向」節）をそのまま本番移行の出発点として推奨する。

```text
src/
  core/
    contracts/   config / project contract / review result の型 + Ajv wrapper
    config/      deep merge、%VAR%/~ 展開、source 合成
    state/       RunState union + 遷移表 + transition(from, to)
    process/     ProcessRunner interface + BoundedProcessResult 型 + secret redaction
    workflow/    (本番で新規追加) plan→implement→validate→review→fix の bounded loop
    validation/  (本番で新規追加) .hdo/project.json の gate 実行
  platform/      PlatformAdapter の windows/posix 実装（node:fs, node:child_process を使う）
  process/       NodeProcessRunner（実際に子プロセスを spawn する実装）
  git/           GitClient（ProcessRunner の上に構築した git ラッパー）
  github/        (本番で新規追加) Issue 正規化・claim・label 同期
  runners/       (本番で新規追加) codex/claude/command adapter
  cli/           main.ts が composition root
  plugin/        (本番で新規追加) Claude Code / Codex plugin 起動経路の薄いラッパー
```

Issue #18 の `packages/` sketch との対応: `core/contracts`・`core/workflow`・`core/state`・`core/runners`・`core/validation` という提案に対し、PoC は `core/contracts`・`core/state`・`core/process`（interface のみ）を実装し、`core/workflow`・`core/validation`（gate 実行）・runner adapter の実体は本番移行時の新規実装として残っている（評価文書1節「非目標」、`poc/typescript/README.md` 「非目標」節参照）。

### 2.2 単一 package vs npm workspaces

**第一段階の移行では単一 package + folder 境界を推奨し、workspaces 化は後回しにする。**

理由:

- `boundary.test.ts` によるソーステキスト静的検査は、workspaces に分割しなくても依存方向を強制できることを実証済み。package 分割による publish 単位の独立は、現時点では HDO に外部消費者がいない（社内 CLI 1個）ため過剰な投資になる。
- workspaces化は `package.json` × N、`tsconfig.json` の project references、CI のキャッシュ戦略等、構成管理のオーバーヘッドを増やす。PoC の `tsconfig.json` は単一ファイルで完結しており（`include: ["src/**/*.ts"]`）、この単純さは初期の移行速度に寄与する。
- 将来、`runners/` や `github/` を別 repository や別チームへ切り出す必要が生じた時点（Ecosystem 節にある GitHub App 化、独立 review-platform plugin 化等）で workspaces 化を再検討すればよい。folder 境界を最初から enforce しておけば、その時点での分割コストは小さい。

## 3. Dependency direction

```text
core  <-  platform, process, git, github, runners
core, platform, process, git  <-  cli, plugin
```

ルール:

- `core` が import・require・動的 import してよい非相対 specifier は `node:path`・`ajv`・`ajv/dist/2020.js`・`ajv-formats` の4つのみ（allow-list）。`node:child_process`/`node:os`/`node:fs`/`node:fs/promises`/`node:worker_threads` を含め、これ以外の非相対 specifier はすべて違反として扱う。
- `core` の相対 import は `resolve()` した結果が `src/core/` の外に出てはならない（`../platform`, `../../git` のような兄弟 adapter folder への逃げを検査する）。

### 3.1 機械的強制

PoC の `src/core/boundary.test.ts` はこれを次の2つの `node:test` テストで強制する（デナイリストではなく allow-list 方式。過去に見つかったバイパス - F-08: 行頭一致の見落とし、G-02: `node:` プレフィックス無し specifier の見落とし - を踏まえた設計。F-08/G-02 という ID は `boundary.test.ts` 冒頭のコメントで採番されている）。

1. `core does not import host-specific or outer-layer modules (whole-file scan)`: `src/core/**/*.ts`（`*.test.ts` を除く）の全ファイルのテキストに対し、`from '...'`・副作用のみの `import '...'`・動的 `import('...')`・`require('...')` の4つの抽出形式すべてを正規表現で走査し（複数行にまたがる `import { ... } from '...'` も検出できるよう、行頭一致ではなく全文スキャンにしている）、`createRequire` の使用も別途検出する。相対 specifier は `resolve()` の結果が `src/core/` の外に出れば違反、非相対 specifier は `ALLOWED_NON_RELATIVE_SPECIFIERS`（`node:path`, `ajv`, `ajv/dist/2020.js`, `ajv-formats`）と完全一致またはそのサブパスでなければ違反と判定する allow-list 方式であり、`FORBIDDEN_IMPORTS` のようなデナイリスト定数は存在しない。
2. `findBoundaryViolations detects every bypass form on synthetic snippets (self-test, not files)`: 上記の判定関数に対し、静的/動的/`require`/`createRequire`/複数行 import/`node:` プレフィックス無し specifier/相対 escape の各バイパス形式を実ファイルではなく文字列として直接与え、すべて検知されることを確認する negative self-test。allow-list に載っている specifier が誤検知されないことも同じテストで確認する。

この検査は `node --test` で通常の test suite と一緒に実行されるため、CI が自動的に regression を検出する。

### 3.2 本番での形式化

PoC のテキスト走査は最小実装として機能するが、本番では次のいずれかへ発展させることを提案する。

- **ESLint `no-restricted-imports`**: `overrides` で `src/core/**/*.ts` に対して forbidden pattern を設定する。IDE 上でも即座に警告が出る利点がある。
- **`dependency-cruiser`**: `.dependency-cruiser.js` に `core -> platform|process|git|cli` を禁止するルールを書き、`depcruise --validate` を CI に追加する。import グラフの可視化（`--output-type dot`）も得られる。

どちらを採用しても `boundary.test.ts` 相当の contract を保持したまま、開発体験（IDE 即時フィードバック、依存グラフ可視化）を向上できる。まずは `boundary.test.ts` をそのまま本番へ持ち込み、余力があれば ESLint ルールを追加する順序を推奨する（テストを消さない）。

## 4. Key interfaces

以下は PoC の実装からそのまま持ち込める signature と、本番化で変更が必要な点を示す。

### 4.1 `PlatformAdapter`（`poc/typescript/src/platform/types.ts`）

```ts
export interface PlatformAdapter extends EnvironmentTokenResolver {
  readonly name: "windows" | "posix";
  userConfigDir(): string;
  defaultDataDir(): string;
  pathEquals(a: string, b: string): boolean;
  resolveExecutable(name: string): string | undefined;
  killProcessTree(pid: number): Promise<void>;
  isReparsePointInPath(child: string, root: string): boolean;
  realPath(p: string): string;
  processTreeKillStrategy(): string;
  readonly spawnDetached: boolean;
}
```

本番での変更点:

- `killProcessTree` の Windows 実装差し替え（`taskkill /T /F` → `koffi` 等の FFI 経由、または自前の Node-API native addon で `CreateJobObject`/`SetInformationJobObject`/`AssignProcessToJobObject` を直接呼ぶ形。9節参照)。`koffi` はそれ自体が prebuilt の Node-API addon（platform 別バイナリを依存木に含む）であり「non-native な選択肢」ではない点に注意。Job Object は spawn 直後に生成し子プロセスを即座に割り当てないと意味がなく、`killProcessTree(pid)` を kill 時に呼ぶだけの現行 signature では後から Job に押し込めない（すでに Job 外で動いている子を遡って含められない）。したがって `PlatformAdapter` に spawn 直後に呼ぶ `containProcess(pid): Disposable` を追加し、timeout/output limit 時にはその handle を close して Job ごと確実に終了させる構成に変える必要がある（**signature 変更あり**）。spawn から `containProcess` 呼び出しまでの短い race window は、PS 版が `Start()` の後に `KillOnCloseJob.TryAttach`（`Common.ps1:741` の `$process.Start()` の後、`Common.ps1:320` 付近で呼ばれる）で Job に attach するのと同型の race であり、PoC 固有の後退ではない。
- `EnvironmentTokenResolver`（`resolveToken`, `homeDir`）は `%APPDATA%`/`%LOCALAPPDATA%` 以外の token（`{repository}` 等）を扱う `expandPathTemplate`（`core/config/expand.ts`）と組み合わせて使う。これは PoC のまま流用可能。

### 4.2 `ProcessRunner`（`poc/typescript/src/core/process/types.ts`）

```ts
export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  inputText?: string;
  timeoutSeconds: number;
  env?: Record<string, string>;
  maximumOutputBytes?: number;
  outputTailBytes?: number;
  /** Seconds to wait for stdout/stderr to report `close` after exit before giving up
   *  and destroying the streams. Mirrors `Invoke-HdoProcess -OutputDrainSeconds`. */
  outputDrainSeconds?: number;
  stdoutPath?: string;
  stderrPath?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (event: { at: string; elapsedSeconds: number }) => void;
}

export type TerminationReason = "" | "timeout" | "outputLimit" | "inputError" | "captureError";

export interface BoundedProcessResult {
  command: string; args: string[]; exitCode: number; timedOut: boolean;
  outputLimitExceeded: boolean; outputLimitStream: "" | "stdout" | "stderr";
  /** True when the process's own exit was observed promptly but stdout/stderr did not
   *  report `close` within `outputDrainSeconds` (a descendant still holds the pipe open). */
  outputDrainTimedOut: boolean;
  /** Single first-observed terminating cause; `exitCode` is derived from this. */
  terminationReason: TerminationReason;
  /** Non-empty iff writing `inputText` to stdin failed. */
  inputError: string;
  /** Non-empty iff spawning the process or capturing its output failed outright. */
  captureError: string;
  maximumOutputBytes: number;
  /** Bytes received before capture stopped; when the limit fires on this stream, bounded
   *  by maximumOutputBytes + one pipe chunk (Node's 64 KiB highWaterMark). */
  stdoutBytes: number;
  stderrBytes: number;
  stdout: string; stderr: string; startedAt: string; endedAt: string; durationMs: number;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): Promise<BoundedProcessResult>;
}
```

本番での変更点:

- `env` を「明示 allow-list」設計のまま使うか、`Get-HdoSafeEnvironment` 相当の blocklist（固定 credential 名 + `(TOKEN\|SECRET\|PASSWORD\|API_KEY)$` 正規表現）を配線するかを決める必要がある。blocklist 自体は `getSafeEnvironment()`（`core/process/safeEnvironment.ts`）として PoC でも pure 関数に移植・単体テスト済みだが、`doctor`/`probe`/`GitClient` のどこからも呼び出していない（F-09: PoC README で採番した PoC 内 finding ID。以下同様。評価文書6節「security boundary」参照）。加えて Windows では明示 `env` を渡しても libuv が `HOMEDRIVE`/`HOMEPATH`/`LOGONSERVER`/`PATH`/`SYSTEMDRIVE`/`SYSTEMROOT`/`TEMP`/`USERDOMAIN`/`USERNAME`/`USERPROFILE`/`WINDIR` を無条件に追加する（POSIX は追加なし）ため、「明示指定した変数だけ」という allow-list の前提は Windows では厳密には成立しない。参考として、PowerShell 側の .NET `ProcessStartInfo.Environment.Clear()` は `-Environment` を明示指定した場合にのみ呼ばれ（`Common.ps1:733-736`）、何も暗黙注入しない（実測: 与えた `MARKER`/`SYSTEMROOT` の2つのみが子に渡り、`SYSTEMROOT` を欠くと `node` は CSPRNG の初期化 assertion で exit 134 になる）。
- `ActivityCallback`/heartbeat の `run.json.activity` 反映は `NodeProcessRunner` の外側（`Invoke-HdoAgentStep` 相当の呼び出し元、`Runner.ps1:472-698`、heartbeat callback は `Runner.ps1:574-616` 付近）で実装する必要がある。PoC の `onHeartbeat` フックはそのまま使える形。

### 4.3 `GitClient`（`poc/typescript/src/git/index.ts`）

主要メソッドは PoC のままでよい: `revParseHead`, `worktreeAdd`, `worktreeList`, `worktreeRemove`, `lsFilesOthers`, `diffBinary`, `isContainedWorktree`。本番で追加が必要なもの:

- `diff --numstat` の取得（`Git.ps1:118` の `Get-HdoDiff` 相当。PoC は `diffBinary` のみ実装し numstat/porcelain status は移植していない）。
- Issue #25（longpath）対策として、`worktreeAdd` 時に `git -C <path> config core.longpaths true` を設定する処理、または `worktreeRemove` 失敗時の `\\?\` プレフィックスフォールバック。これは PowerShell 側でも未着手の課題であり、どちらの実装でも新規に必要になる。

### 4.4 Runner adapter contract（本番で新規実装）

PoC は runner adapter を実装していないが、`docs/architecture.md` 9節の契約（Codex `codex exec ...`、Claude `claude -p ...`、command runner の token 展開）から、次のような interface を提案する。

```ts
export interface RunnerAdapter {
  readonly type: "codex" | "claude" | "command";
  buildInvocation(context: AgentStepContext): { command: string; args: string[]; inputText: string };
  parseOutput(stdoutPath: string, finalPath: string): Promise<unknown>; // 呼び出し元が schema 再検証
}
```

`ProcessRunner` は `runners/` から呼ばれる下位レイヤーとして維持し、adapter ごとの argument 組み立て・出力パースだけを `runners/{codex,claude,command}.ts` に分離する。この分離は PowerShell の `Invoke-HdoAgentStep`（`Runner.ps1:472-698`）が type ごとの `if/elseif` で分岐している構造を、TypeScript では discriminated union + adapter オブジェクトの配列（`Record<RunnerType, RunnerAdapter>`）に置き換えるだけで実現できる。

### 4.5 State transition table（`poc/typescript/src/core/state/index.ts`）

`RunState` union、`EXPLICIT_TRANSITIONS`、`transition(from, to)`、`IllegalStateTransitionError` はそのまま本番へ持ち込める。`docs/architecture.md` 7節の遷移表と1対1に対応しており、変更点はない。

## 5. Runtime / language 規約

Issue #18 のコメントで提示され、PoC がすでに従っている規約をそのまま本番の規約として採用する。

| 規約 | PoC での実施状況 |
|---|---|
| Node 24 LTS 以上 | `doctor.ts` は自分自身が Node 上で走っている前提の check なので、`node` が PATH に無いケースそのものは検出できない（プロセスが起動できず即座に失敗するだけ）。`meetsMinimumNode`（22.18 以上）が検査するのは native type stripping が効く最低ラインであり、ADR が要求する「Node 24 LTS 以上」という運用方針とは別の閾値である。`package.json` に `engines` フィールドは無く、Node バージョンを強制しているのは CI のみ（`poc-typescript.yml` の `node-version: 24`）。`devDependencies` の `@types/node: ^24.0.0` は型定義パッケージのバージョンであり、実行時の engine 制約ではない |
| `node:` プレフィックス import のみ | `src/**/*.ts` の全 import を確認済み（`node:child_process`, `node:fs`, `node:path` 等のみ使用、`bun:*` 系は皆無） |
| 相対 import に `.ts` 拡張子を明記 | 全ファイルで `from "./types.ts"` のように明記（`allowImportingTsExtensions: true`） |
| `erasableSyntaxOnly` | `tsconfig.json` で `true`。enum・namespace・パラメータプロパティを型エラーにする |
| `types: ["node"]` | `tsconfig.json` で明記。`@types/bun` は devDependencies に存在しない |
| tsconfig `paths` エイリアス不使用 | PoC は相対パスのみ使用 |
| `shell: true` 不使用 | `runner.ts`/`windows.ts`/`posix.ts` のいずれも `spawn` に `shell` オプションを渡していない |
| `.cmd`/`.bat` を直接 spawn しない | `windows.ts` の `resolveExecutable` は `.exe`/`.com` のみ解決する（CVE-2024-27980: `shell: true` なしで `.cmd`/`.bat` を `spawn()` すると EINVAL）。npm グローバルの `claude.cmd`/`codex.cmd` のような shim は本番でこの制限に直接当たるため、shim を辿って実体の `node <script>` を起動するか、`.exe` を含むインストーラ版に頼る設計が必要（評価文書3.2節「executable resolution」・6節「no shell string」参照）。PowerShell の `Invoke-HdoProcess` も bare コマンド名では同じ shim を解決できない（`Get-Command npm` が `npm.ps1` を先に返し、`-Command npm` は実測で THROW する）。明示的に `.cmd` パスを渡した場合（`tests/run-tests.ps1:972` の `mock-claude.cmd` 等）に限り動く、という限定的な差にとどまる |
| 明示的な env オブジェクト | `ProcessRunOptions.env` は明示指定時に「その内容だけ」を渡す設計だが、Windows では libuv が `HOMEDRIVE`/`HOMEPATH`/`LOGONSERVER`/`PATH`/`SYSTEMDRIVE`/`SYSTEMROOT`/`TEMP`/`USERDOMAIN`/`USERNAME`/`USERPROFILE`/`WINDIR` を無条件に追加する（`runner.ts` の `buildEnvironment`、`explicitEnvExtraKeys` で実測）。POSIX はこの注入がない |
| 単一 runtime dependency policy | `package.json` の直接 `dependencies` は `ajv`と`ajv-formats`の2つのみ。ただし推移的依存を含めると `package-lock.json` に記録された実行時 package は6個（`fast-deep-equal`, `fast-uri`, `json-schema-traverse`, `require-from-string` を含む）。`npm ci --ignore-scripts` は install 時の lifecycle script 実行を止めるだけで、この6 package 自体の実行を止めるものではない |

## 6. Plugin 統合（AC-05）

検証済みの起動経路は3つ（`poc/typescript/results/plugin-surface-windows.md`）。

1. **Claude Code command body から直接 `node` 実行**: `commands/doctor.md` が `pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" ...` を呼ぶのと同じ形で、`node "${CLAUDE_PLUGIN_ROOT}/poc/typescript/src/cli/main.ts" doctor --json` を実行し、exit 0 で成功することを実機（Windows 11、Node v24.19.0、Git Bash）で確認した。
2. **POSIX launcher `plugin-surface/bin/hdo-poc`**: `#!/bin/sh` で自身のディレクトリを `CDPATH= cd -- "$(dirname -- "$0")" && pwd` により解決し、`node "${SCRIPT_DIR}/../../src/cli/main.ts" "$@"` を `exec` する。呼び出し元の cwd に依存しないことを `/tmp/hdo-poc-cwd-test` から実行して確認済み。**ただしこの検証は Windows 上の Git Bash `sh` で行ったものであり、ネイティブ Linux 上での実行は未検証**（`scripts/Dockerfile.ubuntu` は `poc/typescript/src/` 等はコピーするが `plugin-surface/` はコピーしておらず、Linux CI もこの launcher を経由しない）。実行ビット（`chmod +x`）は commit 時点で設定しておく必要がある点にも注意（checkout 環境によっては失われ得る）。
3. **Windows launcher `plugin-surface/bin/hdo-poc.cmd`**: `%~dp0` で自身のディレクトリを解決し、`node "%~dp0..\..\src\cli\main.ts" %*` を実行する。同じく無関係な cwd から exit 0 を確認済み。

検証中に発見・修正したバグ: 両 launcher の初稿は `<bindir>/../src/cli/main.ts`（`..` 1つ）を指しており、`plugin-surface/src/cli/main.ts` に解決されて `MODULE_NOT_FOUND` になった。`bin/` は `plugin-surface/` の直下にあり `poc/typescript/` の直下ではないため、正しくは `../../src/cli/main.ts`（`..` 2つ）である。この修正は実際に launcher を実行して初めて判明したものであり、スクリプトを読むだけでは検出できなかった。

前提条件（実測ベース）:

- `node` が PATH 上にあること。`doctor.ts` の `node-version` チェックは実際には 22.18 以上を検査するだけで（5節参照）、「Node 24 LTS 以上」という運用方針そのものを強制するものではなく、`node` が PATH に無い場合はプロセス起動自体が失敗するため検出できない。
- checkout ごとに1回 `npm ci` を実行しておくこと。`npm ci` を実行していない場合、`node src/cli/main.ts` は `ajv`/`ajv-formats` の import で `ERR_MODULE_NOT_FOUND` を投げて即座に落ちる。**現在の `doctor.ts`（`runDoctor`）はこの状態を明示的な doctor check としては検出しない**（`node-version`/`git`/`config` の3 check のみ実装しており、`node_modules` の存在確認は含まれていない）。本番の `runDoctor` にはこの check を追加する必要がある（未実装、既知の gap）。

`.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` への反映方針（現時点では変更しない。ADR「Migration strategy」で正式化する）:

- Claude Code 側は `commands/*.md`（全8ファイル: `cleanup`, `config`, `doctor`, `inspect`, `issues`, `labels`, `run`, `status`）の本文を `pwsh -File hdo.ps1 ...` から `node "${CLAUDE_PLUGIN_ROOT}/<production-path>/main.ts" ...` へ切り替える形になる。`allowed-tools` はいずれも `Bash(pwsh:*)` から `Bash(node:*)` に変更する必要がある（`poc/typescript/plugin-surface/hdo-poc-doctor.md` の frontmatter がその実例）。
- Codex 側は `skills/*/SKILL.md`（全8ディレクトリ: `hdo-cleanup`, `hdo-config`, `hdo-doctor`, `hdo-inspect`, `hdo-issues`, `hdo-labels`, `hdo-run`, `hdo-status`）が `pwsh -NoProfile -File <absolute-hdo-path>` を呼んでいる箇所を同様に置き換える。
- `.claude-plugin/plugin.json`/`.codex-plugin/plugin.json` の `description`/`keywords`（現在 `"powershell"` を含む）も TypeScript 実装を指す内容へ更新する。
- 8個の `commands/*.md`、8個の `skills/*/SKILL.md`、2つの `plugin.json` は同一 phase（Migration strategy フェーズ7、ADR参照）でまとめて切り替え、片方だけ pwsh 呼び出しが残る中間状態を作らない。
- どちらも `.claude-plugin/plugin.json`/`.codex-plugin/plugin.json` の `version` bump 運用（`tools/check-plugin-version.ps1`）はそのまま維持する。

## 7. 配布方針の推奨

`docs/evaluation/powershell-vs-typescript.md` 5節の trade-off 表に対応する形で、フェーズを分ける。

- **Phase 1（移行初期）**: repository-local（plugin root + `npm ci`）。理由: 追加の配布インフラが不要で、既存の「plugin を install すれば動く」体験を壊さない。PoC の (e) 経路がこれをそのまま実証済み。
- **Phase 2（TypeScript CLI が実運用に載った後）**: npm package + `bin` としての配布（(b)/(c)）。standalone な CLI 利用（plugin を介さない直接実行）のニーズが出た時点で検討する。
- **Phase 3（任意、必要になった場合のみ）**: Node SEA または `bun build --compile` による単一バイナリ化。現時点ではどちらも成熟度が十分ではないため、Phase 1/2 で問題が顕在化した場合の選択肢として保持するに留める。

## 8. テスト戦略

- **Unit test**: `node:test`（`node --test "src/**/*.test.ts"`）を標準ランナーとして採用する。PoC はこれで80 test を実装・実行済み（Windows 75 pass / 5 skip、Ubuntu 72 pass / 8 skip、いずれも 0 fail。追加パッケージ不要）。
- **既存 PowerShell fixture の再利用**: `tests/fixtures/schema/**` を「実装間の共通契約（cross-implementation contract）」として無変更のまま両実装から参照する。PoC の `src/cli/schemaFixtures.test.ts` はこれを実証しており、`tests/fixtures/schema/` 配下のファイル名接頭辞から `tests/test-schemas.ps1` のケーステーブルに対応する schema 名を導出する対応表（`issue`→`issue-contract`, `task`→`task-contract`, `worker`→`worker-result`, `review`→`review-result`, `repository-config`→`hdo-repository-config`）を持つ。これは `test-schemas.ps1` のケーステーブル全体のコピーではなく `tests/fixtures/schema/` 配下のケースだけを対象にした派生表で、`config/hdo.default.json`・`config/examples/*.json`・`.hdo/project.json` はこのディレクトリの外にあるため別のテストで直接検証している。schema fixture が9件以上あることをテスト側で `assert.ok(cases.length >= 9, ...)` として保証している。
- **CI matrix**: `.github/workflows/poc-typescript.yml` がすでに `windows-latest`/`ubuntu-latest` の両方で `npm ci` → `typecheck` → `test` → `probe --json` → `doctor --json` を実行する構成になっている。本番移行後はこのワークフローを本体の regression gate（現行 `test-suite.yml` 相当）へ格上げし、`paths:` フィルタ（`poc/typescript/**`・`schemas/**`・`config/**`・`tests/fixtures/**`・`.hdo/**`・ワークフロー自身の6パスで構成、`poc/typescript/**` に限定されているわけではない）を本番パスに広げるだけで転用できる。

## 9. Open questions / risks

- **Job Object 相当の獲得方法（未解決）**: 選択肢は (a) `koffi` 等の FFI 経由で `CreateJobObject`/`SetInformationJobObject`/`AssignProcessToJobObject` を直接呼ぶ、(b) 自前の native addon（node-gyp/node-API）を書く、(c) 移行期間中は起動を .NET/pwsh 製の薄い job-wrapper helper 経由にする、(d) `taskkill /T` のレースを受け入れて既知の限界として文書化する、のいずれか。(a)・(b) はどちらも platform 別 prebuilt バイナリを依存木に持ち込む点で本質的に同じ trade-off であり（`koffi` は「FFI だから native addon ではない」わけではなく、それ自体が prebuilt の Node-API addon）、ビルド環境・配布バイナリの platform 依存を増やす。この2択と (d) のどちらを取るかを、Migration strategy フェーズ2の終了条件として ADR で扱う。(a)・(b) いずれを選んでも、Job Object は子プロセスの spawn 直後に生成・割り当てて初めて意味を持つため、`killProcessTree(pid)` を kill 時に呼ぶだけの現行 signature のままでは実現できず、`PlatformAdapter.containProcess(pid): Disposable`（4.1節）のような spawn 直後 hook への signature 変更が前提になる。
- **Windows long path**: `\\?\` prefix 対応は本 PoC・PowerShell 実装のどちらにも存在しない。Issue #25（`hdo cleanup` の `Filename too long`）はこの gap の実例であり、TypeScript 移行時も `git worktree remove` の longpath 対応（`core.longpaths` 設定または `\\?\` フォールバック）を新規に実装する必要がある。
- **daemon 化時の signal handling**: `process.on('SIGINT'/'SIGTERM')` は Node 標準にあるが、PoC は実装・検証していない（未実証）。post-MVP の daemon/scheduler 拡張時に設計する。
- **Codex JSONL のストリーミングパース**: PoC は `events.jsonl`/`envelope.json` の保存経路（コピー）のみを対象とし、Codex の JSONL event stream をリアルタイムにパースして progress を抽出する処理は実装していない（`Runner.ps1` の `Invoke-HdoAgentStep` 相当の統合は本番実装が必要）。
