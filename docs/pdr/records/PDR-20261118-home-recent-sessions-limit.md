---
schema: 1
id: PDR-20261118-home-recent-sessions-limit
key: web.home.recent-sessions-limit
status: accepted
date: "2026-11-18"
decided_by: suzuki3jp
areas: [web, sessions]
keywords: [Recent Sessions, ホーム, 表示件数, TanStack Query, キャッシュ]
paths:
  - apps/web/src/_pages/home/ui/session-list.tsx
---

# ホームの Recent Sessions を最大5件表示する

## 決定

アカウントホームの Recent Sessions は、アカウント全体の更新順で重複を除いた先頭5件までを表示する。表示が5件未満で後続ページがあるときは利用者が追加取得できる。

## 理由

表示上限を UI に適用すると、TanStack Query に既定のページサイズで取得した結果を保持でき、同じ取得条件を使う表示でキャッシュを再利用できる。

## 範囲と例外

上限は Recent Sessions の表示に適用する。一覧 API の取得条件とクエリキーは維持する。[ホームの初期取得](PDR-20261118-home-prefetch-deadline.md)で定めた後続ページの手動取得は、表示件数が上限に達するまで利用できる。
