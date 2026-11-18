---
schema: 1
id: PDR-20261116-project-editable-fields
key: project.configuration.editable-fields
status: superseded
date: "2026-11-16"
areas: [projects, api, database]
keywords: [Project名, 自由な名前, name, migration, repository, リポジトリ重複]
paths:
  - apps/api/src/application/triggers/projects.ts
  - apps/api/src/application/projects/**
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/schema.ts
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/migrations/**
symbols: [projectSettings, projectSchema, projectsSchema, d1Projects]
supersedes: [PDR-20261114-project-editable-fields]
decided_by: suzuki3jp
---

# Project に自由な名前を追加しリポジトリの重複を許可する

## 決定

Project はリポジトリ名とは独立した、利用者が自由に付ける名前を持つ。D1 の `projects` に名前を保存する `name` カラムを追加する。ホームの Project 選択には、この名前を表示する。

既存 Project の移行では、現在の設定の `repository` 値を名前の初期値に使う。既存の値は `owner/repository` 形式なので、例えば `suzuki3jp/tailos` をそのまま移す。以後の名前は自由に設定する項目であり、リポジトリ名そのものとは分離する。

従来の設定編集方針のうち、サーバー発行の UUID を固定し、それ以外の既存の設定項目を変更できる方針は維持する。ただし、リポジトリの重複禁止は [採択済みの複数 Project への配信方針](PDR-20261116-project-webhook-fanout.md) に合わせて変更し、異なるアカウントが同じリポジトリの Project をそれぞれ持てるようにする。

## 理由

ホームに表示する Project 名は、利用者が開発対象として付けたい名前である。リポジトリの識別子を表示名に固定すると、この用途を満たせないため、独立した値として保存する。

既存 Project には名前が保存されていない。既に保存されているリポジトリの値で補完すれば、移行時に既存 Project ごとの名前を手作業で入力せずに済む。

設定を画面から変更でき、安定した ID を維持する従来方針は継続する。同じリポジトリの Project を複数作れる判断と矛盾しないように、従来の編集項目の判断に含まれる重複制約も更新する。

## 範囲と例外

これは仕様の採択であり、カラムや migration の実装・適用はまだ行っていない。新規作成・編集・旧形式インポートの具体的な入力契約、設定 JSON と名前カラムの関係、過去の変更履歴の読み取り互換性は実装前に詰める。

Project ID の UUID 形式とサーバー発行、リポジトリを GitHub App がアクセス可能な候補から選ぶ方式は維持する。変更リクエストの権限は [アカウント所有の判断](PDR-20261116-project-account-ownership.md) に合わせて設計する。

Project ID の重複禁止、稼働する Project の最大数 100、通信許可の既定 false、Run の上限時間の既定 30 分と許容範囲 1〜30 分は従来方針を維持する。作成上限を今後変更するかは一覧 API の検討で別途決める。

通信許可を変更する際に任意の宛先への通信と非公開ソースの外部送信が可能になることを表示する従来方針は維持する。設定の変更で既存 Run の実行設定や期限を書き換えない。Agent の選択方式はこの判断の対象外とする。

## 未決事項

- 名前の検証規則は [名前の入力規則](PDR-20261116-project-name-validation.md) で採択済み。移行元の repository 値が名前の長さ制限を超える場合も、[移行方針](PDR-20261116-project-owner-assignment.md) に従ってそのまま保持する。
- 作成・編集・旧形式インポートの入力契約と、名前の変更履歴。
- 名前を設定 JSON と別に保存する際の型・保存処理・履歴の整合方法。
- 同一アカウントが同じリポジトリの Project を複数持てるか。
