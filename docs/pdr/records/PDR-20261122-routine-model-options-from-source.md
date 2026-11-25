---
schema: 1
id: PDR-20261122-routine-model-options-from-source
key: triggers.routine-model-options
status: "superseded"
date: "2026-11-22"
areas: [triggers, agent, web]
keywords: [Routine, モデル, effort, Codex, 選択式]
paths:
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/web/src/_pages/projects/**
symbols: [codexModels]
supersedes: [PDR-20261118-routine-model-options]
decided_by: suzuki3jp
---

# Routine のモデルと effort を Tailos 定義の候補から選択する

## 決定

Routine のモデルと effort は、Tailos のソースに定義した Codex の候補から選択する。どちらも「既定」を選べる。effort の候補は選択したモデルに合わせ、モデルが既定の場合は一覧の全モデルで使える値を表示する。

## 理由

識別子の入力ミスを避けるため選択式を維持する。候補の出所は [ソース内定義の判断](PDR-20261122-codex-model-catalog-in-source.md) に合わせ、接続や取得の成否に関係なく表示できるようにする。

## 範囲と例外

候補は接続の有無にかかわらず表示する。一覧に保存済みの値がない場合も、編集画面では保存済みの値を表示する。接続がない場合の無効状態での保存と、有効化時の検証には従来の規則を適用する。Routine で選べるエンジンは Codex とする。
