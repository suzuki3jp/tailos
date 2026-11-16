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
| [PDR-20261114-004](records/PDR-20261114-004.md) | accepted | runner.github-context-acquisition | Issue の参照情報と内容ハッシュを渡し Agent が GitHub から取得する |
| [PDR-20261114-005](records/PDR-20261114-005.md) | accepted | agent.claude.plan-mode-commands | Claude Code の plan mode ではコマンドを実行させない |
| [PDR-20261114-006](records/PDR-20261114-006.md) | accepted | agent.claude.authentication-failure | Claude の認証が拒否されても接続は自動で無効にしない |
| [PDR-20261114-007](records/PDR-20261114-007.md) | accepted | agent.claude.runtime | Claude Code は Agent SDK から実行する |
| [PDR-20261114-008](records/PDR-20261114-008.md) | accepted | agent.claude.authentication | Claude 接続は長期 OAuth トークンの貼り付けだけを対象にする |
| [PDR-20261114-009](records/PDR-20261114-009.md) | accepted | agent.claude.repository-settings | 対象リポジトリの Claude Code 設定は読み込み、隔離の境界は Run のコンテナに置く |
| [PDR-20261114-010](records/PDR-20261114-010.md) | accepted | agent.selection | 実行する Agent は Project の config で選び、未指定は Codex にする |
| [PDR-20261114-011](records/PDR-20261114-011.md) | accepted | agent.claude.token-expiry-notice | Claude トークンの期限切れは 30 日前から接続画面で知らせる |
| [PDR-20261114-project-agent-field-timing](records/PDR-20261114-project-agent-field-timing.md) | accepted | project.configuration.agent-field-timing | 今回の Project 設定管理には agent 項目を追加しない |
| [PDR-20261114-project-change-history](records/PDR-20261114-project-change-history.md) | accepted | project.configuration.change-history | Project の変更者と変更前後の設定を D1 に残す |
| [PDR-20261114-project-config-source](records/PDR-20261114-project-config-source.md) | accepted | project.configuration.source | Project 設定を明示的に移行して D1 に一本化する |
| [PDR-20261114-project-deletion](records/PDR-20261114-project-deletion.md) | accepted | project.configuration.deletion | Project 削除後は新規起動を止め履歴と既存 Run を保持する |
| [PDR-20261114-project-editable-fields](records/PDR-20261114-project-editable-fields.md) | accepted | project.configuration.editable-fields | 安定した Project ID を維持し運用設定を画面から変更する |
| [PDR-20261114-project-ownership](records/PDR-20261114-project-ownership.md) | accepted | project.configuration.ownership | Project の設定をデプロイ全体で共有する |
| [PDR-20261114-project-pending-actors](records/PDR-20261114-project-pending-actors.md) | accepted | project.configuration.pending-actors | 許可ユーザーの変更は新規受付に適用し受理済み入力は実行する |
| [PDR-20261114-project-repository-input](records/PDR-20261114-project-repository-input.md) | accepted | project.configuration.repository-input | GitHub App がアクセスできるリポジトリを select で選ぶ |
| [PDR-20261114-project-trigger-direction](records/PDR-20261114-project-trigger-direction.md) | proposed | project.future.project-session-trigger-model | 複数 Project と Session の紐付け、trigger ごとの Agent 選択を検討する |
| [PDR-20261114-project-uuid](records/PDR-20261114-project-uuid.md) | accepted | project.identity.uuid | D1 移行時に Project ID を UUID に変える |
| [PDR-20261114-project-webhook-conflict](records/PDR-20261114-project-webhook-conflict.md) | accepted | project.configuration.webhook-conflict | Project 編集と重なった Webhook は最新条件で一度だけ再試行する |
| [PDR-20261116-csp-style-attributes](records/PDR-20261116-csp-style-attributes.md) | accepted | web.csp.style-attributes | JavaScript の制限を維持し、style 属性だけを許可する |
| [PDR-20261116-home-design-preview](records/PDR-20261116-home-design-preview.md) | accepted | web.home.design-preview | Figma に合わせたホームをモックデータで先に実装する |
| [PDR-20261116-session-list-contract](records/PDR-20261116-session-list-contract.md) | accepted | sessions.account-list-contract | 会話一覧 API のページングとレスポンス契約を定める |
| [PDR-20261116-session-list](records/PDR-20261116-session-list.md) | accepted | sessions.account-list | アカウントのセッション一覧に起動元と会話の要約タイトルを表示する |
| [PDR-20261116-session-metadata-backfill](records/PDR-20261116-session-metadata-backfill.md) | accepted | sessions.metadata-backfill | 会話メタデータは保存済みの事実から補完する |
| [PDR-20261116-session-title-validation](records/PDR-20261116-session-title-validation.md) | accepted | sessions.title-validation | 生成タイトルを独立して検証し最初の正常値を一度だけ保存する |
| [PDR-20261116-session-updated-at](records/PDR-20261116-session-updated-at.md) | accepted | sessions.activity-timestamp | Session の更新日時にメッセージと Run の状態変更を反映する |
| [PDR-20261116-web-icons](records/PDR-20261116-web-icons.md) | accepted | web.design-system.icons | Web の汎用アイコンを Tabler Icons に統一する |
| [PDR-20261116-web-prototype-styles](records/PDR-20261116-web-prototype-styles.md) | accepted | web.design-system.prototype-migration | デザイン導入で既存プロトタイプの見た目の変更を許容する |
