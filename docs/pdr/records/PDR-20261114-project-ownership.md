---
schema: 1
id: PDR-20261114-project-ownership
key: project.configuration.ownership
status: superseded
date: "2026-11-14"
areas: [projects, auth]
keywords: [Project, 設定の所有者, 運用者, 共有]
paths: ["apps/api/src/application/triggers/**", "apps/api/src/infrastructure/auth/**"]
symbols: [findOperatorUserId, getOperatorSession]
supersedes: []
decided_by: suzuki3jp
---

# Project の設定をデプロイ全体で共有する

## 決定

Project の設定は D1 にデプロイ全体で一組だけ持つ。閲覧と変更は既存の運用者セッションで認証し、変更リクエストには Web の Origin 検査を適用する。

## 理由

現在の設定はデプロイ全体の環境変数であり、認証も設定された一人の GitHub 運用者に限定される。D1 への移行で設定の帰属まで変えると、運用者の交代時に起動対象が変わるため、既存の共有範囲を維持する。

## 範囲と例外

運用者を変更しても Project 設定は引き継ぐ。Session・Run・接続の所有者は変更しない。MCP や Agent に Project 設定の変更権限を追加しない。

## 選択肢と影響

運用者ごとの所有は複数ユーザーへの拡張に向くが、Webhook がどの所有者の設定を使うかという追加の判断が要る。共有方式では新しい運用者も既存設定を変更できる。
