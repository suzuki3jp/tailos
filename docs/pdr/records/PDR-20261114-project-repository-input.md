---
schema: 1
id: PDR-20261114-project-repository-input
key: project.configuration.repository-input
status: accepted
date: "2026-11-14"
areas: [projects, github, web]
keywords: [repositoryId, installationId, GitHub App, リポジトリ指定, select, 選択]
paths: ["apps/api/src/infrastructure/github/**", "apps/web/src/_pages/projects/**"]
symbols: [projectsSchema]
supersedes: []
decided_by: suzuki3jp
---

# GitHub App がアクセスできるリポジトリを select で選ぶ

## 決定

Project のリポジトリは、設定された GitHub App の installation とアクセス可能なリポジトリから取得した候補を select で選ぶ。Web では `repository`、`repositoryId`、`installationId` を手入力させず、選択結果から確定する。

API は保存時にも、その GitHub App と対象 installation からアクセス可能なリポジトリであることと、名前・ID の一致を確認する。ブラウザから送られた ID や表示済み候補だけを信頼しない。

## 理由

リポジトリ名と複数の数値 ID を調べて入力する負担をなくし、名前・ID・installation の組み合わせの誤りを防ぐ。GitHub App が実際にアクセスできる候補を提示することで、登録できる対象を運用者が判断しやすくする。

## 範囲と例外

候補の取得と設定の保存は既存の運用者認証の内側で行い、変更には Web の Origin 検査を適用する。GitHub 側の一覧をページングし、一ページ目以外の対象も選択できるようにする。

一覧を取得できない場合はエラーと再試行を示す。候補がない場合はその状態を表示し、手入力に切り替えない。保存時に GitHub の一時障害を含め整合性を確認できない場合は保存せず、入力を保持してエラーを表示する。

既存 JSON の初回インポートは UI の select を経由しないが、同じサーバー側の照合を適用する。起動時の署名・リポジトリ名・ID・installation の照合は維持する。GitHub App の秘密鍵や installation token はブラウザに渡さない。

## 選択肢と影響

手入力は一覧取得の実装を減らせるが、運用者に ID の調査と整合性の判断を求める。select 方式では一覧取得とページングが必要になり、GitHub が利用できないと新しい対象を選択・保存できない。
