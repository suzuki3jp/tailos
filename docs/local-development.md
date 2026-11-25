# ローカル開発

以下は Web を `http://localhost:3000`、API を `http://localhost:8787` で動かす手順。リポジトリのルートで実行する。

## 開発ツールと依存関係

[mise のインストール手順](https://mise.jdx.dev/installing-mise.html)に従って mise を用意する。リポジトリのルートで次を実行すると、`mise.toml` に指定された Node.js と pnpm が揃う。

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
```

## 認証設定

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env.local
```

API は Wrangler が `apps/api/.dev.vars` を読み込み、Web は Vite が `apps/web/.env.local` を読み込む。実際の値を入れるファイルは Git の追跡対象外。

GitHub の [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) でローカル用 OAuth App を登録する。

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:8787/v1/auth/callback/github`

発行された値と次のコマンドの出力を `apps/api/.dev.vars` の空欄に設定する。

| 変数 | 設定する値 |
| --- | --- |
| `TAILOS_GITHUB_OAUTH_CLIENT_ID` | ローカル用 OAuth App の Client ID |
| `TAILOS_GITHUB_OAUTH_CLIENT_SECRET` | 同じ OAuth App の Client Secret |
| `TAILOS_OPERATOR_GITHUB_ID` | `gh api user --jq .id` で取得する自分の数値 ID |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` で生成するローカル用の鍵 |

ログインを許可するのは `TAILOS_OPERATOR_GITHUB_ID` に指定した GitHub アカウント。OAuth App は、リポジトリ操作用の GitHub App とは別の設定になる。

## 起動

API を起動する。起動スクリプトがローカル D1 のマイグレーションも適用する。

```sh
mise exec -- pnpm --filter @tailos/api run dev --port 8787
```

別のターミナルで Web を起動する。

```sh
mise exec -- pnpm --filter @tailos/web run dev
```

`http://localhost:3000/login` を開き、GitHub でログインする。本番のユーザー・Session・Project はローカル D1 には含まれないため、新規 DB の一覧 API は空の結果を返す。

API のポートを変える場合は、起動時の `--port`、API の `TAILOS_PUBLIC_ORIGIN`、Web の `VITE_API_ORIGIN`、OAuth App のコールバック URL を揃える。Web のポートを変える場合も `TAILOS_WEB_ORIGIN` を揃える。設定変更後は API と Web を再起動する。

## 404 が返る場合

`/health` が `{"status":"ok","service":"tailos-api"}` を返すことを確認する。`/v1/projects` と `/v1/sessions` は、API の URL が `TAILOS_PUBLIC_ORIGIN` と異なる場合や `BETTER_AUTH_SECRET` が未設定の場合、404 を返す。ホスト設定と認証設定が揃い、ログインしていなければ 401 を返す。

ログインとホーム一覧の取得には、リポジトリ操作用の GitHub App や Codex の接続は不要。Project の追加には GitHub App の設定、Run の実行には追加の接続が必要になるため、[デプロイ手順](deploy.md)の該当項目を参照する。

環境変数ファイルの読み込みは [Wrangler のローカル設定](https://developers.cloudflare.com/workers/local-development/environment-variables/)、OAuth App の登録は [GitHub の手順](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)を参照。
