# Meguri の本番デプロイ

`main` の push に対する CI が成功すると、GitHub Actions が Wrangler 設定の名前で既存の D1 と R2 を探す。両方が見つかったら、取得した D1 の UUID でマイグレーションを適用し、Worker と Runner イメージをデプロイする。最後に `meguri.suzuki3.jp/health` で Worker の応答を確認する。どちらかが見つからなければマイグレーション前に失敗する。

## Cloudflare

- D1 の `meguri` と R2 の `meguri-run-artifacts` がまだない場合は、手動の **Provision Cloudflare resources** で作成する。R2 は非公開で作成される。同名のリソースは再利用される。
- Cloudflare API トークンには、対象アカウントの Workers と Containers を更新できる権限、`D1 Write`、`Workers R2 Storage Read` と `Workers R2 Storage Write`、`suzuki3.jp` の Worker ルートを設定できる権限を付ける。
- `meguri.suzuki3.jp` が prototype の Worker に紐づいている場合は、本実装をデプロイする前に古いカスタムドメインの紐付けを解除する。

## GitHub Actions

リポジトリの **Settings → Environments → production** を開き、デプロイ元のブランチを `main` のみに制限する。下表の Secret は `production` の Environment secrets に登録する。Variables はリポジトリか `production` に登録できる。既に本番用 Secret をリポジトリに登録している場合は、`production` に登録したうえでリポジトリ側のコピーを削除する。 [GitHub の環境設定](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| 種別 | 名前 | 値 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | デプロイ用の Cloudflare API トークン |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID。既存の同名 Secret も使える |
| Variable | `MEGURI_GITHUB_OAUTH_CLIENT_ID` | ログイン専用 GitHub OAuth App の Client ID |
| Variable | `MEGURI_OPERATOR_GITHUB_ID` | 運用者の GitHub ユーザー ID（数値） |
| Secret | `MEGURI_GITHUB_OAUTH_CLIENT_SECRET` | ログイン専用 GitHub OAuth App の Client Secret |
| Secret | `BETTER_AUTH_SECRET` | ログイン用に `openssl rand -base64 32` で生成した鍵 |
| Secret | `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 32` で生成した暗号化キー |
| Variable | `MEGURI_GH_APP_ID` | GitHub App ID |
| Secret | `MEGURI_GH_APP_PRIVATE_KEY` | GitHub App の PEM 秘密鍵 |
| Secret | `MEGURI_GH_WEBHOOK_SECRET` | App と Meguri で共有する Webhook シークレット |
| Variable | `MEGURI_PROJECTS` | 対象リポジトリと起動条件の JSON 配列。例は [projects.example.json](../config/projects.example.json) |

`MEGURI_PROJECTS` が空の場合は GitHub 起動を無効にして Worker をデプロイできる。GitHub ログインと暗号化キーを設定すると `/connect` が使える。資格情報を保存した後に暗号化キーを交換する場合は、ChatGPT を接続し直す。

### 初回セットアップ

手動ワークフローが `main` に入ったら、GitHub の **Actions → Provision Cloudflare resources → Run workflow** で `main` を選んで実行する。セットアップは不足分の作成までを行う。初回デプロイがリソース不足で失敗した場合は、セットアップの成功後に、最新の `main` に対する **Deploy API** の失敗ジョブを再実行する。 [GitHub Actions の再実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

運用開始後にリソース不足が出たときは、セットアップを再実行する前に対象アカウントと Wrangler のリソース名を確認する。

## 運用者の GitHub ログイン

GitHub の **Settings → Developer settings → OAuth Apps** でログイン専用アプリを登録する。最終構成の Homepage URL は `https://meguri.suzuki3.jp`、Authorization callback URL は `https://meguri.suzuki3.jp/api/auth/callback/github`。運用者の数値 ID は、たとえば `gh api user --jq .id` で取得できる。ログイン専用 OAuth App の Client ID と Client Secret を上の表に従って設定する。

カスタムドメイン導入前にログインを試す場合は、同じ表の設定に加えて `MEGURI_PUBLIC_ORIGIN` に Worker の `workers.dev` オリジンを設定し、OAuth App の callback URL にそのオリジンを使う。本番ドメインに切り替えるときは callback URL も更新する。

## GitHub App

対象リポジトリに App をインストールし、Repository permissions を **Issues: Read**、**Contents: Read and write**、**Pull requests: Read and write** に設定する。Webhook URL は `https://meguri.suzuki3.jp/webhooks/github` とし、`Issues` イベントを購読する。

既定ブランチに、作成・更新・削除を制限する有効な ruleset を適用する。管理者など必要な主体に限定して迂回を許可し、Meguri の GitHub App を bypass に含めない。Runner のトークンは、対象リポジトリの Contents 権限に限定される。PR の作成は Worker が別のトークンで行う。 [GitHub App のインストール認証](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

デプロイ後に `/login` から GitHub でログインし、`/connect` で ChatGPT を接続する。初回ログインで Meguri のユーザーが作られる。接続が済んだら、許可されたアカウントで Private リポジトリのテスト Issue にラベルを付ける。Webhook の配信結果に含まれる `sessionId` を `/operator/sessions/<sessionId>` に指定すると、依頼、返答、Run の結果を確認できる。


ローカル Wrangler と Docker では固定応答のジョブを実行できる。実 Codex のコマンド実行は Linux の内側のサンドボックスを使う。検証した Docker 環境の標準 seccomp 設定では `pivot_root` が拒否されたため、Cloudflare 上では最初のテスト Issue にコマンド実行を伴う小さな変更を指定して確認する。 [Codex のサンドボックス](https://learn.chatgpt.com/docs/sandboxing)
