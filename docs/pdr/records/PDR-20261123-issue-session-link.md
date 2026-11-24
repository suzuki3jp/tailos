---
schema: 1
id: PDR-20261123-issue-session-link
key: notifications.issue-session-link
status: accepted
date: "2026-11-23"
decided_by: task-requester
areas: [notifications, sessions]
keywords: [Issue コメント, セッションリンク]
paths:
  - apps/api/src/application/notifications/issue-comment.ts
  - apps/api/src/infrastructure/d1/issue-notifications.ts
  - apps/api/src/infrastructure/d1/planning-replies.ts
---

# Issue コメントから Project のセッション画面を開く

## 決定

GitHub Issue に投稿する「セッションを開く」リンクは、セッションに保存された Project ID を使って `/{projectId}/sessions/{sessionId}` を指す。

## 理由

Issue から会話を開くと、その会話と同じ Project のセッション一覧も表示できる。

## 範囲と例外

実行状態の通知と計画への返信に適用する。Project ID が保存されていない既存セッションには `/sessions/{sessionId}` を使う。
