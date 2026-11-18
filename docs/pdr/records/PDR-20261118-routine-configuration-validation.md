---
schema: 1
id: PDR-20261118-routine-configuration-validation
key: triggers.routine-configuration-validation
status: proposed
date: "2026-11-18"
areas: [triggers, agent, auth]
keywords: [Routine, 下書き, 無効, enabled, 接続不在, モデル検証, 有効化]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/web/src/_pages/projects/**
symbols: []
supersedes: []
---

# 接続やモデル情報を確認できない Routine も無効状態で保存する案

## 決定

提案。必要な接続がない場合やモデルの対応情報を取得できない場合でも、Routine を無効状態で保存できるようにする。有効化するときには接続の存在と実行設定の対応状況を確認する。形式の誤りや既知の未対応値は保存時に拒否する。

「下書き」は無効な Routine を保存しておくことを指す説明であり、`draft` 等の別状態や別資源は追加しない。無効な Routine はトリガーに一致しても起動しない。

## 理由

接続を用意する前に設定を準備したり、能力情報の一時的な取得失敗中も編集内容を保持したりできる。一方、保存できることと実行可能であることが異なるため、有効化時の説明と検証が必要になる。

## 範囲と例外

この保存・有効化の規則は未採択である。新規 Routine の初期状態を無効にする判断は [受付の判断](PDR-20261118-label-routine-dispatch.md) で別途採択済みだが、接続・能力情報の検証失敗時にも保存を許すかは本提案で扱う。

有効化後の接続切れや provider の提供変更まで防げる保証ではない。実行時の失敗を別 engine・モデル・他の所有者の接続への暗黙の切替で回避しない。

## 未決事項

無効状態なら未検証の設定を保存できる案を採るか、それとも接続・モデル情報を検証できるまで保存自体を拒否するか。
