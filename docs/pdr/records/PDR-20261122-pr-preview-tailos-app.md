---
schema: 1
id: PDR-20261122-pr-preview-tailos-app
key: deployment.pr-previews
status: accepted
date: "2026-11-22"
decided_by: suzuki3jp
areas: [deployment, web, api, auth]
keywords: [PR, Preview, Workers Previews, tailos.app, /api/v1, Cookie, OAuth, 承認, 削除]
paths:
  - .github/workflows/preview.yml
  - .github/workflows/ci.yml
  - apps/api/src/bootstrap/preview.ts
  - apps/web/src/worker/**
  - docs/pr-previews.md
  - tools/preview/**
supersedes: [PDR-20261121-pr-preview-approval]
---

# PR Preview を tailos.app 配下で本番と同じ API パスに揃える

## 決定

同一リポジトリから `main` への PR を対象に、リポジトリ所有者が `preview` ラベルを付けた時点の head を、CI 成功後に Cloudflare Workers Previews に公開する。Web URL は `https://pr-<番号>.preview.tailos.app` に固定する。Web は同じ head の API デプロイ固有 URL を `preview-api.tailos.app` 配下で参照する。D1 と R2 は Preview 専用リソースを共用する。

ブラウザー向け API と GitHub OAuth コールバックは PR の Web ホストの `/api/v1` 配下で提供する。Preview 専用 OAuth App を使用し、Cookie は PR の Web ホストに限定する。Cookie 名は本番と分け、署名鍵は PR ごとに分ける。本番の Cookie 切り替えと旧共有セッションの無効化が済んでから有効にする。

## 理由

本番と同じ API パスと認証処理を使うことで、Preview でも SSR や OAuth の動作を同じ構成で確認できる。ホスト限定 Cookie と別の署名鍵により、`tailos.app` 配下に Preview を置きながらログインを分離できる。Web を API のデプロイ固有 URL に固定すると、新しい API の公開後に Web の公開が失敗しても、直前の Web は対応する API を呼べる。

ラベルで対象コミットを確定することで、Tailos が作成した PR も含め、所有者が確認した head だけに Preview 用の資格情報と共有データへのアクセスを付与できる。

## 範囲と例外

ビルドは権限を限定した `pull_request` CI で実行する。公開ジョブは `main` のデプロイ手順で指定した CI の成果物をアップロードする。公開前に PR が open で、ラベルと承認時の head が揃っていることを確認する。ラベルを外すと待機中の公開が止まり、すでに公開した環境は PR 終了まで利用できる。新しい head を公開するにはラベルを付け直す。

close・merge 後は Web と API の Preview を削除し、日次照合で削除漏れを回収する。GitHub で閉じた状態を確認できない場合は削除せず、失敗を記録する。共有 D1・R2 は保持し、PR 固有の migration は共有 DB に自動適用しない。

対象は Web、ブラウザー向け API、設定済み運用者の GitHub ログイン。Runner、Cron、GitHub App Webhook は対象外。本番の認証は [本番 Cookie の方針](PDR-20261122-login-cookie-scope.md) に従う。
