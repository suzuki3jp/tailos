---
schema: 1
id: PDR-20261119-runner-failure-diagnostics
key: diagnostics.runner-failure-details
status: accepted
date: "2026-11-19"
decided_by: suzuki3jp
areas: [runner, diagnostics]
keywords: [agent_failed, cleanup, エラー詳細, 後処理, 一時ディレクトリ]
paths: [apps/runner/src/**]
symbols: [RunnerDiagnostics, runInGitWorkspace, createCodexAgent, createClaudeAgent]
---

# Runner の失敗段階と例外の詳細を diagnostics に記録する

## 決定

Runner が捕捉した例外の名前、メッセージ、スタック、原因の例外と、OS エラーの code・errno・syscall・path・dest を diagnostics の本文に記録する。checkout、変更確認、公開処理の失敗を対応する span に残し、Codex・Claude の実行環境と Git 作業領域の削除も cleanup の span として成功・失敗を記録する。

記録は既存の秘密情報除去、本文・総量の上限、保存期間、閲覧権限の経路を通す。任意の例外プロパティやプロセスの環境変数・標準出力・標準エラーはまとめて保存しない。Git の subprocess 例外はコマンド引数や通信ヘッダーを含みうるため、生のメッセージ・スタックを保存せず、失敗した Git 操作名と OS エラーの項目だけを保持する。

## 理由

Agent が最終回答を生成していても、その後の一時領域の削除や公開準備が失敗すると Run 全体は失敗する。失敗コードだけでは Agent の処理、実行環境、後処理を区別できず、環境の問題や再発を調査できない。失敗段階と例外を既存の診断経路に残すことで原因を追跡できる。

## 範囲と例外

診断が有効な Runner の今後の実行に適用する。既存 Run の失われた例外は復元しない。Run の成否、既存の errorCode、再試行や cleanup 失敗時の扱いは変更しない。診断の記録失敗で業務結果を変更しない既存の制約を維持する。上限超過や秘匿処理の失敗による本文欠落は、既存の captureState・dropped で確認する。
