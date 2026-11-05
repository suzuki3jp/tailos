---
name: github
description: Meguri の GitHub PR や Issue を調べ、依頼された GitHub 操作を行う。
---

# GitHub 操作

- 利用可能な GitHub コネクタ、または認証済みの `gh` を使う。`gh` では `gh pr`、`gh issue`、`gh api` を使い、必要に応じて `gh api graphql` を使う。
- 対象のリポジトリと PR・Issue 番号を確定してから操作する。一覧は必要なページをすべて取得する。
- 書き込みの範囲は依頼に従う。レビューでは対象 PR のレビュー、コメント、ラベル更新に限定する。ドラフト PR の作成は明示的に依頼された場合に行う。
- PR を作成する場合は、タイトルを Conventional Commits 形式にし、タイトルと本文は英語で書く。
- 認証や権限で失敗した場合は、接続や実行環境を確認する。`gh` の未認証が確認できた場合は、対話セッションなら `gh auth login` を案内し、Routine なら必要な接続や権限をセッションで報告する。
