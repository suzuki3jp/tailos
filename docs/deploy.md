# Meguri の本番デプロイ

`main` の最新コミットに対する CI が成功すると **Deploy** が走る。API と Runner をデプロイし、API の公開確認後に Web をデプロイする。

API ジョブは Wrangler 設定の名前で既存の D1 と R2 を探し、D1 マイグレーション、API Worker と Runner イメージのデプロイ、`api.meguri.suzuki3.jp/health` の確認を行う。

## Cloudflare

- D1 の `meguri` と R2 の `meguri-run-artifacts` がまだない場合は、手動の **Provision Cloudflare resources** で作成する。R2 は非公開で作成される。同名のリソースは再利用される。
- Cloudflare API トークンには、対象アカウントの Workers と Containers を更新できる権限、`D1 Write`、`Workers R2 Storage Read` と `Workers R2 Storage Write`、`suzuki3.jp` の Worker ルートを設定できる権限を付ける。
- API Worker は `api.meguri.suzuki3.jp`、Web Worker は `meguri.suzuki3.jp` を使う。Wrangler が各 Custom Domain を割り当て、Cloudflare が DNS レコードと TLS 証明書を作成する。マージ前に、両ホスト名に Meguri 以外で使っている DNS レコードや Worker がないことを確認する。 [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

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

手動ワークフローが `main` に入ったら、GitHub の **Actions → Provision Cloudflare resources → Run workflow** で `main` を選んで実行する。セットアップは不足分の作成までを行う。初回デプロイがリソース不足で失敗した場合は、セットアップの成功後に、最新の `main` に対する **Deploy** の失敗ジョブを再実行する。 [GitHub Actions の再実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

運用開始後にリソース不足が出たときは、セットアップを再実行する前に対象アカウントと Wrangler のリソース名を確認する。

## Web のデプロイ

### 初回の Web 公開

1. マージ前に GitHub Actions の `production-web` 環境を作り、デプロイ元を `main` に制限する。Web Worker と `suzuki3.jp` の Custom Domain を設定できる `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録する。既存の API 用 D1 と R2 があり、進行中の Run が完了していることを確認する。
2. `main` の CI が通ると、API の公開確認後に Wrangler が `meguri-web` Worker を作成し、静的アセットをアップロードして `meguri.suzuki3.jp` を割り当てる。Web が使う Cloudflare リソースはこのデプロイで揃う。最後に `/health` が Web Worker を返すまで再試行する。
3. API が新ドメインで応答したら、下記の GitHub OAuth App のコールバックと GitHub App の Webhook URL を更新する。Web 公開後に GitHub でログインし直し、テスト Issue から Session まで確認する。

ドメイン割り当てが失敗した場合は、Cloudflare の **Domains & Routes** と DNS を確認する。旧 API Worker や prototype に紐づいたままなら解除し、最新の `main` に対する **Deploy** の失敗ジョブを再実行する。

ローカルでは `pnpm dev` で API を起動し、別のターミナルで `pnpm --filter @meguri/web dev` を実行して `http://localhost:3000` を開く。ローカル用の GitHub OAuth App のコールバックには `http://localhost:8787/api/auth/callback/github` を設定する。

## 運用者の GitHub ログイン

GitHub の **Settings → Developer settings → OAuth Apps** でログイン専用アプリを登録する。本番デプロイはカスタムドメインを使うため、Homepage URL は `https://meguri.suzuki3.jp`、Authorization callback URL は `https://api.meguri.suzuki3.jp/api/auth/callback/github` とする。運用者の数値 ID は、たとえば `gh api user --jq .id` で取得できる。ログイン専用 OAuth App の Client ID と Client Secret を上の表に従って設定する。

## GitHub App

対象リポジトリに App をインストールし、Repository permissions を **Issues: Read**、**Contents: Read and write**、**Pull requests: Read and write** に設定する。Webhook URL は `https://api.meguri.suzuki3.jp/webhooks/github` とし、`Issues` イベントを購読する。

既定ブランチに、作成・更新・削除を制限する有効な ruleset を適用する。管理者など必要な主体に限定して迂回を許可し、Meguri の GitHub App を bypass に含めない。Runner のトークンは、対象リポジトリの Contents 権限に限定される。PR の作成は Worker が別のトークンで行う。 [GitHub App のインストール認証](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

デプロイ後に `/login` から GitHub でログインし、`/connect` で ChatGPT を接続する。初回ログインで Meguri のユーザーが作られる。接続が済んだら、許可されたアカウントで Private リポジトリのテスト Issue にラベルを付ける。Webhook の配信結果に含まれる `sessionId` を `/sessions/<sessionId>` に指定すると、依頼、返答、Run の結果を確認できる。


Issue 起点の Run では、対象リポジトリのルートに `format:check` と `lint` の pnpm スクリプトが必要。Runner イメージには Meguri の CI と同じバージョンの pnpm・oxfmt・oxlint を組み込み、ネットワークを閉じたサンドボックスで検査する。公開には GitHub App の Contents と Pull requests の書き込み権限を使う。現在の公開経路は通常ファイルの追加・更新・削除に対応し、実行ビットの変更やシンボリックリンクの追加など GitHub のファイル変更 API で表現できない差分は Run を失敗させる。公開リクエストの上限は 4 MiB。

ローカル Wrangler と Docker では固定応答のジョブを実行できる。実 Codex のコマンド実行は Linux の内側のサンドボックスを使う。検証した Docker 環境の標準 seccomp 設定では `pivot_root` が拒否されたため、Cloudflare 上では最初のテスト Issue にコマンド実行を伴う小さな変更を指定して確認する。 [Codex のサンドボックス](https://learn.chatgpt.com/docs/sandboxing)
