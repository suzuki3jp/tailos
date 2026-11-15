---
schema: 1
id: PDR-20261116-project-owner-assignment
key: project.ownership.assignment
status: accepted
date: "2026-11-16"
areas: [projects, auth, deployment]
keywords: [owner_id, 内部ユーザーID, 既存Project, 所有者移行, 実装範囲]
paths:
  - apps/api/src/application/projects/**
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/schema.ts
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/scripts/deploy.mjs
  - apps/api/migrations/**
symbols: [ProjectStore, d1Projects, createProjectRoutes]
supersedes: []
decided_by: suzuki3jp
---

# Project の所有者を内部ユーザー ID で保存し既存分を現運用者へ割り当てる

## 決定

`projects.owner_id` に Tailos 内部のユーザー ID を保存する。新規作成では認証結果のユーザーを所有者にする。既存 Project は現在設定されている GitHub 運用者に対応する内部ユーザーへ割り当てる。旧形式の初回インポートでは、操作したユーザーを所有者にする。

今回の実装は、名前・所有者の追加と移行、アカウント向け一覧 API、既存の設定取得・編集処理への対応を対象とする。一覧以外の設定取得、編集、削除、変更履歴取得も所有者に限定する。

Webhook の複数配信、whitelist、メンバー参加は後続の実装にする。同じリポジトリの Project を複数作れるようにする制約変更は、Webhook の複数配信と一緒に有効にする。

## 理由

内部ユーザー ID は既存の Session や接続でも使われており、GitHub の表示名から独立して所有者を識別できる。認証結果から所有者を確定すれば、呼び出し元が別のユーザーを所有者に指定することを防げる。

既存 Project はデプロイ全体の共有設定であり、現在ログインできるのは設定された運用者一人である。この運用者へ移行することで、現在の開発対象を継続して管理できる。

一覧 API は所有情報と表示名があれば実装できる。一方で同じリポジトリの重複登録だけを先に許可すると、現在の Webhook が最初の一件しか処理しない問題が生じるため、制約の緩和は受付側の対応と揃える。

## 範囲と例外

所有者の移行では更新者 `updated_by` を所有者と見なさず、設定された GitHub 運用者のアカウント対応から決める。削除済み Project も対象にし、保持した設定履歴の閲覧権限を決める。Session・Run・接続の所有者は移し替えない。

デプロイでは SQL migration の後、まだ所有者がない行だけを現在の運用者に割り当てる。運用者を設定し直して再デプロイしても、既に割り当てた所有者は変更しない。対応する内部ユーザーがない場合は所有者を推測せず、未割り当てが残っていれば Worker の公開前に停止する。既存のデプロイで現在の運用者がログインしてユーザーを作成してから、再度デプロイする。

今回の名前と所有者の補完では、既存の UUID、版、更新時刻、過去の変更履歴を保持する。既存の repository 値が 100 文字を超えていても切り詰めず、そのまま初期名として残す。新規作成や名前を変更して保存する際は採択済みの名前の入力規則に従う。

Webhook の配送先と実行者の選択は今回変更しない。複数人ログインと同じリポジトリの重複登録をまだ有効にしない範囲で、従来の単一運用者による実行を維持する。
