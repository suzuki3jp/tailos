---
schema: 1
id: PDR-20261126-agent-model-catalog
key: triggers.routine-model-catalog-transport
status: accepted
date: "2026-11-26"
areas: [triggers, agent, web]
keywords: [モデル候補, モデル一覧, effort, Codex, Claude, Claude Code, Agent SDK, supportedModels, model/list, 静的定義, 同梱カタログ, codexModels, claudeModels]
paths:
  - packages/core/src/models.ts
  - apps/runner/src/codex-agent.ts
  - apps/runner/src/claude-agent.ts
  - apps/api/src/application/routines/routines.ts
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/web/src/features/compose-loop/**
  - apps/web/src/_pages/projects/**
symbols: [codexModels, claudeModels, agentModels, supportsSelection]
supersedes: [PDR-20261122-codex-model-catalog-in-source]
decided_by: suzuki3jp
---

# Codex・Claude のモデル・effort 候補を Tailos のソースに定義する

## 決定

Codex と Claude のモデルと effort の候補は、Tailos のソースコード（`packages/core` の共有定義）に Provider ごとに記述した一覧を正とする。Web の入力欄（Composer のモデル選択と Routine の編集画面）はこの一覧をそのまま表示し、API の保存・受付時の検証と Runner の実行前確認も同じ一覧を使う。アカウントごとの一覧取得と、そのための専用 Runner コンテナ起動は行わない。

- **Codex**: Runner が導入する Codex CLI の版に同梱されたカタログのうち、一覧表示対象のモデルと各モデルの effort を、同梱カタログの優先順で写す。
- **Claude**: Runner が導入する Agent SDK の版に同梱された Claude Code が選択肢として示すモデルを、別名ではなく解決後のモデル識別子で写し、各モデルが対応する effort をすべて載せる。Agent SDK 0.3.319（Claude Code 2.1.319）では `claude-sonnet-5-5`・`claude-fable-5-1`・`claude-opus-5-5`・`claude-haiku-5-5` の 4 つで、いずれも effort は `low`・`medium`・`high`・`xhigh`・`max`。

各 CLI・SDK の版を上げるときに一覧も更新する。Runner のテストで、一覧の基にした版と Runner の Dockerfile の版が一致することを確かめる。

## 理由

アカウントごとの一覧取得には所有者の接続と専用コンテナの起動が必要で、失敗点が多く費用もかかる。以前、Codex の一覧取得が失敗して「既定」しか選べなくなった。Runner が使う CLI・SDK の版は固定されており、その版が扱えるモデルと effort は同梱の定義で確定するので、ソースに定義しても実用上の候補は変わらない。

Claude の候補は、利用者が今の Claude Code で使えるモデルと effort をすべて選べることを求めたため、Claude Code が示すモデルと、それぞれの effort をすべて載せる。別名（`opus` など）は Claude Code の版によって指すモデルが変わるので、保存した設定の意味が変わらないよう解決後の識別子を使う。

## 範囲と例外

一覧の存在はアカウントでの利用可否や推論成功を保証しない。プラン・提供状況の変更による実行時エラーは、Turn の失敗として扱い、別モデルへの暗黙の切替はしない。

モデルを指定しない場合は Provider の既定モデルが選ばれるため、effort はその Provider の一覧の全モデルで使える値だけを有効な Routine に許す。一覧にないモデルや、どのモデルでも使えない effort は、接続の有無にかかわらず保存・受付時に拒否する。有効化時の接続確認、および確認できない場合の無効状態での保存は [設定検証の判断](PDR-20261118-routine-configuration-validation.md) に従う。

## 選択肢と影響

- **アカウントの一覧取得を優先し、失敗時だけ定義に戻す案**: 取得失敗の原因と費用を残し、表示と検証の基準が状況で変わるため採用しない。
- **Claude の別名（`opus`・`sonnet` など）を候補にする案**: 新しいモデルに自動で追従するが、保存した設定の意味が版の更新で変わる。採用しない。

定義の更新を忘れると、新しいモデルが表示されない、または同梱の定義から外れたモデルが残る不利益がある。
