---
schema: 1
id: PDR-20261118-routine-initial-migration
key: triggers.routine-initial-migration
status: accepted
date: "2026-11-18"
areas: [triggers, deployment]
keywords: [Routine, ルーチン, 名称, 初回移行, 単一利用者, デプロイ, 運用]
paths:
  - docs/plans/trigger-run-abstraction.md
  - apps/api/src/application/triggers/**
  - apps/api/src/infrastructure/d1/**
symbols: []
supersedes: []
decided_by: suzuki3jp
---

# Routine と呼び、初回移行は Run のない状態で行う

## 決定

トリガー条件と prompt・model・effort などの実行設定を束ねる定義を `Routine` と呼ぶ。一回の実行は引き続き `Run` と呼ぶ。

label 起動の Routine への初回移行は、本番の利用者が運用者一人である前提で行う。運用者が queued / running の Run のない状態を作り、移行・デプロイ中は新規起動や設定編集を控える。

この運用で避けられる状況に対する専用の安全策は実装しない。旧 Worker との並行書込みを支える互換トリガー、受付の自動停止・排出、旧 active Run のキー変換・引継ぎ、段階公開や旧版復帰のためだけの互換層は追加しない。移行前の配送を新しい Routine の配送として再送するためだけの互換 lookup も追加しない。

## 理由

Routine はイベントに応じて行う定義済みの作業を表し、実行結果の Run と区別できる。定期実行だけに限定せず、label・PR 等のイベントによる起動にも使う名称とする。

利用者が一人で、移行中の実行や変更を運用で止められる段階では、新旧版を並行稼働させるための仕組みを作る費用に見合う必要性がない。Run のない状態で設定と実装を一括で移せば、初期実装を小さくできる。

## 範囲と例外

今回の Routine 初回移行に適用する。既存 Project の label 設定を Routine へ移す処理と、過去の Session・Run・履歴の保持は必要である。既存の復旧処理や他の移行で導入済みの互換処理を削除する指示ではない。

移行後の日常運用における配送の重複排除、同時実行、設定更新との競合、失敗した Run の復旧とは区別する。それらの仕様は [受付の判断](PDR-20261118-label-routine-dispatch.md) で別途扱い、この判断で無効化しない。plan の参照に必要なデータ構造の調整も、デプロイ互換層とは区別する。

## 再検討条件

複数の利用者が本番を使う、または Run を止めずにデプロイする必要が生じた段階で、必要な互換性と公開方法を改めて判断する。
