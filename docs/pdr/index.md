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
| [PDR-20261114-003](records/PDR-20261114-003.md) | accepted | runner.github-context-acquisition | Issue の参照情報を JSON で渡し Agent が GitHub から本文を取得する |
