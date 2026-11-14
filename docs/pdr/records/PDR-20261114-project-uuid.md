---
schema: 1
id: PDR-20261114-project-uuid
key: project.identity.uuid
status: accepted
date: "2026-11-14"
areas: [projects, sessions, deployment]
keywords: [UUID, meguri, slug, Project ID, project_id, 移行, 対応表]
paths: ["apps/api/src/application/triggers/**", "apps/api/src/infrastructure/d1/**", "config/**", "docs/deploy.md", "docs/design.md"]
symbols: [projectsSchema, projectId, sessions]
supersedes: []
decided_by: suzuki3jp
---

# D1 移行時に Project ID を UUID に変える

## 決定

Project の永続 ID は UUID にする。新規 Project の ID はサーバーで発行し、運用者による手入力・変更は提供しない。D1 への移行時に `meguri` などの既存文字列 ID を新しい UUID に変換する。

## 理由

将来、複数の Project がそれぞれリポジトリと Session を持つ構成を検討している。Project の識別子を人が付ける名前やリポジトリ名から独立させると、名前や関連付けが変わっても同じ Project を参照できる。D1 移行時に揃えることで、新旧の ID 形式が通常の管理操作に混在することを避ける。

## 範囲と例外

旧設定の ID ごとに UUID を一つ割り当て、旧 ID と新 UUID の対応を移行情報として保存する。既存 Session の `project_id` もその対応に従って付け替え、過去の Session を同じ Project からたどれるようにする。設定・対応情報・参照の更新・移行履歴は一括で確定する。

既存の Session ID・Run ID・所有者・会話・Run の実行設定と期限は変更しない。Project を持たない Session はそのままにする。移行対象の設定にない文字列 ID を推測で別の Project に割り当てない。

旧 ID は移行情報に限って保持し、新しい Project の永続 ID や新規作成 API の入力値としては受け付けない。旧 ID のスキーマ制約は移行入力の検証に限って残し、移行後の Project ID は UUID として検証する。

表示名の追加、将来の Project とリポジトリの詳細な関連モデル、既存 URL や外部参照に対する互換 API はこの判断だけでは追加しない。複数 Project の構想全体を今回実装するという意味ではない。

## 選択肢と影響

文字列 ID の維持は参照の移行を省けるが、名前と識別子の結び付きを残す。UUID は直接読んで対象を判別しづらく、対応情報と Session の参照更新が必要になる。
