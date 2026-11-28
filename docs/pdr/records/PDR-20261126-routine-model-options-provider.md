---
schema: 1
id: PDR-20261126-routine-model-options-provider
key: triggers.routine-model-options
status: accepted
date: "2026-11-26"
areas: [triggers, agent, web]
keywords: [Routine, モデル, effort, Codex, Claude, engine, Model Provider, 選択式]
paths:
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/web/src/_pages/projects/**
symbols: [codexModels, claudeModels, agentModels]
supersedes: [PDR-20261122-routine-model-options-from-source]
decided_by: suzuki3jp
---

# Routine の Provider・モデル・effort を Tailos 定義の候補から選択する

## 決定

Routine の Model Provider（engine）は Codex と Claude から選び、モデルと effort は、Tailos のソースに定義したその Provider の候補から選択する。モデルと effort はどちらも「既定」を選べる。effort の候補は選択したモデルに合わせ、モデルが既定の場合はその Provider の一覧の全モデルで使える値を表示する。Provider を変えたら、モデルと effort は既定に戻す。

## 理由

識別子の入力ミスを避けるため選択式を維持する。候補の出所は [ソース内定義の判断](PDR-20261126-agent-model-catalog.md) に合わせ、接続や取得の成否に関係なく表示できるようにする。

## 範囲と例外

候補は接続の有無にかかわらず表示する。一覧に保存済みの値がない場合も、編集画面では保存済みの値を表示する。接続がない場合の無効状態での保存と、有効化時の検証には従来の規則を適用する。Provider の選び方は [Agent の選択の判断](PDR-20261126-agent-selection-claude.md) に従う。
