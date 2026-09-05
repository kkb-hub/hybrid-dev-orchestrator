# ADR-0002: Windows process-tree containment は koffi 経由の Job Object

## Status

Accepted (2026-09-05) — repository owner の決定。ADR-0001 Migration strategy フェーズ2（process / platform）の一部として起票する。

## Context

ADR-0001 の Rationale「最も強い反論」が指摘した通り、Windows では libuv が `SILENT_BREAKAWAY_OK` を設定した process-wide の Job Object を使うため、`detached` の指定に関わらず孫プロセスは最初から HDO の管理下に一切入らない。PowerShell 実装（`Common.ps1` の `BoundedProcessCapture.KillOnCloseJob`）は、.NET `Process` オブジェクトが既に開いている handle に対して `AssignProcessToJobObject` を直接呼び出し、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` を設定した自前の Job へ direct child を割り当てることで、`tests/fixtures/runtime/hold-output-handle.ps1`（.NET `Process.Start` で生成した非 breakaway な孫）を確実に終了させ、`outputDrainTimedOut: false` かつ exitCode 0 を返す。

ADR-0001 は、この gap を Migration strategy フェーズ2の終了条件として次のいずれかで解消するよう定めた: (i) native addon/FFI で同等の Job Object 制御を実装する、(ii) 既知限界として明示的に受容し ADR に記録する。

## Decision

(i) を採用する。HDO 自身が **koffi**（`npm` package、`Node-API` 経由の **prebuilt native addon** として配布される FFI ライブラリ - 訂正: 以前の版はこれを「pure-JS FFI」と誤記していたが、koffi 自体は C で書かれコンパイル済みバイナリとして配布されるアドオンであり、JS 層は薄いラッパーに過ぎない）経由で Win32 API（`CreateJobObjectW`・`SetInformationJobObject`・`AssignProcessToJobObject`・`TerminateJobObject`・`OpenProcess`・`CloseHandle`）を呼び出し、Windows Job Object を保持する。

- `koffi` は `dependencies` に **exact version pin**（`"koffi": "3.2.1"`、キャレット無し）で追加する。
- `koffi` の import は `await import("koffi")` による **lazy dynamic import** とし、`src/platform/jobObject.ts`（`src/platform/**` 配下）からのみ行う。`src/core/**` は `koffi` は元より `node:child_process`/`node:fs` 等の host-specific module を一切 import できない（`src/core/boundary.test.ts` の allow-list により機械的に強制される。この境界は変更しない）。
- 実装フロー（`NodeProcessRunner.run`）: 子プロセスを **`detached: false`** で通常通り spawn する（libuv 既定の Job には引き続き入る - ホストプロセスがクラッシュした際の保護はそのまま残る）。spawn 直後、`OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE = 0x0101, false, pid)` で子プロセスの handle を取得し、`CreateJobObjectW(null, null)` で新しい Job を作成、`SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, &ext, sizeof)` で `ext.BasicLimitInformation.LimitFlags = 0x2000 /* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */` を設定してから `AssignProcessToJobObject(job, processHandle)` で子プロセスを Job に割り当てる。
- 失敗時のフォールバック: koffi の import 失敗、または上記いずれかの Win32 呼び出しの失敗は、`ProcessContainer { attached: false, error: <message> }` として runner に伝播し、runner は `taskkill /T /F /PID`（`PlatformAdapter.killProcessTree`）へフォールバックする。`error` の文言は PowerShell の `KillOnCloseJob.Error` と揃えた形式にする: `CreateJobObject failed with Win32 error N.` / `SetInformationJobObject failed with Win32 error N.` / `AssignProcessToJobObject failed with Win32 error N.` / `koffi could not be loaded: <message>`。ただし `OpenProcess failed with Win32 error N.` は PowerShell 側に対応する呼び出しが無い、この実装固有の追加ステップである（Rationale 参照）。
- Job のライフサイクル: `ProcessContainer.terminate()` は `TerminateJobObject` を呼ぶ（即時終了、handle は保持したまま）。`ProcessContainer.dispose()` は `CloseHandle(job)` のみを呼ぶ - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` により、これが Job に割り当てられた**すべての**プロセスを終了させる（PowerShell の `KillOnCloseJob.Dispose()` と同じ仕組みで、PowerShell 側も `TerminateJobObject` を明示的には呼ばない）。`NodeProcessRunner` は子プロセスの exit を確認した直後、stdout/stderr の drain 待ちより**前**に `dispose()` を呼ぶ - 孫プロセスが redirected pipe handle を継承していても、この時点で強制終了され、drain がハングしない。

