---
schema: 1
id: PDR-20261118-label-automation-dispatch
key: triggers.label-automation-dispatch
status: accepted
date: "2026-11-18"
areas: [triggers, projects, database, api]
keywords: [Routine, label, fanout, coalesced, 冪等性, revision, 移行, 設定管理]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/infrastructure/d1/**
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/web/src/_pages/projects/**
symbols: [TriggerAdmission, admitTrigger, createGithubWebhook, ProjectChanged]
supersedes: []
decided_by: suzuki3jp
---

# Project に属する Routine を照合して label Run を独立して受け付ける

## 決定

移行後の label 起動を次の規則で受け付ける。

- Project に属する Routine を D1 の独立したレコードにする。一つの Routine は一つのトリガー条件と一つの実行設定を持ち、プロンプトを共有する別テーブルは最初から設けない。安定した ID と revision を持たせる。
- Project ごとに複数 Routine を持てる。同じイベントで一致する有効な label Routine をすべて独立して受け付け、優先順位や最初の一件で打ち切る規則を設けない。同じ Issue に複数の Run・PR・通知が発生しうることを設定画面で示す。
- 許可ユーザー `allowedActors` は Routine ごとに保存・判定する。repository・installation・通信許可・Run の時間上限は Project に置く。この分担を正式な設定単位とし、Routine から Project の制約を緩める上書きを提供しない。既存 label の移行では Project の許可ユーザーを Routine にコピーし、以後の label 受付で Project の許可ユーザーへフォールバックしない。
- 冪等性を `(source, projectId, routineId, deliveryId)`、同時実行のまとめ先を `(ownerId, projectId, routineId, repositoryId, issueNumber)` で分離する。異なる Routine を一つの Run にまとめない。
- 同じ Routine・Issue の実行中に別 delivery が来た場合は、現在と同じ `coalesced` とする。新しい依頼を待機列へ追加したり、実行中の prompt を更新したりしない。設定変更後でも、先行 Run にまとめられた配送は先行 Run の設定で処理される。
- 受付時に Project と Routine の両 revision・所有関係・未削除・有効状態を同一トランザクションで確認する。競合時は全条件の再読込から一度だけ再試行し、再競合は 503 と診断を返す。受付済み配送の再送では、新しい設定の Run を作らず元の受付結果を返す。
- 設定の変更・無効化・削除で受付済み Run を変更・取消しない。Routine は論理削除とし、参照と履歴を残す。Project の削除後は新規受付を止める。
- 既存 Project に現在の label と固定 prompt を持つ有効な Routine を一つ作る。新規作成は明示的に有効化するまで無効とし、既定の prompt 候補には既存の実装指示を使う。
- 設定管理は Project 所有者に限定し、既存の認証・Origin 検査を使う。追加・変更・無効化・削除の履歴と設定の保存を原子的に行う。

## 理由

Project は対象リポジトリと所有・共通の実行制約をまとめ、Routine は起動条件・起動を許可するユーザー・依頼をまとめる。同じ Project でも用途ごとに起動を許可するユーザーを分けられるようにする。この分離により、Project を複製しなくても目的の異なる起動を定義できる。

配送や同時実行を repository・Issue だけで識別すると、別の設定が先に受け付けた Run に依頼が吸収される。Routine の識別子と設定版を持つことで、重複配送の排除と異なる実行目的の独立性を両立する。

既存設定を有効な一件へ移すと通常の label 起動を保てる。新規設定は保存と有効化を分けることで、編集途中の条件から意図せず実行されるのを避けられるが、有効化の操作が一つ増える。

## 範囲と例外

label 起動の移行に適用し、plan の inbox・delivery・会話順序は移さない。[複数 Project への配信](PDR-20261116-project-webhook-fanout.md) は採択済みだが、この checkout では未実装である。今回は単一運用者の前提を維持し、Project をまたぐ配信と複数アカウントの接続選択は別工程に分ける。

名称と初回移行の運用前提は [採択済みの Routine 初回移行方針](PDR-20261118-routine-initial-migration.md) に従う。デプロイ時には Run のない状態を運用者が作り、新旧 Worker の並行稼働や旧配送の再送を支える専用の互換処理は追加しない。以下の重複排除・再送は、移行後の日常運用を対象とする。

一部の Routine の保存だけが失敗した場合は、成功済みの受付結果を保持したまま 503 を返し、診断に失敗先を残す。再送で成功済み分を再実行せず、未受付分だけを再評価する。GitHub の自動再送を前提とせず、未受付の配送は運用者の手動再送で回復する。Run の保存後に scheduling が失敗した場合は、既存の recovery sweep で回収する。

再送時の未受付分は最新設定で判定する。その間に追加・有効化された Routine も候補になり、条件から外れたものは起動しない。最初の受信時点の一致集合を永続固定する方式は今回含めない。

設定取得や検証に失敗した際に固定 prompt へ戻して起動しない。未対応 trigger 種別を保存 API で拒否し、PR や cron のイベントが実際に受け付けられると表示しない。API のレスポンスは全成功時 202、対象なし 204、一部失敗時 503 を基本とし、複数件の結果形式は実装前に契約を確定する。

Project の label・許可ユーザーの移動と、未移行の plan に残る設定は [Project 設定の後継判断](PDR-20261118-project-routine-settings.md) に従う。Routine 設定の保存・有効化に必要な接続・モデル情報の検証は [保存・有効化の判断](PDR-20261118-routine-configuration-validation.md) に従う。

## 選択肢と影響

Project に trigger と prompt の項目を増やす案は単一ルールなら簡単だが、複数目的や別イベント種別を追加しにくい。トリガーとプロンプトを別々の再利用可能な資源にする案は、共有設定を変更したときの影響範囲と版管理が必要になる。最初は一件の Routine にまとめる。

同一対象のイベントを必ず順番に実行する案なら実行中に来た依頼を処理できるが、待機と新しいジョブ数上限が必要になる。採用する coalescing は現行に近い一方、後から来た配送を別の依頼として実行しない。

Routine の名前・label・許可ユーザー・prompt は既存の入力規則を再利用する。新しい件数上限は今回導入せず、設定一覧は Project ごとの全件を取得する。履歴は既存 Project 履歴と同じ 50 件ずつのカーソル形式とする。複数受付結果は `{results: [{routineId, sessionId, runId, disposition}], failed: [routineId]}` とし、一部失敗時にも受付済み分を返す。
