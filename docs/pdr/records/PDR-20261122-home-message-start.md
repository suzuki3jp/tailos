---
schema: 1
id: PDR-20261122-home-message-start
key: sessions.home-message-start
status: "superseded"
date: "2026-11-22"
areas: [web, sessions, triggers, agent, github]
keywords: [ホーム, 入力欄, Composer, メッセージ, 送信, Session 作成, Run 開始, web.message, trigger, variant, 起動元, Issue なし, requestId, 二重送信, リダイレクト]
paths:
  - apps/web/src/features/compose-loop/**
  - apps/web/src/_pages/home/**
  - apps/api/src/application/sessions/start-session.ts
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/api/src/infrastructure/d1/trigger-admission.ts
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - packages/core/src/runner.ts
symbols: [RunTrigger, ExecutionContext, RepositoryTarget, startSessionFromMessage, workBranchFor, LoopComposer]
supersedes: []
decided_by: suzuki3jp
---

# ホームの入力から Project の Session と Run を開始する

## 決定

アカウントホームの入力欄からメッセージを送ると、選択中の Project に新しい Session を作り、そのメッセージを最初の依頼とする Run を開始する。送信に成功したら、作成した Session の画面 `/{projectId}/sessions/{sessionId}` へ移動する。

- Session・利用者のメッセージ（`author_kind = user`）・Run・起動イベントを一つの受付で原子的に保存する。送信のたびに新しい Session を作り、既存の Run へまとめない。
- Run は Project のリポジトリを checkout して実装し、変更があれば PR を作る。Agent は Codex に限る。plan モードは対象外。
- model と effort は入力欄で選んだ値を使い、ソースに定義した Codex のモデル・effort 一覧で検証する。未指定なら provider の既定を使う。時間上限と通信許可は Project の設定に従う。
- 送信できるのは Project の所有者だけ。GitHub の利用者ではないため、Routine の許可ユーザーは適用しない。
- 二重送信を防ぐため、クライアントが入力ごとに発行する `requestId` で重複を判定し、同じ `requestId` の再送には最初の結果を返す。新しい同時実行の上限は設けない。
- Codex 未接続、Project が見つからない・削除済み、入力不正の場合は何も保存せず、送信できなかったことを入力欄に表示する。
- Session の初期タイトルはメッセージの先頭行を最大 100 文字に切り詰めたものとし、Agent の最初の正常な応答で要約タイトルに置き換える（[Session 一覧の判断](PDR-20261116-session-list.md) と同じ）。一覧の起動元（`Triggered by Issue #…`）は表示しない。

### 起動元ごとの値は trigger の variant に持たせる

Run の実行設定（`execution_context`）では、リポジトリの情報（repository・ID・installation・既定ブランチ・通信許可）と、起動元ごとの値を分ける。起動元は `kind` で区別する variant の `trigger` とし、起動元ごとに必要な値だけを持つ。

| kind | 持つ値 |
| --- | --- |
| `github.issue-label` | Issue 番号・内容ハッシュ・起動ラベル |
| `github.issue-comment` | Issue 番号・内容ハッシュ（`@tailos plan` の計画会話） |
| `web.message` | なし |

Issue の取得と内容照合、ラベルの再照合、Issue への通知・返信、PR 本文の `Closes #N` は Issue を持つ trigger だけに適用する。起動元を追加するときは variant を一つ増やす。

### Issue を持たない Run の PR はアプリで作り込まない

Issue を持たない Run について、PR の題名・説明・関連 Issue の書き方などをアプリの規則で決めない。必要なら利用者がメッセージ（プロンプト）で指示する。アプリは公開に必要な機械的な処理だけを行う。作業ブランチは `tailos/run/<runId>`、PR の題名は Agent が返したコミットの見出し、本文は Run ID の記載だけとする。

## 理由

これまで Session と Run は GitHub の Webhook からしか作れず、ホームの入力欄は送信しても何も作らないプレビューだった。Project とモデルを選べる入力欄から直接依頼できれば、Issue を用意せずに作業を始められる。

実行経路は Issue を前提にしており、Issue 番号・内容ハッシュ・ラベルがリポジトリの情報と同じ場所に必須項目として入っていた。ここに任意項目を足すと、どの起動元でどの値が必要かが型で表せない。起動元ごとの variant にすれば、Issue 前提の処理を Issue を持つ起動元に限定でき、将来の起動元も値の組を追加するだけで済む。

Issue を持たない Run の PR 本文や Issue との関連付けは、依頼ごとに望ましい形が異なる。アプリで固定すると利用者が変えられないため、プロンプトに委ね、アプリはブランチ作成と PR 作成の最低限だけを担う。

送信のたびに新しい Session にするのは、ホームが新しい会話を始める場所だからである。既存の会話を続ける入力はセッション画面に属し、今回は対象外とする。所有者に限るのは、Project の設定・接続・リポジトリ権限がすべて所有者に属するためである。`requestId` による重複判定は、通信の再試行や連打で同じ依頼の Run が複数できることを防ぐ。

## 範囲と例外

対象はアカウントホームの入力欄。セッション画面の入力欄は引き続き送信できない（[Project セッション画面の判断](PDR-20261121-project-session-timeline.md)）。Project を持たない単発チャット、Claude での実行、plan モード、既存 Session への続行、添付ファイルは後続とする。[ホーム初期取得の判断](PDR-20261118-home-prefetch-deadline.md) が対象外とした「入力からの実行開始」をこの記録で扱う。初期取得の期限などその他の方針は変更しない。

既存の label 起動と計画会話の挙動（Issue の照合、ラベルの再照合、通知、PR 本文の `Closes #N`、受付・同時実行の規則）は変更しない。保存済みの Run と計画入力の旧形式（Issue の値がリポジトリ情報に入った形式）は、読み込み時に対応する trigger へ変換して扱い、保存済みの行は書き換えない。

PR の公開には既存の検証（リポジトリ ID と既定ブランチの照合、既定ブランチの保護ルール、署名付きコミットと tree の照合）をそのまま適用する。受付時に GitHub から既定ブランチを取得し、取得できない場合は 503 とし何も保存しない。

## 選択肢と影響

- **Issue 番号などを `RepositoryTarget` の任意項目にする案**：変更は小さいが、起動元と必要な値の対応が型に表れず、新しい起動元を足すたびに任意項目が増える。採用しない。
- **Issue を持たない PR に専用の題名・本文・関連 Issue の規則を設ける案**：依頼内容によって適切な形が異なり、アプリで固定すると利用者が変えられない。採用しない。
- **Project なしの単発チャットも同時に対応する案**：リポジトリを持たない実行経路と表示の設計が別に必要になるため、後続とする。

不利益として、Issue を持たない Run の PR には関連 Issue が自動では付かない。必要な場合は利用者がプロンプトで指示する。同時実行の上限がないため、連続して送ると Run が並行して動く。