## Rationale

### nested job 実験の証拠

本決定に先立ち、この開発機（Node 24.19、Windows 11）で次を実機検証した: libuv 既定の Job（`SILENT_BREAKAWAY_OK` 設定）に入った直接の子プロセスへ、breakaway フラグ無しの HDO 自前の Job を後から `AssignProcessToJobObject` で追加割り当てすると、**nested job** として成立する。Windows の Job Object は、あるプロセスが breakaway を許可しない Job のメンバーである場合、そのプロセスが新たに生成する子プロセスも（明示的に `CREATE_BREAKAWAY_FROM_JOB` を要求してそれが許可されない限り）自動的に同じ Job のメンバーになる、という規則を持つ。libuv は `CREATE_BREAKAWAY_FROM_JOB` を明示的に要求しないため、HDO の Job に後から割り当てられた直接の子が pwsh 経由で生成する孫プロセスも HDO の Job のメンバーになる。実験では、pwsh 経由で生成された孫プロセス（`IsProcessInJob` で確認）が、`CloseHandle(job)` によって実際に終了し、継承していた stdout pipe handle も解放されることを確認した。

この実装を `NodeProcessRunner` に組み込んだ結果、以下が実測で確認できている（本 PR のテスト実行時点、Windows 11 実機）:

- `src/platform/jobObject.test.ts`: `tests/fixtures/runtime/hold-output-handle.ps1` シナリオを実際の `NodeProcessRunner` + Windows `PlatformAdapter` で実行し、exitCode 0・`outputDrainTimedOut: false`・孫 PID が `tasklist` で見つからないことを確認。
- `src/process/processParity.test.ts`: 同シナリオを pwsh の `Invoke-HdoProcess`（oracle）と TypeScript 実装の両方で実行し、タイムスタンプ系フィールドを除いて結果が完全一致することを確認（Windows）。
- `src/process/runner.test.ts` の「bounded output drain」テスト: `stdio: 'inherit'` で生成された孫プロセス（親プロセス自体は `detached` されていない）が、親プロセスの `dispose()` によって drain timeout（2秒）を待たずに終了することを確認。

### OpenProcess という追加ステップ

PowerShell の `KillOnCloseJob.TryAttach(Process process)` は `process.Handle`（.NET `Process` オブジェクトが `Process.Start()` の時点で既に開いている handle）を直接 `AssignProcessToJobObject` に渡すため、追加の handle 取得ステップを必要としない。Node の `child_process.spawn()` は PID しか返さないため、本実装は `OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)` で改めて handle を取得する必要がある。これは PowerShell 実装に対応物が無い、本実装固有の追加ステップであり、次の2点が PowerShell 実装との差分として残る:

1. **エラー文言**: `OpenProcess` 失敗時の `"OpenProcess failed with Win32 error N."` は PowerShell 側に存在しない。
2. **残存する spawn→assign race**: spawn から `OpenProcess`/`AssignProcessToJobObject` が完了するまでの間、理論上は対象プロセスが極めて短時間で終了し、その PID が別の無関係なプロセスに再利用される可能性がゼロではない。この race 自体は PowerShell 実装にも存在する（`Process.Start()` から `AssignProcessToJobObject` 呼び出しまでの間隙）が、本実装は「PID を渡して handle を取得し直す」という追加ステップがある分、この窓がわずかに広い。実務上のリスクは、対象プロセスが数ミリ秒未満で終了し、かつ同一 PID が即座に再利用される、という組み合わせが必要であり、極めて低い。

### 代替案として検討したもの

- **既知限界として受容する**（ADR-0001 の選択肢 (ii)）: `taskkill /T /F` に恒久的に依存し、`outputDrainTimedOut: true` を Windows でも許容する。実装コストはゼロだが、`hold-output-handle.ps1` 相当のシナリオで PowerShell 実装より明確に劣化した挙動になり、ADR-0001 の Rationale が「両実装が同じ状況を再現しているのではなく、PowerShell に実在する優位である」と明言した gap を埋めないまま Migration strategy を進めることになる。
- **helper process**（別途 .NET/C# の小さな helper 実行ファイルを同梱し、Job Object 操作だけを委譲する）: 確実に動作するが、配布物に .NET runtime または自己完結型 helper バイナリが増え、`npm ci` だけで完結する現在の配布モデル（`docs/architecture.md` 16.3）から外れる。ADR-0001 の Consequences が既に許容した「native addon/FFI で取り戻す場合はビルド・配布の複雑性が増す」の範囲を超える追加コストになる。
- **ffi-napi / node-gyp ベースの native addon**: `ffi-napi` は事実上メンテナンスが停止しており、Node の ABI 変更への追随がない。`node-gyp` ベースの自前 addon はビルド環境（Visual Studio Build Tools 等)を CI・開発者双方に要求し、`npm ci` だけで完結しなくなる。`koffi` はプリビルドバイナリを optional dependency として配布するため、通常の `npm install`/`npm ci` だけで動作し、コンパイル環境を要求しない。

