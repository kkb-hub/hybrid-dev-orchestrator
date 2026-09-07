# lean worker 比較: 依存 0 ベースライン vs AI SDK PoC

ADR-0001 Migration strategy 項目8 step (c) の採否判断のための実測。`poc/ai-sdk/scripts/compare.mjs` が生成する。数値は再現可能だが、**ローカルモデルは非決定的であり、下表はいずれも n=3 の中央値（括弧内は min-max）である**。少数試行の中央値を精密な測定値として読まないこと。

## 実行環境

| 項目 | 値 |
|---|---|
| date | 2026-09-07T06:55:07.203Z |
| model | qwen3.8:27b-q4_K_M |
| ollamaVersion | 0.33.3 |
| ollamaUri | http://127.0.0.1:11434 |
| node | v24.20.0 |
| platform | win32 x64 |
| repetitions | 3 |
| baselineEntry | src/workers/leanWorker/main.ts |
| pocEntry | poc/ai-sdk/src/main.ts |
| journal | poc/ai-sdk/results/runs.jsonl |
| resumedRuns | 18 |

## 指標の定義

- **prompt_tokens 合計**: 各 turn の `prompt_tokens` と最終 schema 強制 turn の `prompt_tokens` の総和。
  1回の request のサイズではなく、run 全体でサーバが評価した prompt の累計である。履歴を厚く持つ実装は毎 turn その分を払うため、この累計が context 管理の良否を映す。
- **completed**: exit 0 かつ `-OutputFile` が `schemaVersion=1` と非空の `summary` を持ち、かつ **workspace 上で実際にタスクが達成されている**（全対象ファイルの off-by-one が直っている）ことの全てを満たす run の数。空の報告書を書いて 0 で終了した run は completed に数えない。
- **tool 失敗**: worker が stderr に書いた `WARNING: tool '<name>' failed: ...` の件数。tool call 総数に対する比率が tool call 精度に当たる。
- **compactions**: `final:` 行が報告した compaction 回数。

## シナリオ `offbyone` — single-file off-by-one fix at the production 32K window

| 実装 | completed | exit 0 | 出力妥当 | タスク達成 | prompt_tokens 合計 | turns | tool calls | tool 失敗 | compactions | 実時間 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (zero-dep) | 3/3 | 3/3 | 3/3 | 3/3 | 4413 (4393-4431) | 3 | 2 | 0 | 0 | 10.1 (8.1-11.2) |
| poc (ai sdk) | 3/3 | 3/3 | 3/3 | 3/3 | 4442 (4437-4442) | 3 | 2 | 0 | 0 | 7.9 (7.8-9.7) |

## シナリオ `compaction-4k` — three-file fix at a 4K window that forces mid-task history rewrites

| 実装 | completed | exit 0 | 出力妥当 | タスク達成 | prompt_tokens 合計 | turns | tool calls | tool 失敗 | compactions | 実時間 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (zero-dep) | 3/3 | 3/3 | 3/3 | 3/3 | 9139 (5632-19032) | 5 (3-11) | 6 (4-21) | 0 | 4 (2-9) | 55.2 (32.8-145.3) |
| poc (ai sdk) | 3/3 | 3/3 | 3/3 | 3/3 | 10484 (5430-11074) | 6 (3-6) | 7 (4-10) | 0 | 5 (2-5) | 64.3 (27.2-67.4) |

## シナリオ `compaction-32k` — the same three-file task at the production 32K window (32K stability)

| 実装 | completed | exit 0 | 出力妥当 | タスク達成 | prompt_tokens 合計 | turns | tool calls | tool 失敗 | compactions | 実時間 (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (zero-dep) | 3/3 | 3/3 | 3/3 | 3/3 | 7017 (5031-7157) | 4 (3-4) | 5 (4-6) | 0 | 0 | 14.9 (12.7-25.2) |
| poc (ai sdk) | 3/3 | 3/3 | 3/3 | 3/3 | 8197 (6868-9737) | 5 (4-5) | 6 (5-8) | 0 | 0 | 13.3 (10.0-18.0) |

## 個別 run

| run | completed | exit | prompt_tokens | turns | tool calls | 失敗 | compactions | 実時間 (s) |
|---|---|---|---|---|---|---|---|---|
| `offbyone--baseline--rep1` | yes | 0 | 4393 | 3 | 2 | 0 | 0 | 8.1 |
| `offbyone--poc--rep1` | yes | 0 | 4437 | 3 | 2 | 0 | 0 | 7.9 |
| `offbyone--baseline--rep2` | yes | 0 | 4431 | 3 | 2 | 0 | 0 | 11.2 |
| `offbyone--poc--rep2` | yes | 0 | 4442 | 3 | 2 | 0 | 0 | 7.8 |
| `offbyone--baseline--rep3` | yes | 0 | 4413 | 3 | 2 | 0 | 0 | 10.1 |
| `offbyone--poc--rep3` | yes | 0 | 4442 | 3 | 2 | 0 | 0 | 9.7 |
| `compaction-4k--baseline--rep1` | yes | 0 | 19032 | 11 | 21 | 0 | 9 | 145.3 |
| `compaction-4k--poc--rep1` | yes | 0 | 5430 | 3 | 4 | 0 | 2 | 27.2 |
| `compaction-4k--baseline--rep2` | yes | 0 | 9139 | 5 | 6 | 0 | 4 | 55.2 |
| `compaction-4k--poc--rep2` | yes | 0 | 10484 | 6 | 10 | 0 | 5 | 67.4 |
| `compaction-4k--baseline--rep3` | yes | 0 | 5632 | 3 | 4 | 0 | 2 | 32.8 |
| `compaction-4k--poc--rep3` | yes | 0 | 11074 | 6 | 7 | 0 | 5 | 64.3 |
| `compaction-32k--baseline--rep1` | yes | 0 | 7157 | 4 | 6 | 0 | 0 | 25.2 |
| `compaction-32k--poc--rep1` | yes | 0 | 6868 | 4 | 5 | 0 | 0 | 10.0 |
| `compaction-32k--baseline--rep2` | yes | 0 | 5031 | 3 | 4 | 0 | 0 | 12.7 |
| `compaction-32k--poc--rep2` | yes | 0 | 8197 | 5 | 6 | 0 | 0 | 13.3 |
| `compaction-32k--baseline--rep3` | yes | 0 | 7017 | 4 | 5 | 0 | 0 | 14.9 |
| `compaction-32k--poc--rep3` | yes | 0 | 9737 | 5 | 8 | 0 | 0 | 18.0 |

