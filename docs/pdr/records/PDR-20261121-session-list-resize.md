---
schema: 1
id: PDR-20261121-session-list-resize
key: web.project.session-list-resize
status: accepted
date: "2026-11-21"
decided_by: suzuki3jp
areas: [web, sessions]
keywords: [セッション一覧, チャット, リサイズ, 幅, resizable]
paths:
  - apps/web/src/_pages/session-detail/ui/session-panels.tsx
  - apps/web/src/_pages/session-detail/ui/project-session-page.tsx
supersedes: []
---

# セッション一覧とチャットの境界を動かして幅を調整する

## 決定

Project のセッション詳細で、チャットと右のセッション一覧の境界を動かして表示幅を調整できるようにする。境界はポインターとキーボードで操作でき、初期表示は既存デザインの幅を使う。

## 理由

一覧を広げると長いセッション名を読みやすくなり、狭めると会話や入力欄を広く使える。左右の領域を同時に表示できる幅に収め、調整中も両方の操作を続けられるようにする。

## 範囲と例外

対象は二つの領域が並ぶセッション詳細のデスクトップ表示。狭い画面では従来のナビゲーションからセッション一覧を開く。
