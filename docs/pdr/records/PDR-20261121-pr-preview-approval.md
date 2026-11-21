---
schema: 1
id: PDR-20261121-pr-preview-approval
key: deployment.pr-previews
status: accepted
date: "2026-11-21"
decided_by: suzuki3jp
areas: [deployment, web, api, auth]
keywords: [PR, Preview, Workers Previews, Agent, ラベル, 承認, GitHub Actions]
paths:
  - .github/workflows/preview.yml
  - .github/workflows/ci.yml
  - docs/pr-previews.md
  - tools/preview/**
supersedes: [PDR-20261121-pr-previews]
---

# 運用者が Preview ラベルを付けた PR を公開する

## 決定

同一リポジトリから main への PR は、リポジトリ所有者が GitHub で `preview` ラベルを付けたとき、その時点の head だけを公開対象とする。Tailos が生成した PR も同じ手順で承認できる。該当する CI が実行中なら成功を待つ。CI が失敗した場合は、成功後にラベルを付け直す。

Web と API は同じ head の成果物を Cloudflare Workers Previews に公開する。Web URL は PR 番号で固定し、その Web は同じ head で公開した API のデプロイ URL を参照する。D1 と R2 は Preview 専用リソースを全 PR で共用する。

GitHub ログインは Preview 専用 OAuth App を使う。ブラウザの `/v1` と OAuth callback は PR の Web URL に置き、Web が対応する API に転送する。Cookie は PR のホストに限定し、セッション署名鍵も PR ごとに分ける。

## 理由

同一リポジトリには人間が編集した PR に加え、Tailos が Issue から生成した PR もある。公開する API は Preview 用 OAuth App の資格情報と共有 D1・R2 を扱い、ログイン時には GitHub のトークンも処理する。ラベルで公開する head を確定すると、運用者は同じ手順で通常の PR と Agent の PR を確認できる。ラベルが付いたまま push されても、確認していないコミットには承認を持ち越さない。

固定 URL はレビュー中に再利用できる。Web を同じ head の API デプロイへ固定すると、次の API 公開後に Web の公開が失敗しても直前の Web と対応する API を使える。Web と同じホストで OAuth を完了すれば、Cookie の範囲を広げずにブラウザと SSR で認証を共有できる。

## 範囲と例外

ビルドは権限を限定した `pull_request` の CI で実行し、公開ジョブは信頼済みのデプロイ手順で成果物をアップロードする。公開直前に PR が open でラベルがあり、head が承認時と同じことを確認する。ラベルを外すと待機中の公開は進まず、公開済みの Preview は PR の close または merge まで利用できる。新しい head の公開にはラベルを付け直す。

close・merge 後は両方の Worker Preview を削除し、日次照合で削除漏れを回収する。GitHub で閉じた状態を確認できない Preview は削除せず、失敗を記録する。共有 D1・R2 は保持し、PR 固有の migration を共有 DB に自動適用しない。

提供範囲は Web、ブラウザ API、設定済み運用者の GitHub ログイン。Runner、Cron、GitHub App Webhook は対象外。Preview のドメインと資格情報は本番から分離する。本番 Cookie は [PDR-20261117-login-cookie-scope](PDR-20261117-login-cookie-scope.md) に従う。
