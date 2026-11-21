# PR の動作確認環境

同一リポジトリから `main` への PR は、`pull_request` の CI で PR の head をビルドする。**リポジトリ所有者が `preview` ラベルを付けると**、その時点の head の CI 成功を待ち、成果物から Web と API の Workers Preview を公開する。Tailos が生成した PR も同じ手順で公開できる。公開ジョブは `main` のデプロイ手順を使い、PR のビルドスクリプトを実行しない。両方の疎通と GitHub ログインの開始を確認したあと、PR コメントに Web URL と公開した SHA を表示する。Web URL は固定され、その Web は同じ SHA の API デプロイを参照する。

## 初回設定

1. Cloudflare に Preview 用の D1 `tailos-preview` と非公開 R2 `tailos-preview-run-artifacts` を作成する。設定済みの D1 の UUID を控える。共有リソースにはテストデータを使う。
2. Cloudflare に親 Worker `tailos-preview-web` と `tailos-preview-api` を用意する。各 Worker の Domains で、本番の `tailos.app` と異なる登録ドメイン上の Custom Domain を **Preview only** として割り当てる。たとえば Web が `preview.example.net`、API が `preview-api.example.net` なら、PR #123 の Web URL は `https://pr-123.preview.example.net` になる。API には PR の固定 URL に加えて、デプロイごとの URL が必要。初回の DNS と TLS 証明書の反映には時間がかかる。 [Cloudflare の設定手順](https://developers.cloudflare.com/workers/previews/custom-domains/)
3. GitHub に Preview 専用 OAuth App を登録する。Authorization callback URL は `https://preview.example.net/v1/auth/callback/github` のように Web 側の Preview 用ベースホストで登録し、**wildcard matching** を有効にする。各 PR は自身の Web URL の同じパスに戻る。登録ドメインと照合対象のサブドメインは管理下に置く。 [GitHub の照合仕様](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls)
4. GitHub Actions の Environment `preview` を作り、デプロイ元を `main` に制限する。次の変数と Secret を登録する。Cloudflare トークンは Preview 用アカウントの Workers Scripts の編集、D1 と R2 の読み取りに限定する。PR のコードは Preview 用データと実行時の資格情報を扱うので、同一リポジトリのブランチ作成権限は信頼できる主体に限定する。
5. 共有 D1 に `main` の migration を適用し、リポジトリに `preview` ラベルを作る。最後にリポジトリ変数 `TAILOS_PREVIEW_ENABLED=true` を登録する。設定前に開いた PR は、Preview のビルドを含む `main` を取り込んで CI を実行してから、リポジトリ所有者がラベルを付ける。

| 種別 | 設定名 | 内容 |
| --- | --- | --- |
| リポジトリ変数 | `TAILOS_PREVIEW_WEB_DOMAIN` | Web の Preview 用ベースホスト名 |
| リポジトリ変数 | `TAILOS_PREVIEW_API_DOMAIN` | API の Preview 用ベースホスト名 |
| リポジトリ変数 | `TAILOS_PREVIEW_ENABLED` | 設定完了後に `true` |
| Environment 変数 | `TAILOS_PREVIEW_CLOUDFLARE_ACCOUNT_ID` | Preview 用 Cloudflare アカウント ID |
| Environment 変数 | `TAILOS_PREVIEW_D1_DATABASE_ID` | `tailos-preview` の UUID |
| Environment 変数 | `TAILOS_PREVIEW_GITHUB_OAUTH_CLIENT_ID` | Preview 用 OAuth App の Client ID |
| Environment 変数 | `TAILOS_PREVIEW_OPERATOR_GITHUB_ID` | ログインを許可する GitHub ユーザーの数値 ID |
| Environment Secret | `TAILOS_PREVIEW_CLOUDFLARE_API_TOKEN` | Preview 用 Cloudflare API トークン |
| Environment Secret | `TAILOS_PREVIEW_GITHUB_OAUTH_CLIENT_SECRET` | Preview 用 OAuth App の Client Secret |
| Environment Secret | `TAILOS_PREVIEW_AUTH_SECRET` | 32 文字以上の乱数。例として `openssl rand -base64 32` |

## 共有 D1 のスキーマ

Preview 専用アカウントを指定した状態で、`main` の checkout に D1 用の一時設定を用意する。次のファイルは `apps/api` に作り、利用後に削除する。

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "tailos-preview",
      "database_id": "PREVIEW-DATABASE-UUID",
      "migrations_dir": "migrations"
    }
  ]
}
```

```sh
pnpm --dir apps/api exec wrangler d1 migrations apply DB --remote --config wrangler.preview-db.local.jsonc
```

共有 DB のスキーマが必要な PR では、デプロイ先と互換性のある migration を運用者が別途計画する。既存 Preview が使う DB に PR の SQL が自動適用されることはない。Preview を消しても D1 の行と R2 のオブジェクトは残る。

## 確認と削除

- 新しいコミットを公開するには、その差分を確認して `preview` ラベルを付け直す。公開待ちの間に push またはラベルの取り外しがあれば、その公開は進まない。CI が失敗した場合や成果物の期限が切れた場合は、CI を再実行して成功後にラベルを付け直す。ラベルを外す操作は公開済みの Preview を削除しない。
- PR コメントのリンクで GitHub ログインを完了し、ログイン後の画面をリロードして認証状態を確認する。別 PR の URL でも個別にログインできることを確認する。
- close・merge 後は `pr-<番号>` の Web と API を削除する。削除ジョブが失敗した場合は、次の日次実行か **Actions → Preview → Run workflow** で再照合できる。照合は Cloudflare に残る Preview を列挙し、GitHub 上で閉じた PR に対応する分だけを削除する。
- Runner、GitHub App Webhook、Cron はこの環境の確認対象外。稼働中の別 PR や共有 D1・R2 に影響がないことは、2 本のテスト PR で確認する。
