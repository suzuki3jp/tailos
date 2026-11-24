---
schema: 1
id: PDR-20261124-issue-routine-dispatch
key: triggers.label-automation-dispatch
status: accepted
date: "2026-11-24"
areas: [triggers, projects, database, api, sessions]
keywords: [Routine, label, issue_comment, fanout, coalesced, 順番待ち, session_inbox, Session, 冪等性, revision, 移行, 設定管理]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/infrastructure/d1/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/web/src/_pages/projects/**
symbols: [TriggerAdmission, admitTrigger, createGithubWebhook, ProjectChanged]
supersedes: [PDR-20261118-label-automation-dispatch]
decided_by: suzuki3jp
---

# Project に属する Routine を照合し、Routine と Issue ごとの Session にメッセージを足す

## 決定

Issue を起点にする Routine（label と、Issue のコメント）を次の規則で受け付ける。

- Project に属する Routine を D1 の独立したレコードにする。一つの Routine は一つのトリガー条件と一つの実行設定を持ち、プロンプトを共有する別テーブルは最初から設けない。安定した ID と revision を持たせる。
- Project ごとに複数 Routine を持てる。同じイベントで一致する有効な Routine をすべて独立して受け付け、優先順位や最初の一件で打ち切る規則を設けない。同じ Issue に複数の Session・PR・通知が発生しうることを設定画面で示す。
- 許可ユーザー `allowedActors` は Routine ごとに保存・判定する。repository・installation・Run の時間上限は Project に置く。この分担を正式な設定単位とし、Routine から Project の制約を緩める上書きを提供しない。
- 冪等性は `(source, projectId, routineId, deliveryId)` で判定する。
- **Session は Routine と Issue の組ごとに 1 つ**とし、`(ownerId, projectId, routineId, repositoryId, issueNumber)` で識別する。同じ Routine・同じ Issue の 2 回目以降の起動（label の付け直し、続きのコメント）は、既存の Session へのメッセージとして足す。異なる Routine は別の Session にし、一つの Session にまとめない。
- Session に進行中の Turn がなければ、受け付けたメッセージで Turn を作る。進行中なら、届いた順に順番待ちにし、Turn が終わってから 1 件ずつ Turn にする。後から来た配送を捨てる（`coalesced`）扱いはやめる。
- 順番待ちのメッセージは、受付時に確定した Routine の設定（revision）と実行設定で処理する。後から設定を変えても、受付済みのメッセージには適用しない。
- Turn が失敗しても Session は閉じない。次のメッセージは同じ Session で続ける。
- 受付時に Project と Routine の両 revision・所有関係・未削除・有効状態を同一トランザクションで確認する。競合時は全条件の再読込から一度だけ再試行し、再競合は 503 と診断を返す。受付済み配送の再送では、新しいメッセージを足さず元の受付結果を返す。
- 設定の変更・無効化・削除で受付済みのメッセージと Run を変更・取消しない。Routine は論理削除とし、参照と履歴を残す。Project の削除後は新規受付を止め、順番待ちのメッセージも処理しない。
- 設定管理は Project 所有者に限定し、既存の認証・Origin 検査を使う。追加・変更・無効化・削除の履歴と設定の保存を原子的に行う。新規作成した Routine は、明示的に有効化するまで無効とする。

## 理由

Project は対象リポジトリと所有・共通の実行制約をまとめ、Routine は起動条件・起動を許可するユーザー・依頼をまとめる。同じ Project でも用途ごとに起動を許可するユーザーを分けられる。

Routine と Issue ごとに Session を続けると、label の付け直しや続きのコメントが、前回の作業と会話を引き継いだまま処理される（[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)）。Routine をまたいで一つの Session にすると、互いに独立したはずの Routine が 1 件ずつしか動かなくなり、別の目的の依頼が同じ作業環境を書き換える。

作業中に届いた配送を捨てると、GitHub のように送信側を止められない起動元の指示が黙って失われる。順番待ちにして 1 件ずつ処理すれば、指示を失わず、同じ作業環境を二つの Turn が同時に書き換えることもない（[実行モデルの判断](PDR-20261123-execution-model.md)）。

## 範囲と例外

[label の Routine の受付の判断](PDR-20261118-label-routine-dispatch.md) の後継として、Session のまとめ方と作業中の配送の扱いを変え、Issue のコメントで起動する Routine にも同じ規則を適用する。コメントの判定と計画会話の扱いは [計画会話の判断](PDR-20261124-planning-routine.md) に従う。

- 移行前の label の Session は Routine と Issue の組に結びつけない。移行後の最初の label では新しい Session を始める。移行前は label のたびに新しい Session を作っていたため、続けるべき Session が一つに決まらないからである。
- 移行は Run のない状態を運用者が作って行う（[Routine の初回移行の方針](PDR-20261118-routine-initial-migration.md)）。新旧 Worker の並行稼働や旧配送の再送を支える専用の互換処理は追加しない。以下の重複排除・再送は移行後の日常運用を対象とする。
- 一部の Routine の受付だけが失敗した場合は、成功済みの受付結果を保持したまま 503 を返し、診断に失敗先を残す。再送で成功済み分を再実行せず、未受付分だけを再評価する。GitHub の自動再送を前提とせず、未受付の配送は運用者の手動再送で回復する。メッセージの保存後に Turn の開始が失敗した場合は、既存の recovery sweep で回収する。
- 再送時の未受付分は最新設定で判定する。その間に追加・有効化された Routine も候補になり、条件から外れたものは起動しない。最初の受信時点の一致集合を永続固定する方式は含めない。
- 設定取得や検証に失敗した際に固定 prompt へ戻して起動しない。未対応の trigger 種別を保存 API で拒否し、PR や cron のイベントが受け付けられると表示しない。API のレスポンスは全成功時 202、対象なし 204、一部失敗時 503 を基本とする。
- Project の設定項目は [Project の編集項目の判断](PDR-20261124-project-settings-routine-actors.md)、Routine の保存・有効化に必要な接続・モデル情報の検証は [保存・有効化の判断](PDR-20261118-routine-configuration-validation.md) に従う。
- 複数 Project への配信（[採択済みの判断](PDR-20261116-project-webhook-fanout.md)）と複数アカウントの接続選択は別工程とし、単一運用者の前提を維持する。

## 選択肢と影響

- **Issue ごとに 1 つの Session にまとめる案:** 計画の会話をそのまま実装に引き継げる。しかし別々の Routine が 1 件ずつしか動かなくなり、Routine を独立して受け付ける方針と矛盾するため採らない。
- **label は毎回新しい Session にする案:** 前回の作業を引き継げないため採らない。
- **作業中の配送を `coalesced` で捨てる従来の案:** 待機の仕組みは要らないが、後から来た指示が失われるため採らない。

不利益として、同じ Routine と Issue の依頼は前の Turn が終わるまで待つ。前回の会話と作業を引き継ぐので、まっさらな状態から始めたい場合は Agent への指示が必要になる。

Routine の名前・label・許可ユーザー・prompt は既存の入力規則を再利用する。件数の上限は設けず、設定一覧は Project ごとの全件を取得する。履歴は既存 Project 履歴と同じ 50 件ずつのカーソル形式とする。複数の受付結果は `{results: [{routineId, sessionId, runId, disposition}], failed: [routineId]}` とし、一部失敗時にも受付済み分を返す。順番待ちになったメッセージの `runId` は、Turn を作るまで無い。
