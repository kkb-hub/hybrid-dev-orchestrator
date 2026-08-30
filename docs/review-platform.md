# レビュー基盤（review platform）の同居に関する記録

- 文書種別: 決定記録 + スコープ定義
- 対象リポジトリ: kkb-hub/hybrid-dev-orchestrator
- 出自: kkb-hub/net-equity issue #106（レビュー基盤の plugin 化と Claude Code / Codex 両対応）
- ステータス: Draft for review（実装は本リポジトリのワークスペースで行う。本文書はその前提となる決定の記録）
- 最終更新: 2026-08-30

## 1. 何を決めたか

`net-equity` で運用してきた **AI エージェントレビュー基盤**（多段レビュー・反証・変異検証・token telemetry）のうちリポジトリ固有でない部分を、新規リポジトリではなく**本リポジトリへ切り出して同居させる**。配布形態は Claude Code plugin とし、**Codex 対応（adapter）も MVP に含める**。

決定の経緯と契約項目の正典は net-equity issue #106 のコメント群にある:

- 契約項目1〜6: https://github.com/kkb-hub/net-equity/issues/106#issuecomment-5455717550 とその訂正追記
- 契約項目7〜15（PR #128〜#133 の棚卸し）: https://github.com/kkb-hub/net-equity/issues/106#issuecomment-5468307728
- スコープ再定義（切り出し先・MVP 範囲・着手条件）: https://github.com/kkb-hub/net-equity/issues/106#issuecomment-5468659486

## 2. なぜ同居させるか

HDO の要件定義（`docs/requirements.md`）が既に、レビュー基盤の core と同じ層のものを計画しているためである:

- review result の **JSON Schema + CI 検証**（§24 `schemas/` / §25 / AC-04, AC-06, AC-20）
- **bounded fix loop**（最大3回 + Human への escalate。§15）
- `agents/hybrid-reviewer.md` と「Claude Code Skill + review loop」（§24 / §32-6）
- **Codex CLI adapter 層**（CLI フラグ・config キーを1層へ閉じ込める。§6.4）

別リポジトリにすると review finding の schema が2箇所にでき、写しとして古びる（net-equity 側の実測で繰り返し確認された failure mode。#106 契約項目14）。HDO は現状ドキュメントのみの greenfield であり、schema を最初から1つに設計できる。

## 3. 同居の条件（3つ）

1. **レビュー基盤は HDO orchestrator から独立に導入できる plugin として置く。** Ollama / GPU / PowerShell / Windows native は HDO の MVP 前提（requirements §5）であって、レビュー規律の前提ではない。ディレクトリと導入単位を分け、レビュー基盤側から HDO 固有物（provider profile、worktree lifecycle、preflight）へ依存させない。
2. **schema の定義元は1箇所。** HDO の `schemas/` の review result schema と、レビュー基盤の finding schema を別々に作らない。mutation manifest・usage report も同じ扱い。HDO 側・plugin 側のどちらから見ても同じファイルが定義元になる配置とする。
3. **レビューの体制は分ける。** HDO のレビューは「Claude が local worker の成果を審査する」単独レビュアー形（requirements §11・§15）、net-equity で運用してきたのは「多視点レンズ + 反証 + 変異検証 + 検証ラウンド」の多段形である。**finding schema と fix loop の規律は共有し、体制（レンズ構成・反証のバッチ分割・変異検証）はレビュー基盤側の持ち物**として HDO の MVP スコープに混ぜない。

## 4. レビュー基盤の構成（3層）

- **core**（harness 非依存）
  - finding schema —— `evidence: measured | read` を必須項目に持つ（#106 契約項目4）
  - mutation manifest と runner の契約 —— 変異元の一意性検証・exit 階級（検出 / 生存 / 判定不能）・変異ごとの「どの門で測るか」・投入前のベースライン緑検証（項目5・9・10）
  - usage report schema —— 層別の軸（unit / form / launch / subject / size-band）をフィールドに持つ（層別定義の正典: https://github.com/kkb-hub/net-equity/issues/107#issuecomment-5468748449）
  - fix loop・反証の規律 —— 検出の担い手の判定・反証の id 名前空間とバッチ分割の制約・反証の主産物は verdict ではなく訂正・推奨字面の検証状態（項目8・11・12・13）
- **adapters** —— claude-code（plugin: skills + agents + scripts）と codex（`AGENTS.md` 経路 + 書式の揃え）。**両方 MVP。** Codex adapter は HDO 側 §6.4 の adapter 層と共有部品になる
- **project-contract** —— 各利用リポジトリが書く harness 非依存の1ファイル。門（検査コマンド）の一覧と exit 階級・その環境で判定不能になる門と代替の確かめ方・変異検証に使う検査コマンド・実行禁止事項を宣言する（項目15）。net-equity の「8つの門」「本番 Cloudflare 禁止」「Windows の既存赤3件」はすべてこちら側であり、本リポジトリには入らない

## 5. HDO との共有物と境界

| もの | 定義元 | HDO 側の消費 | レビュー基盤側の消費 |
|---|---|---|---|
| finding / review result schema | 1箇所（配置は実装 PR で確定） | §15 の approve / request_changes / escalate の findings | 多段レビューの所見・反証・対応の突合 |
| fix loop の規律（有限回 + escalate） | core | §15（最大3回） | ラウンド規律（R 決定・最終ラウンド規律） |
| Codex adapter | adapters/codex | worker harness としての呼び出し（§6.4） | Codex を review harness として使う経路 |
| usage report schema | core | run artifacts への記録（§18 との整合を実装 PR で確認） | token telemetry の報告書式 |
| レビュー体制（レンズ・反証・変異検証） | レビュー基盤（claude-code adapter） | 使わない（MVP は単独レビュアー形） | 使う |
| provider profile / worktree lifecycle / preflight | HDO | 使う | 使わない（依存しない） |

## 6. 実装 PR で扱うべき編集課題（実装前レビューの論点）

1. **根拠の一般化** —— net-equity の skill 群は規則の根拠を `PR #<n> ラウンド<r> の指摘<m>` の形で数百件埋め込んでおり、汎用側ではこの引用が解決できない。一般化して書き直すか、事例集として別添するかを決める。
2. **規則の定義元の置き場** —— skill 群は生きた文書である（net-equity 側で高頻度に改版されてきた）。切り出し後の学びをどちらのリポジトリへ書くか・改版を利用側リポジトリへどう届けるかを先に決める。決めないと切り出した直後から乖離が始まる。
3. **配置** —— §24 の想定リポジトリ構成にレビュー基盤のディレクトリ（例: `plugins/review-kit/`）をどう足すか。条件1（独立導入）と条件2（schema 1箇所）を同時に満たす形を実装 PR で確定する。

## 7. 利用側（net-equity）の切り替え条件

net-equity 側の切り替えは、実 PR 1〜2本を新基盤経由で回して **finding 数・製品バグ数・反証後の生存・変異の検出/生存を従来と併記する並走検証**を通ってから行う。削減率だけで成功を語らない（net-equity #105 の非目標を品質ゲートとして引き継ぐ）。

## 8. 本文書の扱い

- 本文書は決定の記録であり、実装の詳細（ディレクトリ名・schema のフィールド名・plugin manifest）は実装 PR で確定する。確定したら本文書ではなく実装側の文書を正典とし、本文書からは参照だけにする（写しを持たない）。
- HDO 本体の要件は `docs/requirements.md` が正典のまま変わらない。本文書が HDO の MVP スコープ（Windows native / local worker）を広げることはない。
