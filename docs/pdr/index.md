# PDR 一覧

`pnpm pdr catalog --write` で生成。直接編集しない。Agent は一覧全体を読み込まず検索 CLI を使う。

| ID | 状態 | 論点 | 決定 |
| --- | --- | --- | --- |
| [PDR-20261113-001](records/PDR-20261113-001.md) | accepted | pdr.storage-and-retrieval | PDR は Markdown を正本とし検索 CLI から段階的に取得する |
| [PDR-20261113-002](records/PDR-20261113-002.md) | accepted | pdr.human-decision-workflow | プロダクト判断は人間の合意と根拠を残して実装へ渡す |
| [PDR-20261113-003](records/PDR-20261113-003.md) | accepted | agent.reply.overflow | 長い返答は同じ会話で Agent に要約を再要求する |
| [PDR-20261113-004](records/PDR-20261113-004.md) | unverified | agent.reply.limit-value | 返答上限 8,000 の当初の選定根拠は未確認 |
| [PDR-20261113-005](records/PDR-20261113-005.md) | unverified | agent.reply.repair-publication-budget | 実装の要約失敗時の成果保持と時間配分は個別承認が未確認 |
| [PDR-20261113-006](records/PDR-20261113-006.md) | accepted | notifications.persistence | Issue 通知は Run と独立した永続送信状態で回収する |
| [PDR-20261113-007](records/PDR-20261113-007.md) | accepted | notifications.record-shape | 通知レコードから重複値と将来用カラムを削減する |
| [PDR-20261113-008](records/PDR-20261113-008.md) | accepted | notifications.initial-migration | 未適用だった Issue 通知のマイグレーションを 1 本へ統合する |
| [PDR-20261113-009](records/PDR-20261113-009.md) | accepted | notifications.loading-background | 通知 GIF の背景色を favicon の背景色と揃える |
| [PDR-20261113-010](records/PDR-20261113-010.md) | unverified | notifications.retry-budget | 通知の通算 20 回での打ち切りはプロダクト上の個別承認が未確認 |
| [PDR-20261113-011](records/PDR-20261113-011.md) | accepted | pdr.self-contained-records | 判断の説明は PDR 本文で完結させ、チャットを保存しない |
| [PDR-20261113-012](records/PDR-20261113-012.md) | accepted | planning.issue-conversation | Issue の明示コマンドで計画会話を永続化する |
| [PDR-20261114-001](records/PDR-20261114-001.md) | rejected | planning.issue-conversation | 計画会話は必須入力を保持し古い履歴をバイト予算内で渡す |
| [PDR-20261114-002](records/PDR-20261114-002.md) | superseded | runner.github-context-acquisition | Issue 本文の送信を当面維持し将来は Agent が GitHub から取得する |
| [PDR-20261114-003](records/PDR-20261114-003.md) | superseded | runner.github-context-acquisition | Issue の参照情報を JSON で渡し Agent が GitHub から本文を取得する |
| [PDR-20261114-004](records/PDR-20261114-004.md) | superseded | runner.github-context-acquisition | Issue の参照情報と内容ハッシュを渡し Agent が GitHub から取得する |
| [PDR-20261114-005](records/PDR-20261114-005.md) | accepted | agent.claude.plan-mode-commands | Claude Code の plan mode ではコマンドを実行させない |
| [PDR-20261114-006](records/PDR-20261114-006.md) | accepted | agent.claude.authentication-failure | Claude の認証が拒否されても接続は自動で無効にしない |
| [PDR-20261114-007](records/PDR-20261114-007.md) | accepted | agent.claude.runtime | Claude Code は Agent SDK から実行する |
| [PDR-20261114-008](records/PDR-20261114-008.md) | accepted | agent.claude.authentication | Claude 接続は長期 OAuth トークンの貼り付けだけを対象にする |
| [PDR-20261114-009](records/PDR-20261114-009.md) | accepted | agent.claude.repository-settings | 対象リポジトリの Claude Code 設定は読み込み、隔離の境界は Run のコンテナに置く |
| [PDR-20261114-010](records/PDR-20261114-010.md) | superseded | agent.selection | 実行する Agent は Project の config で選び、未指定は Codex にする |
| [PDR-20261114-011](records/PDR-20261114-011.md) | accepted | agent.claude.token-expiry-notice | Claude トークンの期限切れは 30 日前から接続画面で知らせる |
| [PDR-20261114-project-agent-field-timing](records/PDR-20261114-project-agent-field-timing.md) | accepted | project.configuration.agent-field-timing | 今回の Project 設定管理には agent 項目を追加しない |
| [PDR-20261114-project-change-history](records/PDR-20261114-project-change-history.md) | accepted | project.configuration.change-history | Project の変更者と変更前後の設定を D1 に残す |
| [PDR-20261114-project-config-source](records/PDR-20261114-project-config-source.md) | accepted | project.configuration.source | Project 設定を明示的に移行して D1 に一本化する |
| [PDR-20261114-project-deletion](records/PDR-20261114-project-deletion.md) | accepted | project.configuration.deletion | Project 削除後は新規起動を止め履歴と既存 Run を保持する |
| [PDR-20261114-project-editable-fields](records/PDR-20261114-project-editable-fields.md) | superseded | project.configuration.editable-fields | 安定した Project ID を維持し運用設定を画面から変更する |
| [PDR-20261114-project-ownership](records/PDR-20261114-project-ownership.md) | superseded | project.configuration.ownership | Project の設定をデプロイ全体で共有する |
| [PDR-20261114-project-pending-actors](records/PDR-20261114-project-pending-actors.md) | accepted | project.configuration.pending-actors | 許可ユーザーの変更は新規受付に適用し受理済み入力は実行する |
| [PDR-20261114-project-repository-input](records/PDR-20261114-project-repository-input.md) | accepted | project.configuration.repository-input | GitHub App がアクセスできるリポジトリを select で選ぶ |
| [PDR-20261114-project-trigger-direction](records/PDR-20261114-project-trigger-direction.md) | proposed | project.future.project-session-trigger-model | 複数 Project と Session の紐付け、trigger ごとの Agent 選択を検討する |
| [PDR-20261114-project-uuid](records/PDR-20261114-project-uuid.md) | accepted | project.identity.uuid | D1 移行時に Project ID を UUID に変える |
| [PDR-20261114-project-webhook-conflict](records/PDR-20261114-project-webhook-conflict.md) | accepted | project.configuration.webhook-conflict | Project 編集と重なった Webhook は最新条件で一度だけ再試行する |
| [PDR-20261116-csp-style-attributes](records/PDR-20261116-csp-style-attributes.md) | accepted | web.csp.style-attributes | JavaScript の制限を維持し、style 属性だけを許可する |
| [PDR-20261116-home-design-preview](records/PDR-20261116-home-design-preview.md) | superseded | web.home.design-preview | Figma に合わせたホームをモックデータで先に実装する |
| [PDR-20261116-project-account-list](records/PDR-20261116-project-account-list.md) | accepted | projects.account-list | アカウントの Project 一覧を名前順にページングして取得する |
| [PDR-20261116-project-account-ownership](records/PDR-20261116-project-account-ownership.md) | accepted | project.configuration.ownership | Project をアカウントの所有にする |
| [PDR-20261116-project-editable-fields](records/PDR-20261116-project-editable-fields.md) | superseded | project.configuration.editable-fields | Project に自由な名前を追加しリポジトリの重複を許可する |
| [PDR-20261116-project-name-validation](records/PDR-20261116-project-name-validation.md) | accepted | project.name.validation | Project 名は前後の空白を除いて1〜100文字とし同名を許可する |
| [PDR-20261116-project-owner-assignment](records/PDR-20261116-project-owner-assignment.md) | accepted | project.ownership.assignment | Project の所有者を内部ユーザー ID で保存し既存分を現運用者へ割り当てる |
| [PDR-20261116-project-webhook-fanout](records/PDR-20261116-project-webhook-fanout.md) | accepted | project.webhook.repository-fanout | 同じリポジトリの複数 Project に Webhook を配信する |
| [PDR-20261116-session-list-contract](records/PDR-20261116-session-list-contract.md) | accepted | sessions.account-list-contract | 会話一覧 API のページングとレスポンス契約を定める |
| [PDR-20261116-session-list](records/PDR-20261116-session-list.md) | accepted | sessions.account-list | アカウントのセッション一覧に起動元と会話の要約タイトルを表示する |
| [PDR-20261116-session-metadata-backfill](records/PDR-20261116-session-metadata-backfill.md) | accepted | sessions.metadata-backfill | 会話メタデータは保存済みの事実から補完する |
| [PDR-20261116-session-title-validation](records/PDR-20261116-session-title-validation.md) | accepted | sessions.title-validation | 生成タイトルを独立して検証し最初の正常値を一度だけ保存する |
| [PDR-20261116-session-updated-at](records/PDR-20261116-session-updated-at.md) | accepted | sessions.activity-timestamp | Session の更新日時にメッセージと Run の状態変更を反映する |
| [PDR-20261116-web-icons](records/PDR-20261116-web-icons.md) | accepted | web.design-system.icons | Web の汎用アイコンを Tabler Icons に統一する |
| [PDR-20261116-web-prototype-styles](records/PDR-20261116-web-prototype-styles.md) | accepted | web.design-system.prototype-migration | デザイン導入で既存プロトタイプの見た目の変更を許容する |
| [PDR-20261117-api-versioning](records/PDR-20261117-api-versioning.md) | superseded | api.url-versioning | ブラウザー向け API のプレフィックスをバージョン付きにする |
| [PDR-20261117-home-api-integration](records/PDR-20261117-home-api-integration.md) | superseded | web.home.design-preview | ホームの Project と Session 一覧を実データに接続する |
| [PDR-20261117-home-server-prefetch](records/PDR-20261117-home-server-prefetch.md) | superseded | web.home.design-preview | ホームの初期データをサーバーで並列取得する |
| [PDR-20261117-login-cookie-scope](records/PDR-20261117-login-cookie-scope.md) | superseded | auth.login.cookie-scope | SSR のためログイン Cookie を Web と API で共有する |
| [PDR-20261118-configurable-label-prompt](records/PDR-20261118-configurable-label-prompt.md) | accepted | runner.github-context-acquisition | label の依頼は設定から取得し Issue の参照と内容照合を維持する |
| [PDR-20261118-configurable-triggers](records/PDR-20261118-configurable-triggers.md) | accepted | triggers.configurable-execution | トリガーと実行設定を DB で管理し label 起動から移行する |
| [PDR-20261118-home-prefetch-deadline](records/PDR-20261118-home-prefetch-deadline.md) | accepted | web.home.design-preview | ホームの初期取得に全体10秒の期限を設ける |
| [PDR-20261118-home-recent-sessions-limit](records/PDR-20261118-home-recent-sessions-limit.md) | accepted | web.home.recent-sessions-limit | ホームの Recent Sessions を最大5件表示する |
| [PDR-20261118-label-automation-dispatch](records/PDR-20261118-label-routine-dispatch.md) | accepted | triggers.label-automation-dispatch | Project に属する Routine を照合して label Run を独立して受け付ける |
| [PDR-20261118-project-routine-settings](records/PDR-20261118-project-routine-settings.md) | superseded | project.configuration.editable-fields | label と許可ユーザーを Routine に置き、共通の実行制約は Project に置く |
| [PDR-20261118-automation-agent-selection](records/PDR-20261118-routine-agent-selection.md) | accepted | agent.selection | label の実行設定を Routine ごとに選び Codex から対応する |
| [PDR-20261118-routine-configuration-validation](records/PDR-20261118-routine-configuration-validation.md) | accepted | triggers.routine-configuration-validation | 接続やモデル情報を確認できない Routine も無効状態で保存する |
| [PDR-20261118-routine-initial-migration](records/PDR-20261118-routine-initial-migration.md) | accepted | triggers.routine-initial-migration | Routine と呼び、初回移行は Run のない状態で行う |
| [PDR-20261118-routine-model-options](records/PDR-20261118-routine-model-options.md) | superseded | triggers.routine-model-options | Routine のモデルと effort を選択式にする |
| [PDR-20261119-routine-model-catalog-cache](records/PDR-20261119-routine-model-catalog-cache.md) | superseded | triggers.routine-model-catalog-cache | Routine のモデル候補取得を所有者・接続ごとにまとめる |
| [PDR-20261119-routine-model-catalog-transport](records/PDR-20261119-routine-model-catalog-transport.md) | superseded | triggers.routine-model-catalog-transport | Routine のモデル候補を app-server の model/list から取得する |
| [PDR-20261119-runner-failure-diagnostics](records/PDR-20261119-runner-failure-diagnostics.md) | accepted | diagnostics.runner-failure-details | Runner の失敗段階と例外の詳細を diagnostics に記録する |
| [PDR-20261121-pr-preview-approval](records/PDR-20261121-pr-preview-approval.md) | superseded | deployment.pr-previews | 運用者が Preview ラベルを付けた PR を公開する |
| [PDR-20261121-pr-previews](records/PDR-20261121-pr-previews.md) | superseded | deployment.pr-previews | PR ごとに Web と API の Workers Preview を公開する |
| [PDR-20261121-project-session-detail](records/PDR-20261121-project-session-detail.md) | superseded | web.project.session-detail | Project のセッション画面で保存済みの会話と Agent の実行ログを読む |
| [PDR-20261121-project-session-preview](records/PDR-20261121-project-session-preview.md) | superseded | web.project.session-detail | Project のセッション画面で保存済みの会話と実行時間を表示する |
| [PDR-20261121-project-session-timeline](records/PDR-20261121-project-session-timeline.md) | accepted | web.project.session-detail | 会話内の実行タイムラインと展開できる履歴をデザインシステムに沿って表示する |
| [PDR-20261121-session-execution-timeline](records/PDR-20261121-session-execution-timeline.md) | accepted | sessions.execution-timeline | セッション向けの実行タイムラインを保存し実行中も配信する |
| [PDR-20261121-session-list-resize](records/PDR-20261121-session-list-resize.md) | superseded | web.project.session-list-resize | セッション一覧とチャットの境界を動かして幅を調整する |
| [PDR-20261121-session-list-width-persistence](records/PDR-20261121-session-list-width-persistence.md) | accepted | web.project.session-list-resize | セッション一覧の調整済みの幅を保存する |
| [PDR-20261121-session-realtime-transport](records/PDR-20261121-session-realtime-transport.md) | accepted | sessions.realtime-transport | Session 単位の WebSocket 配信で履歴の後から更新を受け取る |
| [PDR-20261122-agent-egress-credential-proxy](records/PDR-20261122-agent-egress-credential-proxy.md) | accepted | agent.network.egress | Agent の外部通信を常に許可し、GitHub の認証情報はコンテナの外で差し込む |
| [PDR-20261122-api-versioning](records/PDR-20261122-api-versioning.md) | accepted | api.url-versioning | 本番のブラウザー向け API を Web の `/api/v1` で提供する |
| [PDR-20261122-codex-model-catalog-in-source](records/PDR-20261122-codex-model-catalog-in-source.md) | accepted | triggers.routine-model-catalog-transport | Codex のモデル・effort 候補を Tailos のソースに定義する |
| [PDR-20261122-codex-model-catalog-no-fetch-cache](records/PDR-20261122-codex-model-catalog-no-fetch-cache.md) | accepted | triggers.routine-model-catalog-cache | モデル候補取得のまとめ・キャッシュを廃止する |
| [PDR-20261122-home-message-start](records/PDR-20261122-home-message-start.md) | accepted | sessions.home-message-start | ホームの入力から Project の Session と Run を開始する |
| [PDR-20261122-login-cookie-scope](records/PDR-20261122-login-cookie-scope.md) | accepted | auth.login.cookie-scope | 本番のログイン Cookie を Web ホストに限定する |
| [PDR-20261122-pr-preview-tailos-app](records/PDR-20261122-pr-preview-tailos-app.md) | accepted | deployment.pr-previews | PR Preview を tailos.app 配下で本番と同じ API パスに揃える |
| [PDR-20261122-project-settings-without-network](records/PDR-20261122-project-settings-without-network.md) | accepted | project.configuration.editable-fields | label と許可ユーザーを Routine に置き、Project には通信許可を置かない |
| [PDR-20261122-routine-model-options-from-source](records/PDR-20261122-routine-model-options-from-source.md) | accepted | triggers.routine-model-options | Routine のモデルと effort を Tailos 定義の候補から選択する |
