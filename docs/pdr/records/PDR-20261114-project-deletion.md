---
schema: 1
id: PDR-20261114-project-deletion
key: project.configuration.deletion
status: accepted
date: "2026-11-14"
areas: [projects, sessions, runs]
keywords: [削除, 論理削除, 計画, 実行中, project_id]
paths: ["apps/api/src/application/triggers/**", "apps/api/src/application/sessions/**", "apps/api/src/infrastructure/d1/**"]
symbols: [ExecutionContext, projectId]
supersedes: []
decided_by: suzuki3jp
---

# Project 削除後は新規起動を止め履歴と既存 Run を保持する

## 決定

Project は論理削除し、削除後に受理する Project 起点の新規 Run を停止する。既に作成した queued・running の Run は保存済み設定で続行する。計画の会話と過去の Session・Run・変更履歴は残し、従来の所有者が閲覧できる。

## 理由

設定削除を会話や成果物の消去に結び付けると、過去の実行を追えなくなる。作成済み Run は設定を固定するという制約があるため、削除時も既存 Run を変更しない。論理削除なら参照の意味を維持できる。

## 範囲と例外

削除済み Project に属する計画から新規 Run を作る操作は拒否する。削除前に起動が受理された Run を停止したい場合は、設定削除とは別の操作が必要になる。

削除済み ID の再利用と復元は初版では提供しない。同じリポジトリを新しい ID で登録することは許可する。最大 100 件と `repositoryId` の一意性は削除されていない設定に適用する。

## 選択肢と影響

削除時に実行を取り消す案は即座に停止できるが、作成時設定を維持する制約とは別の停止仕様が必要になる。既存 Run を続行する案では、削除だけでは既に受理した通信や公開処理を止められないため、削除画面でその影響を説明する。
