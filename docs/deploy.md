# Tailos の本番デプロイ

`TAILOS_D1_DATABASE_ID` を設定すると、`main` の最新コミットに対する CI の成功後に **Deploy** が走る。API と Runner をデプロイし、API の公開確認後に Web をデプロイする。

API ジョブは Wrangler 設定の名前で既存の D1 と R2 を探し、D1 マイグレーション、API Worker と Runner イメージのデプロイ、`api.tailos.app/health` の確認を行う。

旧 Meguri 環境から移行する場合は、[切り替え手順](cutover.md)に従う。

## Cloudflare

- D1 の `tailos` と R2 の `tailos-run-artifacts` がまだない場合は、手動の **Provision Cloudflare resources** で作成する。D1 の配置ヒントは APAC、R2 は非公開。同名のリソースは再利用される。
- Cloudflare API トークンには、対象アカウントの Workers と Containers を更新できる権限、`D1 Write`、`Workers R2 Storage Read` と `Workers R2 Storage Write`、`suzuki3.jp` の Worker ルートを設定できる権限を付ける。
- API Worker は `api.tailos.app`、Web Worker は `tailos.app` を使う。Wrangler が各 Custom Domain を割り当て、Cloudflare が DNS レコードと TLS 証明書を作成する。マージ前に、両ホスト名に Tailos 以外で使っている DNS レコードや Worker がないことを確認する。 [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## GitHub Actions

リポジトリの **Settings → Environments → production** を開き、デプロイ元のブランチを `main` のみに制限する。下表の Secret は `production` の Environment secrets に登録する。Variables はリポジトリか `production` に登録できる。既に本番用 Secret をリポジトリに登録している場合は、`production` に登録したうえでリポジトリ側のコピーを削除する。 [GitHub の環境設定](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| 種別 | 名前 | 値 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | デプロイ用の Cloudflare API トークン |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID。既存の同名 Secret も使える |
| Variable | `TAILOS_GITHUB_OAUTH_CLIENT_ID` | ログイン専用 GitHub OAuth App の Client ID |
| Variable | `TAILOS_OPERATOR_GITHUB_ID` | 運用者の GitHub ユーザー ID（数値） |
| Secret | `TAILOS_GITHUB_OAUTH_CLIENT_SECRET` | ログイン専用 GitHub OAuth App の Client Secret |
| Secret | `BETTER_AUTH_SECRET` | ログイン用に `openssl rand -base64 32` で生成した鍵 |
| Secret | `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 32` で生成した暗号化キー |
| Variable | `TAILOS_GH_APP_ID` | GitHub App ID |
| Secret | `TAILOS_GH_APP_PRIVATE_KEY` | GitHub App の PEM 秘密鍵 |
| Secret | `TAILOS_GH_WEBHOOK_SECRET` | App と Tailos で共有する Webhook シークレット |

Project の設定は D1 に保存し、`/projects` から管理する。`TAILOS_PROJECTS` と Worker の `PROJECTS` はデプロイ時・実行時ともに使用しない。D1 に Project がなければ GitHub 起動は行わない。デプロイ前に D1 を読み取り、稼働中の Project があれば GitHub ログイン・App 設定・Webhook secret・暗号化キーの前提を検証する。読み取り不能や前提不足の場合はマイグレーション・デプロイの前に停止する。GitHub ログインと暗号化キーを設定すると `/connect` が使える。資格情報を保存した後に暗号化キーを交換する場合は、ChatGPT と Claude を接続し直す。

### 初回セットアップ

手動ワークフローが `main` に入ったら、GitHub の **Actions → Provision Cloudflare resources → Run workflow** で `main` を選んで実行する。セットアップは不足分の作成までを行う。初回デプロイがリソース不足で失敗した場合は、セットアップの成功後に、最新の `main` に対する **Deploy** の失敗ジョブを再実行する。 [GitHub Actions の再実行](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

新規環境では、作成された D1 の UUID と配置を確認してからリポジトリ変数 `TAILOS_D1_DATABASE_ID` を登録し、最新 `main` の push の CI を再実行する。既存環境の移管時は、データコピーの照合を済ませてから登録する。

運用開始後にリソース不足が出たときは、セットアップを再実行する前に対象アカウントと Wrangler のリソース名を確認する。

## Project の名前と所有者の移行

`0010_project_account_identity.sql` は既存 Project（削除済みも含む）の名前を保存済みの `repository` 値で補完する。UUID、版、更新時刻、過去の変更履歴は変更しない。100 文字を超える既存値も切り詰めない。以後の新規作成と名前の変更は、前後の空白を除いて 1〜100 文字の必須入力にする。

デプロイスクリプトは SQL migration の適用後、未割り当ての Project を `TAILOS_OPERATOR_GITHUB_ID` に対応する Tailos 内部ユーザーへ割り当ててから Worker を公開する。現在の運用者が一度もログインしていない場合は、既存デプロイでログインしてから移行する。対応する内部ユーザーがないまま未割り当て行が残る場合、公開を停止する。GitHub ログインが未設定なら `TAILOS_OPERATOR_GITHUB_ID` を含むログイン設定一式を追加し、設定済みなら現在の運用者でログインしてからデプロイを再実行する。既に割り当てた所有者は、運用者の設定変更や再実行で移転しない。

migration 適用後に旧 Worker が受理した新規追加・インポートも、DB の互換トリガーで名前と所有者を INSERT 時に保存する。この場合の所有者は旧 Worker が認証結果から保存した作成者 ID であり、名前は repository 値を使う。所有者割り当ての後に旧リクエストが完了した場合も、未割り当てや空の名前を残さない。作成履歴は一件に保ち、revision と時刻は変えない。

ローカルで SQL migration のみを適用した既存 DB にも、現在の運用者でログインした後に次の SQL をローカル D1 へ適用する。`123` は現在の `TAILOS_OPERATOR_GITHUB_ID` に置き換える。これは初回の未割り当て分だけを対象とし、既存所有者は変更しない。

```sql
UPDATE projects SET owner_id = (
  SELECT user_id FROM auth_accounts
  WHERE provider_id = 'github' AND account_id = '123'
) WHERE owner_id IS NULL;
SELECT count(*) AS unassigned FROM projects WHERE owner_id IS NULL;
```

設定画面では自分が所有する Project を管理する。旧形式 JSON の初回インポートは従来の入力形式を受け付け、名前を `repository` 値、所有者を操作したユーザーとして保存する。

## 既存 Project 設定の D1 移行

この切り替えには GitHub 起動を停止する時間を設ける。設定は自動投入されない。

1. GitHub App の Webhook 配信を一時停止し、旧 `TAILOS_PROJECTS` の JSON 配列を運用者の手元へ退避する。切り替えに備えて D1 のバックアップを取る。進行中の Run の ID を控える。
2. 通常の Deploy で `0008_project_settings.sql` を含む D1 マイグレーションと API・Runner・Web を反映する。既存の Run は保存済みの実行設定で続行する。旧設定へのフォールバックは行わない。
3. 運用者でログインし、`/projects` の「既存設定を初回インポート」を開く。退避した JSON 配列を貼り付けてインポートする。入力形式の例は [projects.example.json](../config/projects.example.json)。新規追加を行う前に移行を実施する。
4. API は全件の制約と GitHub App からのリポジトリアクセスを確認する。旧 ID ごとに UUID を一つ発行し、Project、旧 ID と UUID の対応、既存 Session の `project_id`、計画会話と inbox の識別キー、移行履歴を同じ D1 トランザクションで確定する。失敗時はすべてロールバックする。登録履歴のある環境や完了済みのインポートへの再実行は拒否する。空配列のインポートも完了として記録する。
5. 一覧の全 Project と、移行で作成された Routine の起動ラベル・許可ユーザー、Project の通信許可・上限時間、変更履歴を確認する。既存 Session が参照する UUID を次の読み取り専用 SQL でも照合できる。移行設定に存在しなかった旧 ID は推測で変換せず、そのまま残す。

   ```sql
   SELECT id, legacy_id, repository_id FROM projects ORDER BY legacy_id;
   SELECT s.id, s.project_id, p.legacy_id
   FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
   WHERE s.project_id IS NOT NULL;
   ```

6. 内容を確認して Webhook 配信を再開し、テスト Issue から新しい Run の起動を確認する。停止中に失敗した必要な配送は GitHub 側で再送する。移行前の `TAILOS_PROJECTS` 変数は削除できる。

以後は `/projects` で追加・編集・削除する。リポジトリは App の installation から取得した select の候補から選択し、保存時にもアクセスを再確認する。GitHub 障害時には保存せず、再試行する。候補一覧・設定・履歴は運用者だけが閲覧でき、変更には Web の Origin も必要になる。

削除は新規起動を止める論理削除であり、queued・running の Run を取り消さない。Session・会話・Run・変更履歴は保持する。削除済み Project の復元は提供せず、同じリポジトリを再登録する場合は新しい UUID になる。編集中に別の変更が確定した場合は競合エラーになるため、一覧を更新してから編集し直す。Webhook の設定読み取りと受付が競合した場合は、最新の Project で起動条件を確認し直して一度だけ再試行する。再び競合した場合や D1 障害時は 503 と診断を返す。GitHub は失敗した配送を自動再送しないため、必要な配送は配信履歴から手動で再送する。

## label 設定の Routine 移行

初回は queued / running の Run がない状態を運用者が作り、設定編集や起動操作を控えて migration `0011_routines.sql` と API・Runner・Web の公開を行う。既存 Project の label・許可ユーザー・固定プロンプトは有効な Routine に引き継がれ、Project の現行設定から `triggerLabel` を削除する。plan 用の許可ユーザー設定は Project に残す。過去の Session・Run・設定履歴は書き換えない。

同じイベントに複数の有効な Routine が一致すれば、それぞれ Run・PR・通知が作られる。同じ Routine・Issue の実行中の配送は既存 Run にまとめる。一部だけ受付に失敗した場合は 503 と `failed` の Routine ID を確認し、移行後の配送を手動再送する。受付済み分は再実行しない。移行前の旧配送の再送や新旧 Worker の並行稼働のための互換層は追加しない。判断の範囲は [初回移行の PDR](pdr/records/PDR-20261118-routine-initial-migration.md) に従う。

## Web のデプロイ

### 初回の Web 公開

1. マージ前に GitHub Actions の `production-web` 環境を作り、デプロイ元を `main` に制限する。Web Worker と `suzuki3.jp` の Custom Domain を設定できる `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録する。既存の API 用 D1 と R2 があり、進行中の Run が完了していることを確認する。
2. `main` の CI が通ると、API の公開確認後に Wrangler が `tailos-web` Worker を作成し、静的アセットをアップロードして `tailos.app` を割り当てる。Web が使う Cloudflare リソースはこのデプロイで揃う。最後に `/health` が Web Worker を返すまで再試行する。
3. API が新ドメインで応答したら、下記の GitHub OAuth App のコールバックと GitHub App の Webhook URL を更新する。Web 公開後に GitHub でログインし直し、テスト Issue から Session まで確認する。

ドメイン割り当てが失敗した場合は、Cloudflare の **Domains & Routes** と DNS を確認する。旧 API Worker や prototype に紐づいたままなら解除し、最新の `main` に対する **Deploy** の失敗ジョブを再実行する。

ローカルの環境変数、GitHub OAuth App のコールバック URL、API と Web の起動手順は [ローカル開発](local-development.md)を参照。

## 運用者の GitHub ログイン

ホームの SSR に対応した版では、API を先に、次に Web をデプロイし、`/login` で再ログインする。ログイン Cookie は新しい `tailos.session_token`（HTTPS では `__Secure-` 接頭辞付き）へ切り替わり、本番では `Domain=tailos.app` で Web と API に共有される。旧 API 専用 Cookie は新しい認証では使わない。HttpOnly・Secure・SameSite=Lax と既存の Origin 検査は維持する。`tailos.app` 配下のサブドメインには信頼できないサービスを置かない。詳細は [Cookie の共有方針](pdr/records/PDR-20261117-login-cookie-scope.md) を参照する。ローカルは Web と API が同じ `localhost` を使い、Domain を付けずにポート間で共有する。

既存環境を `/api` から `/v1` へ更新する際も、GitHub OAuth App の Authorization callback URL を新しい `/v1/auth/callback/github` に変更する。

GitHub の **Settings → Developer settings → OAuth Apps** でログイン専用アプリを登録する。本番デプロイはカスタムドメインを使うため、Homepage URL は `https://tailos.app`、Authorization callback URL は `https://api.tailos.app/v1/auth/callback/github` とする。運用者の数値 ID は、たとえば `gh api user --jq .id` で取得できる。ログイン専用 OAuth App の Client ID と Client Secret を上の表に従って設定する。

## GitHub App

対象リポジトリに App をインストールし、Repository permissions を **Issues: Read and write**、**Contents: Read and write**、**Pull requests: Read and write** に設定する。Webhook URL は `https://api.tailos.app/webhooks/github` とし、`Issues` と `Issue comment` イベントを購読する。

既存インストールでは App 設定の権限変更後、GitHub のインストール設定で追加権限のリクエストを確認して承認する。未承認の間は通知が permission 状態で停止するため、承認後に該当する `issue_notifications` の `error_category` を NULL、`next_attempt_at` を 0 に戻して再送する。通知用の書き込みトークンは API Worker 内だけで使用し、使用後に失効させる。

恒久的な API エラー、または一時障害で通算 20 回の送信試行に達した通知は permanent 状態で停止する。原因を解消して手動で再送する場合は、該当する通知の `error_category` を NULL、`next_attempt_at` を 0、`attempts` を 0 に戻す。レート制限は指定された待機時間とバックオフに従って再試行する。

既定ブランチに、作成・更新・削除を制限する有効な ruleset を適用する。管理者など必要な主体に限定して迂回を許可し、Tailos の GitHub App を bypass に含めない。Runner のトークンは、対象リポジトリの Contents・Issues・Pull requests の読み取りに限定される。Agent は Runner のツールを使って Issue と PR を番号で参照できる。PR の作成は Worker が別のトークンで行う。 [GitHub App のインストール認証](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

デプロイ後に `/login` から GitHub でログインし、`/connect` で ChatGPT を接続する。初回ログインで Tailos のユーザーが作られる。接続が済んだら、`/projects` でリポジトリを選び、「Routine を管理」から起動ラベル・許可ユーザー・プロンプト・必要な model / effort を保存して有効にする。無効状態なら接続やモデル情報を検証できなくても保存できるが、有効化には検証が必要になる。その後、許可されたアカウントで Private リポジトリのテスト Issue にラベルを付ける。Webhook の配信結果の `results` 配列に含まれる各 `sessionId` を `/sessions/<sessionId>` に指定すると、依頼、返答、Run の結果を確認できる。


Issue 起点の Run では、Agent が対象リポジトリの指示と CI 設定を参照し、作業ディレクトリで適用できる整形・lint・テストなどを実行する。実行結果と、実行できなかった検証の理由を返答に記載する。Runner イメージには Tailos 自体を検証するための pnpm・oxfmt・oxlint を組み込む。公開には GitHub App の Contents と Pull requests の書き込み権限を使う。現在の公開経路は通常ファイルの追加・更新・削除に対応し、実行ビットの変更やシンボリックリンクの追加など GitHub のファイル変更 API で表現できない差分は Run を失敗させる。公開リクエストの上限は 4 MiB。

Codex の Run は `standard-3`（8 GiB、2 vCPU）で起動する。oxlint の JS プラグインは大きなメモリ領域を確保するため、Tailos の `pnpm lint` は 1 スレッドに固定し、従来の `standard-1`（4 GiB、1/2 vCPU）よりメモリの余裕を持たせる。リソース増加により Run ごとの利用料金も増える。固定応答の Run とヘルスチェックは `lite` のまま。Linux のメモリ割り当て設定にも依存するため、デプロイ後は新規 Run で lint の成功を確認する。背景は [oxlint の既知のメモリ確保問題](https://github.com/oxc-project/oxc/issues/20331) を参照。

チェックアウトを伴う Run では、ホーム・一時領域・キャッシュ・pnpm のロック用領域・ユーザー用ツールの配置先を Run ごとに作成し、作業ディレクトリと合わせて書き込みを許可する。これらの環境変数はサンドボックス内のコマンドに渡し、app-server 自身は Agent のホームや一時領域を使用しない。領域は Codex の認証用ディレクトリと分け、Run 終了時に削除する。

Runner イメージは `codex-linux-sandbox` を Codex のネイティブ実行ファイルへのリンクとして `/usr/local/bin` に配置する。Codex は `/tmp` 配下の使い捨て `CODEX_HOME` には helper の別名を作成しないため、外部の bubblewrap が PATH から helper を起動できるようにする。Codex の更新でパッケージ内の配置が変わった場合はイメージのビルドを失敗させ、配置を見直す。

Agent のコマンドによるネットワーク利用は既定で無効。依存取得などで必要なプロジェクトは、運用者が `/projects` の対象 Project で「Agent のコマンドによる通信を許可する」を有効にする。設定は Run 作成時に保存され、Issue 本文やリポジトリ内の設定からは変更できない。有効にした Run では、依存関係のスクリプトを含む Agent のコマンドが任意の宛先に通信でき、非公開ソースや読み取り可能なデータが外部に送信される可能性がある。この条件を許容できるプロジェクトに限って有効にする。

既存の実行可能ファイルは、実行ビットを維持したまま内容を更新できる。新規ファイルは非実行モードで作成する必要がある。

ローカル Wrangler と Docker では固定応答のジョブを実行できる。実 Codex のコマンド実行は Linux の内側のサンドボックスを使う。検証した Docker 環境の標準 seccomp 設定では `pivot_root` が拒否されたため、Cloudflare 上では最初のテスト Issue にコマンド実行を伴う小さな変更を指定して確認する。 [Codex のサンドボックス](https://learn.chatgpt.com/docs/sandboxing)

### Issue 調査用の計画実行

信頼された API が ExecutionContext の `mode: "plan"` を設定すると、RunnerJob までモードを引き継ぐ。本文・Agent 出力・リポジトリの指示からモードは変更できない。省略時は従来の実装動作であり、実装ジョブには互換性のため新しいキーを送らない。

計画 checkout は対象リポジトリ、installation、open な Issue（PR ではないこと）と基準 SHA を確認する。実装ラベルと公開用 ruleset は要求しない。Runner のトークンは対象リポジトリの Contents・Issues・Pull requests の読み取りに限る。Agent は checkout があっても read-only sandbox を使い、ネットワーク許可設定を引き継がない。通常の turn RPC を使い、app-server の対話的 Plan 機能は使わない。質問は最終結果に含め、回答待ちでプロセスを維持しない。

結果本文は計画・前提・変更対象・手順・検証方法・質問を記載できる自由文とし、`planPresented` と `needsAnswer` を別途返す。質問だけでも正常終了する。D1 の Run 結果には `kind: "plan"` と両フラグを保存し、本文は Session の Agent メッセージとして保存する。入力は 4,000 文字、本文は 8,000 文字で API と Runner の共有スキーマを使う。計画では staging を実行せず、API の公開受付と公開復旧経路も拒否する。基準 SHA、資格情報の失効、checkout の削除、終了時のコンテナ停止は既存経路を使う。

Codex に渡す出力スキーマには文字列の長さ制約を付けず、秘密情報を除去した返答を Runner で検証する。長さは共有スキーマに合わせて UTF-16 コード単位で数える。本文が 8,000 を超えた場合は切り詰めず、同じ会話で要点と質問を保持して 7,000 以下に要約するよう最大 2 回再要求する。再要求は読み取り専用で行い、追加の調査・検証・ファイル変更は指示しない。Run の残り時間が 5 秒未満、または 2 回の再要求後も上限を超える場合、計画モードと checkout なしの実行は失敗として終了する。実装 checkout がある場合は、再要求開始に残り 60 秒以上を必要とし、各ターンの待機は最大 30 秒とする。公開処理のため少なくとも 30 秒を残す。要約の回数超過・時間不足・タイムアウト・応答不備では、完成した変更を維持し、要約を取得できなかったことを明示する案内文と、最初の回答の headline を使って公開処理を続ける。再要求のタイムアウト時は使い捨ての app-server を終了し、実行中のターンも停止する。

更新は共有契約を含む Runner イメージを先に用意し、新 Worker と組み合わせてから計画の受付を有効にする。旧 strictObject は未知の mode / plan を拒否するため、旧 Worker / Runner で計画を受付しない。モード省略の保存済み Context / Job はそのまま利用できる。コメントの計画受付・会話継続には新しい migration と `planningContext` に対応した Runner / Worker を組み合わせる。実装ラベルへの計画引継ぎは後続 Issue の担当。


### Issue 内で計画を相談する

GitHub App 設定で **Issue comment** の購読を追加する。Issues の書き込み権限と、既存 installation の権限変更時の追加承認は上記の手順を使う。運用者のログインと Codex 接続、PROJECTS の repository ID・installation ID・allowedActors の設定も必要。

許可されたアカウントで open な Issue の新規コメント先頭に `@tailos plan` を投稿する。タイトル・本文を使った計画または質問が返るので、`@tailos <回答・修正依頼>` で続ける。再度の `@tailos plan` も同じ Session で再調査する。編集や削除では再実行せず、引用やコードフェンス中のメンションは受け付けない。実装は引き続き `tailos:run` ラベルから開始し、コメントでは起動しない。

新 migration は planning_issues / planning_inbox / planning_deliveries / planning_snapshots / planning_replies と終了時の SQL trigger を追加する。Run の状態画像と計画本文は別コメントに投稿する。Session の閲覧は従来どおり運用者だけに許可するが、返信本文は Issue の閲覧者に公開される。

受付後に停止しても、pending inbox の次 Run 作成、queued Run の起動、期限切れ通知リースの再取得を Cron が回収する。実行中の追記は捨てずに順次実行する。返信に失敗しても Agent を再実行しない。送信できない場合は planning_replies の state / attempts / error_category / next_attempt_at / lease_until と対応 Run を確認する。permission / permanent は自動再試行を停止して後続の返信を解放する。入力超過や取得失敗は Run の error_code と返信に残る。planning_snapshots から各 Run の Issue・SHA・対象入力を追える。会話全体が既存 Runner ジョブの 32 KiB 上限に収まらない場合は全文を保存したまま明示的に失敗する。
