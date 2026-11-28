---
schema: 1
id: PDR-20261128-session-message-list-line-height
key: web.session.message-list-line-height
status: accepted
date: "2026-11-28"
areas: [web, sessions, design-system]
keywords: [Markdown, 箇条書き, 行間, line-height]
paths:
  - apps/web/src/_pages/session-detail/ui/message-markdown.module.css
supersedes: []
decided_by: suzuki3jp
---

# セッションメッセージの箇条書きの行の高さを 20px にする

## 決定

セッションメッセージの順序付き・順序なしリストの行の高さを 20px にする。入れ子のリストにも同じ高さを適用する。

## 理由

16px の本文に対して行の高さを 20px にすることで、折り返しや改行を含む項目内の行に余裕を持たせる。

## 範囲と例外

[セッションメッセージの Markdown 表示](PDR-20261126-session-message-markdown.md)が対象とする、保存済みメッセージ本文のリストに適用する。
