---
schema: 1
id: PDR-20261114-project-agent-field-timing
key: project.configuration.agent-field-timing
status: accepted
date: "2026-11-14"
areas: [projects, agent]
keywords: [agent, Codex, Claude, 単位 D, 設定画面]
paths: ["apps/api/src/application/triggers/projects.ts", "apps/api/src/presentation/http/handlers/github-webhook/**", "apps/web/src/_pages/projects/**"]
symbols: [projectsSchema, ExecutionContext]
supersedes: []
decided_by: suzuki3jp
---

# 今回の Project 設定管理には agent 項目を追加しない

## 決定

今回の Project 設定の D1 移行と CRUD には `agent` を追加しない。既存の Codex 起動を維持する。

## 理由

設定管理を先に完成させれば、Agent の選択を導入する際に環境変数の運用へ依存せずに進められる。将来は trigger ごとに Agent を選ぶ構想があるため、今回の変更で設定の追加先や追加時期を固定しない。

## 範囲と例外

Claude 対応時に `Project.agent` を必ず追加するという判断は含めない。Agent 選択の追加先・時期は Claude 対応と trigger の設計を進める際に決める。モデルや effort の指定も対象外とする。

GitHub 上の PDR-20261114-010 は、Project の `agent` で選び、未指定時は codex、Run 作成時に選択を固定し、接続がない場合は別の Agent に切り替えないとしている。この記録はその選択規則を変更せず、今回の実装範囲だけを定める。

[将来構想](PDR-20261114-project-trigger-direction.md) は `proposed` のままとし、trigger ごとの Agent 選択を正式に採択する際に現行方針の後継 PDR を用意する。

## 選択肢と影響

今回から `agent` を保存する方式は、起動できない Agent が選ばれた場合の扱いまで必要になる。追加を後続に分ける方式では、Agent 選択の実装時に保存・画面・起動処理を揃える必要がある。
