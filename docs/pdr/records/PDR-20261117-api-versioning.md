---
schema: 1
id: PDR-20261117-api-versioning
key: api.url-versioning
status: superseded
date: "2026-11-17"
decided_by: suzuki3jp
areas: [api, web, auth]
keywords: [/api, /v1, prefix, versioning, バージョン]
paths:
  - apps/api/src/bootstrap/http.ts
  - apps/api/src/infrastructure/auth/login.ts
  - apps/web/src/shared/api/**
  - apps/web/src/_pages/account/**
  - docs/deploy.md
supersedes: []
---

# ブラウザー向け API のプレフィックスをバージョン付きにする

## 決定

ブラウザー向け API とログイン経路の `/api` プレフィックスを `/v1` に置き換える。初期バージョンを v1 とし、Web クライアント、ログイン・ログアウトのフォーム、GitHub OAuth のコールバックを同時に更新する。旧 `/api` 経路は残さない。

## 理由

バージョンを URL で明示すると、将来の契約変更を別のバージョンとして区別できる。API 専用ホストでは汎用の `/api` プレフィックスよりバージョンを直接表す経路を使う。認証の設定と呼び出し元を揃えることで、API の移行後もログインを完了できる。

## 範囲と例外

既存の `/api` 配下だけを対象とする。会話一覧・そのページング契約・Project 一覧の既存 PDR に記載された `/api/sessions`、`/api/projects`、`/api/projects/settings` などの URL は、この横断的な判断により `/v1` 配下へ移る。それらの認可、取得対象、レスポンス、ページングは変更しない。

`/mcp`、`/webhooks/github`、`/health`、`/_runner`、`/_internal` は今回の移行対象に含めない。外部サービスの API URL も変更しない。運用時には GitHub OAuth App のコールバック設定を `/v1/auth/callback/github` へ変更する必要がある。
