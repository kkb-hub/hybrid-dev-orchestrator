# Architecture Decision Records

ADR は HDO のアーキテクチャに関わる重要な決定と、その背景・根拠・影響を記録する文書である。決定を後から覆す場合も、既存 ADR は編集せず新しい ADR を追加し、古い方を `Superseded` にする。

ファイル名は `NNNN-short-title.md`（4桁連番、決定単位で採番、欠番・再利用はしない）。

`Status` に使う語彙: `Proposed`（提案中、未確定）、`Accepted`（確定・有効）、`Superseded`（後続 ADR に置き換えられた。置き換えた ADR 番号を併記する）。

## Index

- [ADR-0001](0001-primary-runtime-typescript.md) — HDO の primary implementation runtime（Accepted 2026-09-05）
