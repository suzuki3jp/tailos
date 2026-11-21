---
schema: 1
id: PDR-20261122-codex-model-catalog-in-source
key: triggers.routine-model-catalog-transport
status: accepted
date: "2026-11-22"
areas: [triggers, agent, web]
keywords: [モデル候補, モデル一覧, effort, Codex, model/list, 静的定義, 同梱カタログ, codexModels]
paths:
  - packages/core/src/models.ts
  - apps/runner/src/codex-agent.ts
  - apps/api/src/application/routines/routines.ts
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/web/src/features/compose-loop/**
  - apps/web/src/_pages/projects/**
symbols: [codexModels, supportsCodexSelection]
supersedes: [PDR-20261119-routine-model-catalog-transport]
decided_by: suzuki3jp
---

# Codex のモデル・effort 候補を Tailos のソースに定義する

## 決定

Codex のモデルと effort の候補は、Tailos のソースコード（`packages/core` の共有定義）に記述した一覧を正とする。Web の入力欄（Composer のモデル選択と Routine の編集画面）はこの一覧をそのまま表示し、API の保存時検証と Runner の実行前確認も同じ一覧を使う。app-server の `model/list` によるアカウントごとの一覧取得と、そのための専用 Runner コンテナ起動は行わない。

一覧は Runner が導入する Codex CLI の版に同梱されたカタログのうち、一覧表示対象のモデルと各モデルの effort を、同梱カタログの優先順で写す。Codex CLI の版を上げるときに一覧も更新する。

## 理由

本番・ローカルの両方で `model/list` による一覧取得が失敗し、候補が「既定」しか選べない状態になった。取得には所有者の接続と専用コンテナの起動が必要で、失敗点が多く費用もかかる。Runner が使う Codex CLI の版は固定されており、その版が扱えるモデルと effort は同梱カタログで確定するため、ソースに定義しても実用上の候補は変わらない。取得に依存しない定義にすることで、接続や上流の状態に関係なく候補を表示でき、表示・保存時検証・実行時確認の基準も一つにそろう。Claude についても同様にソース内定義とする予定がある。

## 範囲と例外

一覧の存在はアカウントでの利用可否や推論成功を保証しない。プラン・提供状況の変更による実行時エラーは、Run の失敗として扱い、別モデルへの暗黙の切替はしない。

モデルを指定しない場合は Codex の既定モデルが選ばれるため、effort は一覧の全モデルで使える値だけを有効な Routine に許す。一覧にないモデルや、どのモデルでも使えない effort は、接続の有無にかかわらず保存時に拒否する。有効化時の接続確認、および確認できない場合の無効状態での保存は [設定検証の判断](PDR-20261118-routine-configuration-validation.md) に従う。

## 選択肢と影響

`model/list` を優先し失敗時だけ定義に戻す案は、取得失敗の原因と費用を残し、表示と検証の基準が状況で変わるため採用しない。定義の更新を忘れると、新しいモデルが表示されない、または同梱カタログから外れたモデルが残る不利益がある。
