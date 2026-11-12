# Runner 通信ポリシー

ポリシーは `apps/api/src/infrastructure/cloudflare/runner-egress.ts` と Runner のセットアップ処理で管理する。Issue、チェックアウト内の設定、`PROJECTS.agentNetworkAccess` は許可範囲を変更できない。旧フラグは保存済み Run との互換性のため受け付けるが、常に無視する。変更は実装 PR でレビューし、本番への反映は別の操作として扱う。

## 実行段階

1. Worker が HTTPS intercept を登録してから `enableInternet: false` で起動する。登録失敗時は起動しない。Codex 用起動では CA が存在しない場合も起動しない。root の entrypoint が実行時 CA をシステムの trust store に登録し、Node 用 `NODE_EXTRA_CA_CERTS` を設定してから node ユーザーへ降格する。
2. Runner が GitHub checkout を取得する。リポジトリの hook は無効。
3. `pnpm-lock.yaml` がある場合、固定の `/opt/tailos-checks/node_modules/.bin/pnpm` で `fetch --ignore-scripts --ignore-pnpmfile` を実行する。コピーするのは通常ファイルの lockfile だけ。別ディレクトリ、空の HOME、固定 registry、資格情報を含めない環境で実行し、`.npmrc`、workspace 設定、packageManager、リポジトリのコマンドは実行しない。失敗した場合は Agent を開始しない。
4. Runner lease を使う `network-closed` コールバックが registry intercept を拒否ハンドラーに置き換える。閉鎖状態を Durable Object に保存する。閉鎖成功の確認前は Codex を起動しない。閉鎖を取り消す RPC や HTTP API は存在しない。
5. Agent と検証コマンドの sandbox は常に `networkAccess: false`。必要なら Agent が `pnpm install --offline --frozen-lockfile` を実行する。pnpm の実行前メタデータ再検証は無効にする（`npm_config_verify_deps_before_run=false`、`pnpm_config_verify_deps_before_run=false`）。store は環境内の `store`（`pnpm_config_store_dir`、`npm_config_store_dir`）を使用する。インストールスクリプトも同じ通信禁止 sandbox 内で動く。新規依存や未取得の依存は通信を開けずに失敗する。pnpm 以外の依存取得には未対応。

## 許可経路

| 用途 | HTTPS 宛先 | 制約 |
| --- | --- | --- |
| セットアップの依存取得 | `registry.npmjs.org` | GET/HEAD、通常・scoped package のメタデータと `/-/*.tgz` のみ。pnpm の supply-chain 検証にメタデータが必要。query、本文、利用者ヘッダーは転送しない。認証・Cookie も削除 |
| checkout | `github.com` | Git の `info/refs` と `git-upload-pack` のみ |
| GitHub 読み取りツール | `api.github.com` | Issue/PR 番号の GET/HEAD のみ |
| Codex 推論 | `chatgpt.com` | `/backend-api/codex/` の GET/HEAD/POST |
| 資格情報更新・診断・公開 checkpoint・通信閉鎖 | デプロイ設定の `TAILOS_PUBLIC_ORIGIN` | `/_runner/runs/<id>/` の定義済み POST のみ。各 API が lease を検証 |

全経路で HTTPS 標準ポートだけを許可する。リダイレクトは手動で返し、次の要求も再評価する。HTTP、直接 IP、別ホスト、別ポートは許可しない。ワイルドカード intercept は拒否処理へ送るために使用し、許可ルールには使用しない。`enableInternet: false` により非 HTTP 通信と外部 DNS resolver への通信も拒否される。DNS 応答は intercept の placeholder に限られる。[Cloudflare の仕様](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) を参照。

現在の lockfile の通常の npm tarball は `registry.npmjs.org` 配信であり、別 CDN は許可しない。別ホストへリダイレクトする依存、独自 registry、Git 依存、ダウンロードを必要とする postinstall は利用できない。許可先の変更には配信経路の確認と PR が必要。

## 残るリスクと検証

許可した package メタデータ・tarball パスにも package 名や version を使った情報送信の余地がある。セットアップは lockfile を入力とするため、この通信自体を秘密保持境界とはしない。tarball の取得は untrusted package manager input を処理するので、pnpm とコンテナ基盤の脆弱性も残る。Agent 開始前の registry 閉鎖と、Agent のネットワーク namespace による禁止を併用する。Runner 自体の認証・推論・診断などは必要なデータを送信する。Runner の資格情報は Agent の環境へ渡さない。公開は既存のチェック済み checkpoint 経路で行う。

単体テストは URL・メソッド・ヘッダー・リダイレクト・lease・初期化失敗・設定非実行を確認する。実際の Cloudflare の TCP/UDP/DNS、CA、Codex 推論経路は実コンテナでの確認が必要。ローカルの単体テストのみで本番相当の隔離が検証済みとは扱わない。

## 反映手順

対象は API Worker（新しい outbound entrypoint と RunnerContainer）と Runner image（CA entrypoint、依存セットアップ、Codex sandbox）。DB migration と資格情報変更は不要。`TAILOS_PROJECTS` から旧 `agentNetworkAccess` を削除してよいが、削除自体は権限変更の条件ではない。

1. この PR の公開・マージと本番デプロイを分ける。変更を含む API と Runner image を同じリリースとして検証環境へ反映する。
2. Cloudflare コンテナで既存 lockfile の tarball 取得、offline install、vitest/tsc/vite を確認する。未許可ドメイン、IP、HTTP、443 以外、TCP/UDP、外部 DNS、許可先から未許可先への redirect を試し、失敗を確認する。セットアップのスクリプト非実行と、Agent のスクリプトからの通信拒否を確認する。Codex 認証・推論、checkout、資格情報更新、診断、checkpoint も確認する。
3. 新規 Run の受付を止め、旧 Run を完了させるか停止し、旧 Runner コンテナを破棄してから本番へ反映する。既存コンテナの `enableInternet: true` をコード更新だけで変更できるとは扱わない。旧イメージの Run を再開しない。
4. 新規 Run で上記 smoke check を再確認して受付を再開する。保存済みフラグが true の新規実行でも通信禁止であることを確認する。問題があれば受付を止め、失敗 Run とコンテナを終了する。旧 unrestricted image への自動フォールバックは行わない。

この実装作業は本番の変数・デプロイ・既存 Run を変更しない。
