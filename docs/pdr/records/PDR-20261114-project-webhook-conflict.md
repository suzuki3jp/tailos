---
schema: 1
id: PDR-20261114-project-webhook-conflict
key: project.configuration.webhook-conflict
status: accepted
date: "2026-11-14"
areas: [projects, triggers]
keywords: [ProjectChanged, Webhook, 再試行, 再送, "503", 設定編集]
paths: ["apps/api/src/presentation/http/handlers/github-webhook/**", "docs/deploy.md"]
symbols: [ProjectChanged, createGithubWebhook]
supersedes: []
decided_by: suzuki3jp
---

# Project 編集と重なった Webhook は最新条件で一度だけ再試行する

## 決定

Project の版が受付直前に変わった場合は、設定を読み直し、リポジトリ・installation・ラベル・許可ユーザーの確認から一度だけやり直す。再び競合した場合は 503 と診断を返し、運用者の手動再送で回復する。

## 理由

古い権限での起動は防ぐ必要がある一方、時間上限の編集などとの偶発的な競合で配送を失うことは避けたい。GitHub は失敗した Webhook を自動再送しないため、API 内で一度だけ最新の条件を確認すれば運用者の再送操作を減らせる。

## 範囲と例外

実装ラベルと計画コメントの両方に適用する。D1 障害、署名不一致、owner・scope の不一致にはこの再試行を適用しない。再読込後に起動条件を満たさなければ通常の対象外として扱い、作成済み Run は変更しない。

## 選択肢と影響

現行実装の 503 と手動再送を維持する方式は単純だが、編集と重なった配送への注意と再送操作が必要になる。一度の再試行では読み取りが増え、連続した編集では依然として手動再送が必要になる。