## Consequences

**Positive**:

- `hold-output-handle.ps1`/`ignore-input.ps1` 相当の Windows シナリオで PowerShell 実装と同等の結果（孫プロセスの確実な終了、`outputDrainTimedOut: false`）を得られ、ADR-0001 の Migration strategy フェーズ2 終了条件を「既知限界の受容」ではなく「実装による解消」で満たす。
- Job Object が利用できない環境（koffi 未対応の platform/architecture、Win32 API 呼び出し失敗等）でも `taskkill /T /F` へ自動的にフォールバックし、runner 自体は失敗しない（`ProcessContainer.attached === false` を経由）。

**Negative（supply-chain）**:

- `koffi` は MIT ライセンスの単一メンテナー（Niels Martignène, "Koromix"）による package である。`bus factor` が低い。
- `koffi` は platform 別の prebuilt binary を `@koromix/koffi-<os>-<arch>` という **optional dependency** 群として配布する（本 PR の `package-lock.json` には koffi が対応する OS・arch の組み合わせ全て - Windows/macOS/Linux/Android/FreeBSD/OpenBSD の各 arch 分 - が記録される。訂正: 以前の版は OpenBSD を列挙から落としていた）。各 optional dependency package は `package.json` に `os`/`cpu` フィールドを持ち、`npm ci`/`npm install` は **ホストの OS/arch と一致しないものを自動的にスキップする**（訂正: 以前の版は「`npm ci` は宣言されたすべての optional dependency のダウンロードを試みる」としていたが誤り）。実機確認: この開発機（Windows x64）では `node_modules/@koromix/` 配下に `koffi-win32-x64` のみが実際にインストールされ、他の `koffi-<os>-<arch>` はダウンロードされない。
- `koffi` 自身の `install` script（`node ./cnoke.cjs -P . -D src/koffi --prebuild --release`）は `cnoke`（`koffi` と同じ作者のビルドツール）を使い、対応する prebuilt binary が存在する場合はそれをダウンロードするだけでコンパイルは行わない（本 PR の環境で実測: `npm install` 後、追加のコンパイル過程は発生せず、`koffi.load("kernel32.dll")` が即座に成功した）。prebuilt binary が存在しない環境（未対応 platform/arch）でのみソースからのビルドを試みる。
- exact version pin（`3.2.1`）により、`npm audit`/Dependabot 等の自動更新は本 package に対しては提案されるがそのまま自動適用はされない。更新は都度 review する。

**Neutral**:

- `src/core/**` は本 ADR の影響を受けない（`koffi` は `src/platform/**` からのみ import され、`src/core/boundary.test.ts` の allow-list は変更していない）。
- POSIX（Linux/WSL2）は本 ADR の対象外（ADR-0001 Amendment 2026-09-05 により Windows が一次ターゲット）。`PlatformAdapter.createProcessContainer` の POSIX 実装は no-op container（`attached: false`）のままであり、`killProcessTree`（`process.kill(-pid, 'SIGKILL')`）に引き続き依存する。

## References

- ADR-0001（`docs/adr/0001-primary-runtime-typescript.md`）Migration strategy フェーズ2、Rationale「最も強い反論」
- `src/platform/jobObject.ts`（実装）、`src/platform/jobObject.test.ts`（Windows 実機テスト）
- `src/process/runner.ts`（`NodeProcessRunner` - container の attach/terminate/dispose 呼び出し箇所）
- `src/process/processParity.test.ts`（pwsh oracle との parity test）
- PowerShell oracle: `src/HybridDevOrchestrator/Private/Common.ps1` の `BoundedProcessCapture.KillOnCloseJob`
- `tests/fixtures/runtime/hold-output-handle.ps1`
- koffi: https://koffi.dev/ , https://github.com/Koromix/koffi
