---
schema: 1
id: PDR-20261122-api-versioning
key: api.url-versioning
status: accepted
date: "2026-11-22"
decided_by: suzuki3jp
areas: [api, web, auth]
keywords: [/api/v1, /v1, versioning, バージョン, プロキシ, OAuth, WebSocket]
paths:
  - apps/api/src/bootstrap/http.ts
  - apps/api/src/infrastructure/auth/login.ts
  - apps/web/src/shared/api/**
  - apps/web/src/_pages/account/**
  - apps/web/src/_pages/session-detail/api/**
  - apps/web/src/worker/**
  - docs/deploy.md
supersedes: [PDR-20261117-api-versioning]
---

# 本番のブラウザー向け API を Web の `/api/v1` で提供する

## 決定

本番のブラウザー向け API を Web と同一の `https://tailos.app/api/v1` で提供する。OAuth コールバックと WebSocket もこのプレフィックスを使う。本番の旧 URL `https://api.tailos.app/v1` は閉じる。

## 理由

Web と同一オリジンで API を呼べると、ログイン Cookie を Web ホストに限定したままブラウザー操作と SSR に使える。`/api` 配下に集約して Web の画面ルートと分け、`v1` で API のバージョンを引き続き表す。

## 範囲と例外

対象は既存の `/v1` にあったブラウザー向け経路。認可、取得対象、レスポンス、ページングの契約は維持する。ローカル開発は API の `/v1` に直接接続する。API ホスト上の `/mcp`、`/webhooks/github`、`/health`、`/_runner`、`/_internal` は既存の URL を使う。
