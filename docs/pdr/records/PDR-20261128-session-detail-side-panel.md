---
schema: 1
id: PDR-20261128-session-detail-side-panel
key: web.project.session-list-resize
status: accepted
date: "2026-11-28"
decided_by: suzuki3jp
areas: [web, sessions]
keywords: [セッション一覧, 右パネル, サイドパネル, リサイズ, 幅, トリガー]
paths:
  - apps/web/src/_pages/session-detail/ui/**
symbols: [ProjectSessionPage]
supersedes: [PDR-20261121-session-list-width-persistence]
---

# Session 詳細の右パネルをセッション一覧に使わない

## 決定

Project の Session 詳細では、右側のパネルにセッション一覧を表示しない。一覧はサイドバーの Recent Sessions から開く。右パネルは今後、Session のトリガーなどの情報を表示する用途に使う予定で、その内容が決まるまでは表示しない。

右パネルを表示しないため、一覧の幅の調整と保存も行わない。狭い画面でナビゲーションの「Sessions」から開いていた Project のセッション一覧も表示せず、「Sessions」はほかの画面と同じリンクにする。

## 理由

サイドバーにアカウント全体の Recent Sessions を常に表示するため、右パネルにも一覧を置くと同じ役割が重なり、会話の領域を狭める。右パネルは Session 固有の情報を示す場所として残す方針とし、内容のない領域を先に表示しない。

## 範囲と例外

対象は Web の Project の Session 詳細。トリガーなどの情報パネルの内容・幅・開閉は、設計時に別途判断する。ブラウザに保存済みの一覧の幅は使わなくなる。

## 選択肢と影響

空の右パネルを残す案は、表示する情報がないまま会話の幅を狭めるため採用しない。Project で絞り込んだ一覧はなくなり、同じ Project の会話はサイドバーのアカウント全体の一覧から探す。
