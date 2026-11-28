---
schema: 1
id: PDR-20261114-project-config-source
key: project.configuration.source
status: accepted
date: "2026-11-14"
areas: [projects, deployment]
keywords: [PROJECTS, TAILOS_PROJECTS, D1, 移行, 初期値]
paths: ["apps/api/src/application/projects/settings.ts", "apps/api/src/presentation/http/handlers/github-webhook/**", "docs/deploy.md", ".github/workflows/deploy.yml"]
symbols: [projectsSchema]
supersedes: []
decided_by: suzuki3jp
---

# Project 設定を明示的に移行して D1 に一本化する

## 決定

実行時の Project 設定は D1 のみから読み、`PROJECTS` と `TAILOS_PROJECTS` の実行時読み取り・自動投入・フォールバックを廃止する。既存 JSON は運用者が明示的に実行するインポート手順で移す。

## 理由

環境変数と D1 の両方を読むと、画面で削除した設定が再投入されたり、どちらの値が使われるか分かりにくくなる。明示的な一括移行なら設定と Session の対応を保ち、移行の成否も確認できる。Project ID はこの移行に合わせて UUID に変え、旧 ID を維持する方式は採らない。

## 範囲と例外

移行は旧 JSON 全体を既存の入力制約で検証し、Project ごとに新しい UUID を割り当てる。設定、旧 ID と UUID の対応、既存 Session の `project_id` の付け替え、移行履歴を一括で保存する。詳細は [Project ID の UUID 化](PDR-20261114-project-uuid.md) に従う。

初回インポートは Project の登録履歴がない D1 に限定し、再実行で既存設定を上書きしない。通常の追加・変更・削除は個別の管理 API で行う。

D1 に設定がなければ Project 起点の新規 Run は起動しない。D1 の読み取り失敗では起動を失敗として扱い、旧設定へ戻さない。作成済み Run は保存した設定で続行する。

デプロイ手順には、GitHub 起動の停止、D1 移行と設定インポート、内容確認、起動再開の順を記す。切り替え中に既存設定が使われ続ける無停止移行は今回の保証範囲に含めない。

## 選択肢と影響

環境変数を初期値にする案は移行操作を減らせるが、空の設定と未移行状態の区別が必要になる。D1 への一本化では手動の移行と切り替え時間が必要になる。
