# Meguri から Tailos への切り替え

この手順では既存の会話、ユーザー、Run、R2 の実行ログと ChatGPT 接続を引き継ぐ。作業は同じ Cloudflare アカウント内で行う。

| 対象 | 旧 | 新 |
| --- | --- | --- |
| Web | `meguri.suzuki3.jp` | `tailos.app` |
| API | `api.meguri.suzuki3.jp` | `api.tailos.app` |
| Workers | `meguri-web` / `meguri-api` | `tailos-web` / `tailos-api` |
| D1 | `meguri` | `tailos`（APAC） |
| 非公開 R2 | `meguri-run-artifacts` | `tailos-run-artifacts` |
| GitHub | `suzuki3jp/meguri` / `meguri:run` | `suzuki3jp/tailos` / `tailos:run` |

## 準備

1. `tailos.app` を Cloudflare でアクティブにする。既存の `production` と `production-web` のデプロイトークンで、同じアカウント内のリソースと新しいゾーンを設定できることを確認する。新ホスト名に競合する DNS レコードや Worker があれば、先に解決する。
2. 既存の GitHub App と OAuth App の ID、鍵、Webhook シークレット、`BETTER_AUTH_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` を確認する。[本番デプロイ設定](deploy.md)の `TAILOS_*` 名で同じ値を登録し、`TAILOS_CREDENTIALS_FROM_WORKER` をリポジトリ変数に `meguri-api` として登録する。プロジェクトの `id`、リポジトリ ID、インストール ID は維持し、リポジトリ名と起動ラベルを新しい値にする。移管後も同じ移行タグを使うので、CredentialBroker の移管元の設定は保持する。
3. Tailos の変更を `main` に入れ、CI の成功を確認する。**データ照合が終わるまで `TAILOS_D1_DATABASE_ID` は空欄にしておく。** この変数を登録するまで Deploy はスキップする。旧版の Deploy と Provision が残っていれば完了を待つ。
4. `main` の **Provision Cloudflare resources** を実行する。APAC を配置ヒントにした `tailos` と、非公開の `tailos-run-artifacts` を準備する。旧・新 D1 の UUID をそれぞれ `MEGURI_DB_ID` と `TAILOS_DB_ID` に設定し、`cf d1 query "$TAILOS_DB_ID" --sql 'SELECT 1'` の `meta` で `served_by_primary: true`、`served_by_region: "APAC"` を確認する。APAC は希望値なので、条件を満たす DB を確保してから作業を続ける。新しい D1 が空であることを確認する。CredentialBroker は最初の API デプロイで移管されるため、`tailos-api` を先に作成する場合も移管先のクラスは作らない。 [D1 のデータ配置](https://developers.cloudflare.com/d1/configuration/data-location/) · [Durable Object の移管](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#transfer-migration)

## 書き込み停止とデータのコピー

1. 旧 GitHub App の Webhook を一時停止し、旧 Web と API への利用者の書き込みを止める。旧 API の Runner 用エンドポイントは進行中の Run が終わるまで開けておく。旧 DB の `SELECT status, COUNT(*) FROM runs WHERE status IN ('queued', 'running') GROUP BY status` が空になったら、旧 Web と API の公開リクエストをメンテナンス設定で止める。Workers の別 URL や定期トリガーからも書き込みがない状態にする。停止中に起動予定だった Issue は控えておく。
2. 同じ Cloudflare アカウントを選び、リポジトリのルートで以下を実行する。SQL ダンプは認証・会話データを含むので、アクセスを制限して保管する。会話メッセージと Run は互いを外部キーで参照する。スキーマを先に復元し、全テーブルとインデックスを作ってからデータをまとめて取り込む。D1 がデータダンプの先頭に出力する `PRAGMA defer_foreign_keys=TRUE` を保持する。新 DB への初回デプロイやマイグレーション適用は、この復元の後で行う。 [D1 のインポートとエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

   ```sh
   umask 077
   tailos_backup_dir=$(mktemp -d)
   pnpm --filter @tailos/api exec wrangler d1 export "$MEGURI_DB_ID" --remote --no-data --output="$tailos_backup_dir/schema.sql"
   pnpm --filter @tailos/api exec wrangler d1 export "$MEGURI_DB_ID" --remote --no-schema --output="$tailos_backup_dir/data.sql"
   pnpm --filter @tailos/api exec wrangler d1 execute "$TAILOS_DB_ID" --remote --file="$tailos_backup_dir/schema.sql"
   pnpm --filter @tailos/api exec wrangler d1 execute "$TAILOS_DB_ID" --remote --file="$tailos_backup_dir/data.sql"
   ```

3. 旧・新 DB で全アプリテーブルの件数、`d1_migrations` のファイル名と適用順、既存セッション・Run の ID と結果を照合する。ログインユーザーと会話を引き継げるよう、行 ID を維持する。件数または移行履歴が一致しない場合は、差異を解消してから公開に進む。
4. R2 用の S3 互換リモート `r2:` を設定し、オブジェクトキーを保ったままコピーする。Tailos はコピー済みの `meguri-api/v1/` を読み、新しいログは `tailos-api/v1/` に書く。 [Cloudflare R2 と rclone](https://developers.cloudflare.com/r2/examples/rclone/)

   ```sh
   rclone copy r2:meguri-run-artifacts r2:tailos-run-artifacts
   rclone check --download r2:meguri-run-artifacts r2:tailos-run-artifacts
   ```

## 公開と検証

1. GitHub リポジトリを `suzuki3jp/tailos` に改名し、対象リポジトリの起動ラベルと `TAILOS_PROJECTS` が一致することを確認する。既存の GitHub App と OAuth App の登録名を Tailos に更新する。ローカルでは `git remote set-url origin https://github.com/suzuki3jp/tailos.git` で追従できる。 [GitHub のリポジトリ改名](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository) · [GitHub App の設定](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
2. 照合済みの `tailos` の UUID をリポジトリ変数 `TAILOS_D1_DATABASE_ID` に設定し、最新 `main` の push で起動した CI を再実行する。Deploy が照合した DB をバインドし、`CredentialBroker` を旧 API から移管して新しい Runner 名前空間を作成する。新 API が正常になってから Web をデプロイする。
3. 両ホストの `/health` が `tailos-api` と `tailos-web` を返すことを確認する。OAuth App の Homepage を `https://tailos.app`、コールバックを `https://api.tailos.app/api/auth/callback/github` に変更する。新しいドメインで GitHub に再ログインし、以前の会話と Run 結果、ChatGPT 接続を確認する。旧 Run の ID で新 R2 バケットのコピー済みログを照合する。
4. GitHub App の Webhook を `https://api.tailos.app/webhooks/github` に更新して再開し、テスト Issue に `tailos:run` を付ける。Webhook の成功、Session、Run、PR と新しい R2 ログを確認する。停止中の依頼は処理済みかを照合してから再開する。旧 Web の URL は必要に応じてパスを維持して新 Web に転送する。

## 切り戻し

移管と新規書き込みが始まるまでは、`TAILOS_D1_DATABASE_ID` を削除し、旧ホストのメンテナンス設定を解除して、OAuth と Webhook を旧 URL に戻せる。CredentialBroker の移管後は名前空間の所有先が新 Worker に変わるため、旧 Worker の既存バインディングからの転送を確認してから戻す。旧 Worker を再デプロイする場合は、`CREDENTIALS` を `script_name: "tailos-api"` で移管先に向ける。新 DB や R2 に書き込みがあった場合は、両側を停止して差分を退避・照合してから切り戻す。旧 Worker、旧 D1、旧 R2、バックアップは切り替え検証が完了するまで保持する。GitHub リポジトリ名や起動ラベルを切り替え済みなら、旧 Worker のプロジェクト設定と再度一致させる。
