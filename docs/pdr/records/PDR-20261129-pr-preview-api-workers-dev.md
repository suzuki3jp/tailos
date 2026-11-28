---
schema: 1
id: PDR-20261129-pr-preview-api-workers-dev
key: deployment.pr-previews
status: accepted
date: "2026-11-29"
decided_by: suzuki3jp
areas: [deployment, web, api, auth]
keywords: [PR, Preview, Workers Previews, workers.dev, "1053", tailos.app, /api/v1, Cookie, OAuth, 承認, 削除]
paths:
  - .github/workflows/preview-setup.yml
  - .github/workflows/preview.yml
  - .github/workflows/ci.yml
  - apps/api/src/bootstrap/preview.ts
  - apps/web/src/worker/**
  - docs/pr-previews.md
  - tools/preview/**
supersedes: [PDR-20261122-pr-preview-tailos-app]
---

# PR Preview の Web から API への転送に workers.dev を使う

## 決定

同一リポジトリから `main` への PR を対象に、リポジトリ所有者が `preview` ラベルを付けた時点の head を、CI 成功後に Cloudflare Workers Previews に公開する。Web URL は `https://pr-<番号>.preview.tailos.app` に固定する。Web は同じ head の API デプロイ固有 URL を、Preview 用 Cloudflare アカウントの `workers.dev` 配下で参照する。API の通常の `workers.dev` URL は無効にし、Web からは PR ごとのプロキシ用 Secret を付けて転送する。D1 と R2 は Preview 専用リソースを共用する。

ブラウザー向け API と GitHub OAuth コールバックは PR の Web ホストの `/api/v1` 配下で提供する。Preview 専用 OAuth App を使用し、Cookie は PR の Web ホストに限定する。Cookie 名は本番と分け、署名鍵は PR ごとに分ける。本番の Cookie 切り替えと旧共有セッションの無効化が済んでから有効にする。

## 理由

Cloudflare は Worker から Preview カスタムドメインへのサブリクエストを 1053 で拒否する。API の `workers.dev` Preview URL を使うと、ブラウザーから見える Web URL と OAuth コールバック、Cookie の適用先を維持したまま転送できる。PR #191 では Web からの未ログイン API リクエストが 401 を返し、GitHub ログイン開始時のコールバックも Web ホストを指すことを確認した。 [Cloudflare Issue #119](https://github.com/cloudflare/developer-platform/issues/119)

本番と同じ API パスと認証処理を使うことで、Preview でも SSR や OAuth の動作を同じ構成で確認できる。ホスト限定 Cookie と別の署名鍵により、`tailos.app` 配下に Preview を置きながらログインを分離できる。Web を API のデプロイ固有 URL に固定すると、新しい API の公開後に Web の公開が失敗しても、直前の Web は対応する API を呼べる。

ラベルで対象コミットを確定することで、Tailos が作成した PR も含め、所有者が確認した head だけに Preview 用の資格情報と共有データへのアクセスを付与できる。

## 範囲と例外

ビルドは権限を限定した `pull_request` CI で実行する。公開ジョブは `main` のデプロイ手順で指定した CI の成果物をアップロードする。公開前に PR が open で、ラベルと承認時の head が揃っていることを確認する。ラベルを外すと待機中の公開が止まり、すでに公開した環境は PR 終了まで利用できる。新しい head を公開するにはラベルを付け直す。

現在の Cloudflare アカウントには本番と Preview のリソースがある。アカウント全体に設定されたトークン権限は本番にも及ぶため、公開・削除トークンは `main` の手順で動く GitHub Actions のジョブ内だけで使う。Worker の実行環境には Preview 専用のデータと実行時の資格情報を設定する。

close・merge 後は Web と API の Preview を削除し、日次照合で削除漏れを回収する。GitHub で閉じた状態を確認できない場合は削除せず、失敗を記録する。共有 D1・R2 は保持し、PR 固有の migration は共有 DB に自動適用しない。

Web の Preview 用カスタムドメインと API の `workers.dev` Preview URL の設定、共有 D1 への `main` の migration 適用は、`main` から手動起動するセットアップジョブで行う。公開済みの Preview も同じ D1 を使うため、運用者がスキーマ互換性を確認してから実行する。Preview ルーティングと D1 を変更できるセットアップ用トークンは、そのジョブでのみ使用する。

対象は Web、ブラウザー向け API、設定済み運用者の GitHub ログイン。Runner、Cron、GitHub App Webhook は対象外。本番の認証は [本番 Cookie の方針](PDR-20261122-login-cookie-scope.md) に従う。

## 再検討条件

Cloudflare 側の修正後、Web Preview から API の Preview カスタムドメイン上のデプロイ固有 URL への転送と、GitHub ログインの開始を確認する。その結果を踏まえて `workers.dev` の回避策を外す。 [Cloudflare Issue #119](https://github.com/cloudflare/developer-platform/issues/119)
