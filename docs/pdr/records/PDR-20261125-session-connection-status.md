---
schema: 1
id: PDR-20261125-session-connection-status
key: sessions.connection-status
status: accepted
decided_by: user
date: "2026-11-25"
areas: [sessions, web]
keywords: [WebSocket, Live, 接続状態]
paths:
  - apps/web/src/_pages/session-detail/ui/project-session-content.tsx
---

# セッション詳細で WebSocket の接続完了を表示しない

## 決定

セッション詳細では WebSocket が接続済みのときに「Live」を表示しない。

## 理由

会話を閲覧する際に対応を要しない接続完了の表示を省く。

## 範囲と例外

接続待ち、再接続、認証切れの案内は引き続き表示する。WebSocket の購読と履歴の更新は従来どおり行う。
