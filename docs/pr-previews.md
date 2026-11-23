# PR の動作確認環境

同一リポジトリから `main` への PR は、`pull_request` の CI で PR の head をビルドする。**リポジトリ所有者が `preview` ラベルを付けると**、その時点の head の CI 成功を待ち、成果物から Web と API の Workers Preview を公開する。Tailos が生成した PR も同じ手順で公開できる。公開ジョブは `main` のデプロイ手順で成果物をアップロードする。両方の疎通と GitHub ログインの開始を確認したあと、PR コメントに Web URL と公開した SHA を表示する。

PR #123 の Web URL は `https://pr-123.preview.tailos.app`。ブラウザーと SSR は `/api/v1` を使い、Web は対応する API のデプロイ固有 URL へ転送する。本番の Service Binding は本番の API を指すため、Preview には設定しない。Cookie は Web ホスト限定の `__Host-tailos-preview.session_token` で、署名鍵も PR ごとに異なる。 [Cloudflare の Preview 設定](https://developers.cloudflare.com/workers/previews/configuration/)

## 初回設定

1. [本番のログイン切り替え](deploy.md#運用者の-github-ログイン)を済ませる。`tailos.app` で新しいホスト限定 Cookie によりログインでき、旧共有 Cookie の署名が拒否されることを確認する。
2. Cloudflare に Preview 用の D1 `tailos-preview` と非公開 R2 `tailos-preview-run-artifacts` を用意する。共有リソースにはテストデータを使う。親 Worker `tailos-preview-web` に `preview.tailos.app`、`tailos-preview-api` に `preview-api.tailos.app` を **Preview only** として割り当てる。旧 Preview ドメインの割り当てが残っていれば外す。初回公開時に、固定 URL と API のデプロイ固有 URL の両方で DNS と TLS を確認する。 [Cloudflare の設定手順](https://developers.cloudflare.com/workers/previews/custom-domains/)
3. GitHub に Preview 専用 OAuth App を登録する。コールバック `https://preview.tailos.app/api/v1/auth/callback/github` で **wildcard matching** を使う場合は、GitHub の照合対象となるホストとパスが管理下にあることを確認する。各 PR は自身の Web URL の同じパスに戻る。 [GitHub の照合仕様](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls)
4. GitHub Actions の Environment `preview` を作り、デプロイ元を `main` に制限する。次の変数と Secret を登録する。Cloudflare トークンには Workers Scripts の編集、D1 と R2 の読み取りを付ける。公開された PR コードは Preview 用データと実行時の資格情報を扱う。
5. 共有 D1 に `main` の migration を適用し、リポジトリに `preview` ラベルを作る。最後にリポジトリ変数 `TAILOS_PREVIEW_ENABLED=true` を登録する。設定前に開いた PR は、Preview のビルドを含む `main` を取り込んで CI を実行してから、リポジトリ所有者がラベルを付ける。

| 種別 | 設定名 | 内容 |
| --- | --- | --- |
| リポジトリ変数 | `TAILOS_PREVIEW_ENABLED` | 設定完了後に `true` |
| Environment 変数 | `TAILOS_PREVIEW_CLOUDFLARE_ACCOUNT_ID` | Preview 用 Cloudflare アカウント ID |
| Environment 変数 | `TAILOS_PREVIEW_D1_DATABASE_ID` | `tailos-preview` の UUID |
| Environment 変数 | `TAILOS_PREVIEW_GITHUB_OAUTH_CLIENT_ID` | Preview 用 OAuth App の Client ID |
| Environment 変数 | `TAILOS_PREVIEW_OPERATOR_GITHUB_ID` | ログインを許可する GitHub ユーザーの数値 ID |
| Environment Secret | `TAILOS_PREVIEW_CLOUDFLARE_API_TOKEN` | Preview 用 Cloudflare API トークン |
| Environment Secret | `TAILOS_PREVIEW_GITHUB_OAUTH_CLIENT_SECRET` | Preview 用 OAuth App の Client Secret |
| Environment Secret | `TAILOS_PREVIEW_AUTH_SECRET` | 32 文字以上の乱数。例として `openssl rand -base64 32` |

## 共有 D1 のスキーマ

Preview 用リソースがある Cloudflare アカウントを指定し、`main` の checkout に D1 用の一時設定を用意する。次のファイルは `apps/api` に作り、利用後に削除する。

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
