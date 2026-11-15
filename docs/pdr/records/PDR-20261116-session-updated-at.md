---
schema: 1
id: PDR-20261116-session-updated-at
key: sessions.activity-timestamp
status: accepted
date: "2026-11-16"
decided_by: suzuki3jp
areas: [sessions, runs, api]
keywords: [updated_at, updatedAt, 更新日時, 返信のない失敗, セッション一覧]
paths:
  - apps/api/src/application/sessions/**
  - apps/api/src/infrastructure/d1/sessions.ts
  - apps/api/src/infrastructure/d1/schema.ts
  - apps/api/src/infrastructure/d1/trigger-admission.ts
  - apps/api/src/infrastructure/d1/planning.ts
  - apps/api/src/infrastructure/d1/run-execution.ts
symbols: [sessions, sessionMessages, runs]
supersedes: []
---

# Session の更新日時にメッセージと Run の状態変更を反映する

## 決定

Session に `updated_at` を持たせ、Session 作成、メッセージ追加、Run 作成、Run の状態遷移で更新する。Run の開始・成功・失敗も更新に含める。

作成時は `created_at` と同じ値とし、保存する時刻の単位は Unix ミリ秒とする。閲覧、内部の再試行時刻、診断、通知だけの更新では動かさない。

## 理由

アカウントホームの会話一覧では、最近活動した Session を見つけられる必要がある。Run の失敗は返信メッセージを伴わない場合があるため、メッセージ追加だけを更新対象にすると失敗した会話が上に現れず、利用者が気づきにくい。Run の状態変更も更新日時へ反映することで、返信のない失敗にも気づけるようにする。

閲覧や内部の保守処理まで更新対象にすると、会話や実行の活動と関係なく並び順が変わるため、それらは対象外にする。

## 範囲と例外

会話の永続データである `sessions` に適用する。ログイン状態の更新日時とは区別する。Run は `queued`、`running`、`succeeded`、`failed` の状態を持ち、状態を変えないスケジュール更新は含めない。

まだメッセージや Run に割り当てていない計画 inbox への入力受理だけでも更新するか、既存データの更新日時をどう補完するかは、この判断では確定しない。

更新日時は失敗の発生を一覧の順序へ反映するものであり、一覧で失敗の状態を表示するためのレスポンス項目は別途決める。
