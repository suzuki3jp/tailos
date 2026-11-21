---
schema: 1
id: PDR-20261118-routine-model-options
key: triggers.routine-model-options
status: superseded
date: "2026-11-18"
areas: [triggers, agent]
keywords: [Routine, モデル, effort, Codex]
paths:
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/web/src/_pages/projects/**
symbols: []
supersedes: []
decided_by: suzuki3jp
---

# Routine のモデルと effort を選択式にする

## 決定

Routine のモデルと effort は、接続中の Codex アカウントから取得した候補を選択する。どちらも「既定」を選べる。effort の候補は選択したモデルに合わせ、モデルが既定の場合は一覧の全モデルで使える値を表示する。

## 理由

保存時と同じモデル一覧を使えば、識別子の入力ミスを避け、Codex の提供状況を選択肢に反映できる。

## 範囲と例外

モデル一覧の取得は Project の所有者に限定する。取得できない場合や一覧に保存済みの値がない場合も、編集画面では保存済みの値を表示する。接続がない場合の無効状態での保存と、有効化時の検証には従来の規則を適用する。Routine で選べるエンジンは Codex とする。
