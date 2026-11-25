---
schema: 1
id: PDR-20261126-agent-selection-claude
key: agent.selection
status: accepted
date: "2026-11-26"
areas: [agent, triggers, runs, sessions, web]
keywords: [Routine, engine, codex, claude, Model Provider, プロバイダー, model, effort, モデル, 既定値, 接続, ホーム, Session 画面]
paths:
  - apps/api/src/application/routines/**
  - apps/api/src/application/sessions/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/web/src/features/compose-loop/**
  - apps/web/src/_pages/projects/**
  - packages/core/src/runner.ts
  - packages/core/src/models.ts
symbols: [routineSettings, startSessionFromMessage, continueSession, ExecutionContext, supportsSelection]
supersedes: [PDR-20261118-automation-agent-selection]
decided_by: suzuki3jp
---

# Agent は Routine の設定と入力欄のモデル選択で選び、Codex と Claude に対応する

## 決定

Turn を実行する Agent（Model Provider）として Codex と Claude を選べるようにする。どちらを使うかは、Turn を始める経路ごとに次のように決める。

- **Routine**: Routine の実行設定に engine（`codex` または `claude`）・model・effort を持たせ、その値で Turn を始める。Project 全体の `agent` は使わない。
- **ホームからの開始**: 入力欄のモデル選択で Model Provider も選ぶ。選択肢は Provider ごとにまとめ、各 Provider の「既定のモデル」も選べる。何も選ばなければ Codex の既定とする。
- **Session 画面からの続き**: 入力欄のモデル選択で選べるのは、その Session の Provider のモデルと effort だけとする（[Session の Provider の判断](PDR-20261126-session-agent-provider.md)）。

model・effort は未指定を許し、その場合は Provider の既定を使う。明示値は黙って別のモデル・effort に置き換えず、保存・受付時の検証と実行時の失敗結果で追えるようにする。候補は [モデル候補の判断](PDR-20261126-agent-model-catalog.md) の一覧とする。

Turn を受け付けるときに、指定された engine・実行設定・接続の識別子を保存し、実行開始・復旧・再送時に最新の Routine から読み直さない。必要な接続（Codex は ChatGPT 接続、Claude は Claude 接続）がない場合は、別の engine や他人の接続へ切り替えず、受け付けない（Routine では有効化できない）。秘密情報を Routine や実行設定に保存しない。

## 理由

Claude の実行経路（接続、Runner の Adapter、公開ツール、作業の引き継ぎ、認証情報の差し込み）がそろったので、前の記録が後続とした Claude の選択を有効にする。Routine は起動条件と依頼を束ねる単位で、どの Agent で動かすかもその Routine の性格に属するため、Routine ごとに選ぶ。ホームと Session 画面では、利用者が依頼のたびにモデルを選ぶ入力欄があるので、同じ選択の中で Provider も選べるようにし、項目を増やさない。

## 範囲と例外

[ホームからの開始の判断](PDR-20261126-home-message-start-provider.md)、[Session 画面からの続きの判断](PDR-20261126-session-message-provider.md)、[Routine のモデル選択の判断](PDR-20261126-routine-model-options-provider.md) は、この記録に合わせて Provider を扱う。既存の Routine と Turn の engine は `codex` のまま読み、保存済みの行は書き換えない。

モデル識別子と effort の組み合わせは各 Provider の一覧で確認する。有効化時の接続確認と、確認できない場合の無効状態での保存は [保存・有効化の判断](PDR-20261118-routine-configuration-validation.md) に従い、確認する接続は Routine の engine のものとする。Claude の接続は貼り付けた長期 OAuth トークンに限る（[Claude 接続の判断](PDR-20261114-008.md)）。

## 選択肢と影響

- **Project 全体で Agent を一つ選ぶ案**: Routine や依頼ごとに Agent を使い分けられない。採用しない。
- **Provider の選択を入力欄の別項目にする案**: 項目が増え、Provider とモデルの組み合わせが合わない入力を作れてしまう。採用しない。

不利益として、Routine の engine を後から変えると、その Routine が続けている Issue の Session では前の Provider の会話を引き継がない（[Session の Provider の判断](PDR-20261126-session-agent-provider.md)）。
