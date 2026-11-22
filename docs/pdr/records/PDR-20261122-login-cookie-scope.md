---
schema: 1
id: PDR-20261122-login-cookie-scope
key: auth.login.cookie-scope
status: accepted
date: "2026-11-22"
decided_by: suzuki3jp
areas: [auth, web, api]
keywords: [Cookie, SSR, Domain, host-only, サブドメイン, ログイン, 再ログイン, Preview]
paths:
  - apps/api/src/infrastructure/auth/**
  - apps/api/src/presentation/http/handlers/login/**
  - apps/web/src/shared/api/**
  - apps/web/src/worker/**
  - packages/core/src/auth.ts
supersedes: [PDR-20261117-login-cookie-scope]
---

# 本番のログイン Cookie を Web ホストに限定する

## 決定

本番では `tailos.app` でログインを完了し、`Domain` のない `__Host-tailos.session_token` を発行する。HttpOnly、Secure、SameSite=Lax、署名、所有者認証、Origin 検査を維持する。移行時には旧共有 Cookie の署名を無効にし、再ログインする。

## 理由

ブラウザー向け API を同一オリジンで提供すると、Web と API が同じ Cookie を受け取れる。Cookie を Web ホストに限定することで、今後 `tailos.app` 配下に設置する PR Preview へ本番のログイン情報が送られる範囲を縮小できる。旧共有 Cookie はブラウザーに残り得るため、新しい名前に加えて署名も切り替える。

## 範囲と例外

本番ブラウザーのログインセッションと OAuth 用 Cookie に適用する。SSR はログインセッション Cookie だけを固定の API 接続先に転送し、キャッシュやリダイレクトを使わない。ローカル開発では `localhost` のホスト限定 Cookie をポート間で共有する。PR Preview のログイン設定と公開条件は別途扱う。
