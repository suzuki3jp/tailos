---
schema: 1
id: PDR-20261114-project-pending-actors
key: project.configuration.pending-actors
status: accepted
date: "2026-11-14"
areas: [projects, planning, auth]
keywords: [allowedActors, 許可ユーザー, 取消, 保留入力, pending, 計画会話]
paths: ["apps/api/src/infrastructure/d1/planning.ts"]
symbols: [acceptPlanningInput, dispatchPlanningInputs]
supersedes: []
decided_by: suzuki3jp
---

# 許可ユーザーの変更は新規受付に適用し受理済み入力は実行する

## 決定

許可されている時点で受理した計画入力は、投稿者が後で `allowedActors` から外れても実行する。許可ユーザーの変更は、その後のコメント受付に適用する。

## 理由

永続化して受理した入力を後から暗黙に破棄せず、受付済みの依頼と新規受付の権限を分けて扱う。Project の削除では新規 Run を停止し、既存 Run は保存済み設定で続行するという判断も維持する。

## 範囲と例外

実行中の別 Run があるために計画 inbox で保留されている、未割当の受理済み入力が対象。Project 削除や対象リポジトリの不一致による停止を解除しない。新しい Run の通信許可・時間上限などには作成時の Project 設定を使う。

## 選択肢と影響

未実行の入力にも権限取消を反映する方式では、許可されなくなった投稿者の入力を実行せず、後続入力を妨げない状態へ移す必要がある。受理済みを実行する方式では、運用者がユーザーを外しても既に受理した指示は残ることを明示する必要がある。
