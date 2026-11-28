---
schema: 1
id: PDR-20261128-routine-pages
key: web.routines.pages
status: accepted
date: "2026-11-28"
areas: [web, triggers]
keywords: [Routine, Routines, Routine 一覧, Routine 詳細, Recent sessions, サイドバー, Triggers, Prompt, routineId, 10 件]
paths:
  - apps/web/src/_pages/routines/**
  - apps/web/src/app/**/routines/**
  - apps/web/src/widgets/page-shell/ui/**
  - apps/api/src/presentation/http/handlers/sessions/sessions.ts
  - apps/api/src/infrastructure/d1/sessions.ts
symbols: [RoutinesPage, RoutineDetailPage, ROUTINE_SESSION_LIMIT, routineSessionsQueryOptions, SidebarRoutinesLink]
supersedes: []
decided_by: suzuki3jp
---

# Project の Routine を一覧・詳細ページで閲覧できるようにする

## 決定

Figma の Routines デザインに合わせ、Project ごとに Routine を閲覧する 2 つのページを追加する。

- `/{projectId}/routines`: 見出し「Routines」と説明文の下に Project の Routine を作成順に並べる。各行は名前と、モデル / effort・起動する GitHub イベント（例: `Issue on Labeled`）を表示し、詳細ページへ移動する。
- `/{projectId}/routines/{routineId}`: Routine の名前を見出しにし、Triggers（GitHub と Project のリポジトリ、イベントとラベルまたはコメントのコマンド）、Prompt、Recent sessions を表示する。
- Recent sessions は、その Routine が Issue ごとに続ける Session を更新が新しい順に最大 10 件表示する。API は Project の Session 一覧 `GET /projects/{projectId}/sessions` に `routineId` を指定できるようにし、所有者の `routine_sessions` に結び付いた Session だけを返す。
- モデルと effort はカタログの ID をそのまま表示する（例: `gpt-6.1-sol / high`）。未指定の場合は `Codex default` / `default` のように Provider の既定であることを示す。
- 有効・無効の区別は表示しない。
- ホームと同じく右側に Slot 用の幅を確保せず、左サイドバーを除いた領域の中央に最大 640px の本文を置く。上余白は共通 Page の 48px とする。
- サイドバーの Sessions と Insights の間に「Routines」を置く。ページの Project が分かる場合はその Project の、ホームなど Project を選ぶ画面では選択中の Project の Routine 一覧へ移動する。Project がない場合は押せない状態で表示する。

## 理由

Routine の設定は Settings 内の管理フォームでしか確認できず、どの Routine が何をきっかけに、どのプロンプトで動き、どの Session を作ったかを一目で追えなかった。閲覧用のページを分け、Routine から実行結果の Session へたどれるようにする。

Figma の Routines ページは右側の Slot を表示せず本文を中央に置くため、ホームと同じ配置にする。Recent sessions の件数はサイドバーの Recent Sessions と同じ 10 件とし、最近の実行状況を追うのに足りる量に抑える。モデル名は Tailos のカタログが表示名を持たないため、推測の整形をせず ID を示す。有効・無効はデザインに含まれず、編集画面のデザインと合わせて扱う。

## 範囲と例外

閲覧だけを対象にする。Routine の作成・編集・削除・変更履歴は、編集画面のデザインが用意されるまで従来どおり Settings（`/projects`）の管理フォームで行う。Routine がない場合は Settings で追加できることを案内する。

デザインの説明文は「webhooks or crons」とあるが、現在の Routine の起動は GitHub の Issue のラベルとコメントだけで、cron の起動・表示は実装していない。Routine は起動条件を一つ持つため、Triggers には一件だけ表示する。Session の未読表示は既読状態がないため出さない。

## 再検討条件

編集画面のデザインが追加されたとき、cron などの新しい起動条件や複数の起動条件を持てるようになったとき、モデルの表示名をカタログに持つようになったときに見直す。
