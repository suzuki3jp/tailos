---
schema: 1
id: PDR-20261114-project-editable-fields
key: project.configuration.editable-fields
status: superseded
date: "2026-11-14"
areas: [projects, web]
keywords: [設定画面, agentNetworkAccess, allowedActors, triggerLabel, maxRunMinutes]
paths: ["apps/api/src/application/projects/settings.ts", "apps/web/src/_pages/projects/**"]
symbols: [projectsSchema, ExecutionContext]
supersedes: []
decided_by: suzuki3jp
---

# 安定した Project ID を維持し運用設定を画面から変更する

## 決定

新規登録ではサーバーが発行する UUID 以外の既存項目を設定できる。登録後は `id` を固定し、それ以外の既存項目を変更できる。`agentNetworkAccess` も運用者が画面から有効・無効にできる。

## 理由

起動条件や通信許可を変えるたびに再デプロイする必要をなくす。ID は Session の参照として残るため、設定編集による変更から除く。通信許可の判断を行う主体は現在も運用者であり、同じ認証の内側で操作を提供できる。

## 範囲と例外

ID の形式と入力方法は採択済みの [UUID 化](PDR-20261114-project-uuid.md) に従う。リポジトリの入力方法は採択済みの [select 方式](PDR-20261114-project-repository-input.md) に従う。UUID 以外の現行項目の編集を認める。

それ以外は現行の `projectsSchema` の制約を保存時に維持する。稼働する Project の最大数は 100、`id` と `repositoryId` の重複は禁止する。通信許可の既定は false、Run の上限時間の既定は 30 分とし、1〜30 分の範囲を維持する。

通信許可の項目には任意の宛先への通信と非公開ソースの外部送信が可能になることを表示する。変更は以後に作成する Run に適用し、既存の Run の実行設定と期限は書き換えない。

`agent` は今回追加しない。

将来は Project・リポジトリ・Session の構成と trigger ごとの Agent 選択への移行を検討する。[将来構想](PDR-20261114-project-trigger-direction.md) は現行の編集権限や関連モデルを確定するものではない。

## 選択肢と影響

一部項目を環境変数に残すと再デプロイが必要な運用が残る。全設定の変更を許す案では、運用者の操作で起動権限や通信許可が変わるため、変更履歴も必要になる。
