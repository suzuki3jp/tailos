---
schema: 1
id: PDR-20261121-session-list-width-persistence
key: web.project.session-list-resize
status: superseded
date: "2026-11-21"
decided_by: suzuki3jp
areas: [web, sessions]
keywords: [セッション一覧, リサイズ, 幅, 永続化]
paths:
  - apps/web/src/_pages/session-detail/ui/session-panels.tsx
supersedes: [PDR-20261121-session-list-resize]
---

# セッション一覧の調整済みの幅を保存する

## 決定

Project のセッション詳細で、チャットと右のセッション一覧の境界をポインターまたはキーボードで動かして幅を調整できる。調整後の一覧の幅をブラウザに保存し、次に表示するときに復元する。保存済みの幅を利用できないときは既存の既定幅を使う。

## 理由

一覧のセッション名の読みやすさとチャットや入力欄の広さを、利用者が使いやすい配分に調整できる。幅を保存すると、ページを再読み込みしたり別のセッションを開いたりするたびに調整し直す手間が省ける。

## 範囲と例外

対象は二つの領域が並ぶセッション詳細のデスクトップ表示。幅は同じブラウザのセッション詳細で共有する。狭い画面では従来のナビゲーションからセッション一覧を開く。
