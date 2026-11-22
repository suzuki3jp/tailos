---
schema: 1
id: PDR-20261122-project-settings-without-network
key: project.configuration.editable-fields
status: accepted
date: "2026-11-22"
areas: [projects, triggers, api, database, web]
keywords: [Routine, Project, triggerLabel, allowedActors, 許可ユーザー, 通信許可, agentNetworkAccess, 時間上限]
paths:
  - apps/api/src/application/triggers/projects.ts
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/planning.ts
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/web/src/_pages/projects/**
  - packages/core/src/runner.ts
symbols: [projectSettings, projectSchema, RepositoryTarget]
supersedes: [PDR-20261118-project-routine-settings]
decided_by: suzuki3jp
---

# label と許可ユーザーを Routine に置き、Project には通信許可を置かない

## 決定

移行後の label 起動の設定は、label・許可ユーザー `allowedActors`・prompt・engine・model・effort を Routine に保存し、その画面と API から編集する。repository と installation、Run の時間上限は Project に保存する。Agent の通信許可は設定項目として持たない。この分担は暫定的な配置ではなく正式な設定単位とする。

既存の label と許可ユーザーは移行時に Routine へコピーする。以後の label 受付は Routine の許可ユーザーだけで判定し、Project の値を継承したりフォールバックしたりしない。

旧 `Project.triggerLabel` は削除できるなら今回削除する。他の経路に必要な依存を解消できない場合だけ一時的に残す。確認したコードでは plan は値を組み立てているが、plan の checkout では label を照合しないため、その不要な参照と共有スキーマの必須制約を外して Project から削除する方針で実装する。label Run の実行コンテキストには Routine から確定した label を保存し、checkout の再照合を維持する。

Project のサーバー発行 UUID は固定し、自由な名前と repository・installation・時間上限を編集できる。名前は前後の空白除去後に 1〜100 文字で必須、同名を許可する。Project の識別は名前ではなく UUID で行う。

## 理由

同じ repository の作業でも、起動してよい人は Routine の目的によって異なる。許可ユーザーを Routine に置けば、Project を複製せずにその差を表せる。repository・実行時間は Project の作業環境全体に適用する制約として共通化する。

label の正本を Routine に移した後も Project から編集できると、値の食い違いと二重管理が生じる。plan は実行時に label を必要としないため、型と設定組立だけの依存なら外して削除する。

## 範囲と例外

[label と許可ユーザーを Routine に置いた判断](PDR-20261118-project-routine-settings.md) の後継として、Project の編集項目から Agent の通信許可を外す。Agent の通信は常に許可する（[Agent の外部通信と GitHub の認証情報](PDR-20261122-agent-egress-credential-proxy.md)）。それ以外の次の方針は維持する。

- 名前カラムを設定 JSON から分離する。名前のない既存 Project には元の repository 値を初期名として保存し、100 文字を超えていても移行で切り詰めない。新規入力と名前を編集する際には入力規則を適用する。
- Project ID の重複禁止、稼働する Project の上限 100 件、Run の時間上限の既定 30 分と許容範囲 1〜30 分を維持する。
- repository は GitHub App のアクセス可能な候補から選び、保存時に repository・ID・installation の対応を確認する。設定取得・変更・削除・履歴は所有者に限定する。
- 同じ repository を異なるアカウントがそれぞれの Project として利用できる採択済み方針は維持するが、重複登録の有効化は複数 Project への Webhook 配信と一緒に行う。今回の Routine 移行は単一運用者の範囲とする。
- 設定の変更で受付済み Run の実行設定や期限を書き換えない。

plan の Routine 移行は今回行わないため、plan の受付に必要な従来の許可ユーザー設定は Project に残す。これは未移行の plan 専用の残存設定であり、label Routine の共通既定値ではない。plan のコマンド・会話・許可判定を変更せず、不要な label の型依存だけを外す。

旧 import の label・許可ユーザーは Routine 作成へ振り分ける。過去の Project 変更履歴や Session・Run の保存済み JSON は書き換えない。実装時に削除不能な依存が見つかった場合は理由を明記して旧 `Project.triggerLabel` を一時保持し、独立した label 編集先として復活させない。

通信許可について、前の判断から次を廃止する。

- 通信許可を Project に保存し、既定を false にすること。
- 通信許可を変更するときに、外部通信・ソース送信への影響を表示すること。

保存済みの Project 設定、Project の変更履歴、受付済みの Run と planning の入力に通信許可の値が残っていても、エラーにせず無視して読む。保存済みの値や過去の変更履歴は書き換えない。新しく作る Run の実行設定には通信許可を含めない。API は通信許可を含む Project の作成・更新を、存在しない項目として受け付けない。

## 選択肢と影響

通信許可を常に true に固定して設定項目を残す案は、利用者が変えられない値を見せることになるため採らない。外部通信を常に許可する理由と不利益は [Agent の外部通信と GitHub の認証情報](PDR-20261122-agent-egress-credential-proxy.md) に記録する。
