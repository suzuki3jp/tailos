---
schema: 1
id: PDR-20261118-configurable-triggers
key: triggers.configurable-execution
status: accepted
date: "2026-11-18"
areas: [triggers, runs, projects]
keywords: [Routine, トリガー, プロンプト, prompt, model, effort, label, cron, PR, 抽象化]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/infrastructure/d1/**
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - packages/core/src/runner.ts
  - apps/runner/src/**
symbols: [TriggerAdmission, ExecutionContext, RunnerJob]
supersedes: []
decided_by: suzuki3jp
---

# トリガーと実行設定を DB で管理し label 起動から移行する

## 決定

ユーザーがトリガー条件と、紐づくプロンプト・モデル・effort などの実行設定を指定し、DB に保存できる構成へ進める。受信したイベントに対応する設定を解決して共通の Run 実行経路へ渡す抽象化レイヤーを設ける。

最初の移行対象は GitHub Issue の label トリガーとする。既存の plan トリガーの移行は今回含めない。将来の PR イベントや cron 起動は同じ境界に追加できるよう設計するが、その受付・実行を今回実装する判断ではない。

## 理由

イベント種別ごとにプロンプトと起動処理を固定すると、同じイベントを別の目的で使うたびに API の変更が必要になる。起動条件と依頼内容を保存された設定として扱えば、ユーザーは実行目的を変更でき、PR レビューや定期実行にも共通の Run 管理を利用できる。

label 起動を最初に移すことで、新規 Run の受付という比較的小さい経路で抽象化を確かめられる。plan 起動には継続する会話・永続 inbox・受付順序があるため、両方を一度に移すと移行の範囲と回帰リスクが増える。

## 範囲と例外

これは設計方針の採択であり、実装済みを示さない。今回の成果物は計画と PDR である。具体的な保存・受付・Agent 選択の規則は各判断に分ける。接続やモデル情報を確認できない設定も、無効状態なら保存できる。

プロンプトの設定化に伴う既存方針の更新は [Issue コンテキストの後継判断](PDR-20261118-configurable-label-prompt.md) に記録する。[Routine ごとの Agent 選択](PDR-20261118-routine-agent-selection.md)、[label の受付](PDR-20261118-label-routine-dispatch.md)、[Project と Routine の設定分担](PDR-20261118-project-routine-settings.md) はそれぞれ採択済みの判断に従う。

定義の名称は `Routine` とし、初回移行のデプロイ前提は [Routine 初回移行方針](PDR-20261118-routine-initial-migration.md) に従う。Run のない状態を運用で作ることで、デプロイ専用の互換層を追加しない。

plan のコマンド判定、会話保存、読み取り専用モード、通知、手動チャットの起動を変更しない。ユーザーのプロンプトから実行権限・資格情報・公開先を変更できる仕組みを意味しない。

## 選択肢と影響

Webhook handler に設定項目だけを追加する案では、別のイベント源でも同じ設定解決・受付処理を作り直すことになる。共通境界を作る案は設定管理と移行が必要になる一方、イベント源と実行目的を独立させられる。
