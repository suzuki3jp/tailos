---
schema: 1
id: PDR-20261116-session-list-contract
key: sessions.account-list-contract
status: accepted
date: "2026-11-16"
decided_by: suzuki3jp
areas: [sessions, api]
keywords: [ページング, cursor, limit, latestRun, セッション一覧]
paths:
  - apps/api/src/application/sessions/**
  - apps/api/src/infrastructure/d1/sessions.ts
  - apps/api/src/presentation/http/handlers/sessions/**
symbols: [createSessionRoutes, d1Sessions]
supersedes: []
---

# 会話一覧 API のページングとレスポンス契約を定める

## 決定

`GET /api/sessions?limit=50&cursor=...` に対して `{ items, nextCursor }` を返す。`limit` は省略時 50、整数の 1〜100 を許可する。不正・重複した `limit` / `cursor` は 400 とし、黙って補正しない。

カーソルは直前のページ末尾の `{ updatedAt, id }` を base64url 化したものとする。更新日時は非負の安全な整数、ID は空でない文字列として検証する。カーソルは位置情報だけで、所有者の認証・絞り込みを代替しない。次ページは `(updated_at, id)` がカーソルより小さい行から取得し、末尾では `nextCursor: null` を返す。

各項目は `id`、`title`、`trigger`、`project: { id } | null`、`createdAt`、`updatedAt`、`latestRun: { id, status, errorCode } | null` を含む。最新 Run は `created_at DESC, id DESC` で選ぶ。メッセージ本文やその抜粋は返さない。削除済み Project でも保存済みの Project ID を返す。

ページをまたぐスナップショットは固定せず、各リクエスト時点のデータを取得する。途中で更新された会話は位置が動くため、複数ページを通じた重複・欠落のない走査は保証しない。カーソルなしのリクエストは、その時点の先頭ページを返す。

## 理由

一度の取得量を制限しつつ、更新日時が同じ会話も ID で区別する。既定 50 件・最大 100 件として、API の一回の読み取り件数とレスポンス量を制御する。壊れた入力をエラーにすれば、意図しない先頭ページの再取得を発見できる。

Run の失敗は返信がない場合があるため、最新 Run の状態とエラーコードを返し、API レスポンスから失敗を判別できるようにする。メッセージ本文の読み取りや返却は増やさない。

スナップショットの保持には追加の状態・有効期限が必要になる。今回の API は最近活動した会話の取得を目的とし、履歴の厳密な走査は保証しないため、リクエストごとに最新状態を取得する方式を採る。

## 範囲と例外

`GET /api/sessions` のリクエスト、レスポンス、取得の整合性だけに適用する。既存 MCP の一覧の順序・カーソル形式は変更しない。所有者の指定、Project による絞り込み、検索、メッセージ本文やその抜粋の返却は追加しない。

[アカウントのセッション一覧の判断](PDR-20261116-session-list.md) の未決事項のうち、具体的なページング契約、取得中の更新の扱い、最新 Run の返却と本文を含めないことを確定する。

## 選択肢と影響

オフセット方式は更新によるずれが大きい。スナップショット方式は厳密だが保持する状態が増える。採用案でも取得中の更新による取りこぼしはあり、全ページを通じて同じ時点のデータを列挙する用途には使えない。
