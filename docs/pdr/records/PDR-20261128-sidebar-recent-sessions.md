---
schema: 1
id: PDR-20261128-sidebar-recent-sessions
key: web.sidebar.recent-sessions
status: accepted
date: "2026-11-28"
decided_by: suzuki3jp
areas: [web, sessions]
keywords: [サイドバー, Recent Sessions, 最近のセッション, 未読, unread, 10件, セッション一覧]
paths:
  - apps/web/src/widgets/page-shell/ui/**
  - apps/web/src/entities/session/**
  - apps/web/src/app/home-data.ts
symbols: [SidebarRecentSessions, accountSessionsQueryOptions]
supersedes: []
---

# サイドバーにアカウント全体の Recent Sessions を最大10件表示する

## 決定

サイドバーを持つ全画面で、ナビゲーションとアカウント表示の間に「Recent Sessions」を表示する。

- 対象はアカウント全体の Session とし、選択中の Project では絞り込まない。一覧 API の更新順で、重複を除いた先頭 10 件までを表示する。
- 各項目は Session 詳細へのリンクで、タイトルを 1 行に収め、収まらない分は省略記号で示す。表示中の Session の項目を強調する。
- 項目は未読マークの表示枠を持つが、未読を表すデータがまだないため、現時点では常に未読マークを表示しない。Run の状態から未読を推測しない。
- 追加取得の操作は設けない。未認証のときは一覧を表示せず、アカウント表示のサインイン導線に任せる。取得に失敗したときは再試行の操作を示す。
- サイドバーの「Sessions」項目のリンク先は変更しない。

アカウントホーム本文の Recent Sessions の件数は[ホームの判断](PDR-20261118-home-recent-sessions-limit.md)のまま 5 件とする。

## 理由

Session 詳細の右側にあったセッション一覧をやめ、どの画面からも最近の会話へ移動できるよう一覧をサイドバーへ移す。Project で絞り込むと、別の Project の会話へ移るたびに Project を切り替える必要があるため、まずはアカウント全体を対象にする。サイドバーは常に表示されるため、件数を 10 件に抑えてナビゲーションとアカウント表示を圧迫しないようにする。

一覧 API は既定で 50 件を返すため、最初のページで 10 件の表示に足りる。未読の判定には閲覧履歴などの新しいデータが必要で、Run の状態は既読とは別の事実なので推測に使わない。表示枠を先に用意し、データが揃ったときに表示を切り替えられるようにする。

## 範囲と例外

対象は Web のサイドバー（狭い画面でナビゲーションから開くサイドバーを含む）。初期表示ではサーバーで一覧の最初のページを取得し、ホームと同じ query を共有する。

未読の定義と保存先は別途判断する。表示件数の上限は表示に適用し、一覧 API の取得条件とクエリキーは変えない。

## 選択肢と影響

Project 単位の一覧は、Project ごとの会話を追いやすいが Project をまたぐ移動に手間がかかるため採用しない。サイドバーを持つ管理画面でも Session 一覧を取得するようになり、初期表示の取得が一件増える。
