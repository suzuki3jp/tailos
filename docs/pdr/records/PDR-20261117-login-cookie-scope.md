---
schema: 1
id: PDR-20261117-login-cookie-scope
key: auth.login.cookie-scope
status: superseded
date: "2026-11-17"
decided_by: suzuki3jp
areas: [auth, web, api]
keywords: [Cookie, SSR, Domain, サブドメイン, ログイン, 再ログイン]
paths:
  - apps/api/src/infrastructure/auth/**
  - apps/api/src/presentation/http/handlers/login/**
  - apps/web/src/shared/api/**
  - packages/core/src/auth.ts
supersedes: []
---

# SSR のためログイン Cookie を Web と API で共有する

## 決定

本番のログインセッション Cookie を `tailos.app` と配下の API ホストで共有し、Web へのリクエストから SSR の API 呼び出しに引き継ぐ。従来の API 専用 Cookie とは名前を分け、新しい Cookie で再ログインする。HttpOnly・Secure・SameSite と既存の署名・所有者認証・Origin 検査は維持する。

## 理由

従来は `api.tailos.app` の host-only Cookie だったため、`tailos.app` のリクエストにはセッションが付かなかった。ブラウザ側の credentials 設定だけでは SSR の認証を成立させられない。サブドメイン共有は、同一オリジンの代理配信や OAuth 経路の作り直しを避ける最小の変更になる。Cookie 名の切り替えで、旧 host-only Cookie と新しい Domain Cookie の同名衝突も避ける。

## 範囲と例外

共有するのはログインセッション Cookie に限る。Web ホストが API ホストの親である構成では、設定済み Web ホストを Domain とする。ローカル開発のように Web と API が同じホストなら host-only のまま共有できる。無関係な親ドメインを推測して範囲を広げない。

Web サーバーは必要なセッション Cookie だけを、固定した API origin に対する cache 禁止・リダイレクト禁止の fetch に引き継ぐ。Cookie はブラウザへ渡す props や Query の state に保存しない。移行時は再ログインが必要になる。旧セッション Cookie は新しい認証では使用しない。

## 選択肢と影響

同一オリジン化は Cookie の共有範囲を狭くできるが、配信・ログイン経路にも変更が及ぶ。今回はサブドメイン共有を採るため、認証 Cookie は `tailos.app` 配下の他のサブドメインにも送られる。この配下には信頼できないサービスを置かないことが前提になる。
