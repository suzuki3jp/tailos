---
schema: 1
id: PDR-20261121-pr-previews
key: deployment.pr-previews
status: superseded
date: "2026-11-21"
decided_by: suzuki3jp
areas: [deployment, web, api, auth]
keywords: [PR, Preview, Workers Previews, OAuth, D1, R2, 削除, 定期照合]
paths:
  - .github/workflows/preview.yml
  - tools/preview/**
  - apps/api/src/bootstrap/preview.ts
  - apps/web/src/worker/**
supersedes: []
---

# PR ごとに Web と API の Workers Preview を公開する

## 決定

同一リポジトリから main への PR は、CI 成功後に Web と API を同じ PR の head から Cloudflare Workers Previews に公開する。公開済みの Web URL は PR 番号で固定する。Web の各デプロイは対応する API のデプロイ URL を使う。全 PR が Preview 専用の D1 と R2 を共用する。

GitHub ログインには Preview 専用 OAuth App を使用する。ブラウザの `/v1` と OAuth callback は PR の Web URL に置き、Web が同じ PR の API に転送する。セッション Cookie は PR のホストに限定し、署名鍵も PR ごとに分ける。

close または merge で Web と API の Preview を削除する。日次の定期照合は Cloudflare の Preview 一覧を取得し、GitHub で閉じた状態を確認した PR の削除を再試行する。

## 理由

PR の差分をリンクから確認でき、Web と API の契約変更を同時に検証できる。Cloudflare が PR ごとの URL を管理するため、公開ごとに Worker や DNS の登録を増やす必要がない。Web を個別の API デプロイへ固定すれば、次の API の公開後に Web の公開が失敗しても直前の Web と API が組み合わさる。D1 と R2 を共用して各 PR にデータストアを準備する作業を省く。

標準の Web と API の Preview ドメインには親子関係がない。Web と同じホストで OAuth を完了すると、Cookie の範囲を広げずに SSR とブラウザで認証を共有できる。close イベントと定期照合を併用すると、イベント後の削除ジョブが失敗しても回収できる。

## 範囲と例外

初期対象は Web、ブラウザ API、設定済み運用者の GitHub ログイン。Runner、Cron、GitHub App Webhook は対象外。Preview のドメインと資格情報は本番から分離する。Cookie の既存の本番方針は [PDR-20261117-login-cookie-scope](PDR-20261117-login-cookie-scope.md) の範囲に従う。

共有 D1 のスキーマは運用者が管理する。PR 公開時に PR 独自の migration を共有 DB へ適用しない。PR の終了時に共有 D1 と R2 を保持する。GitHub が PR の状態を確認できない場合は、その Preview を削除せず、処理の失敗を記録する。
