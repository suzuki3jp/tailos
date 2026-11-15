---
schema: 1
id: PDR-20261116-project-webhook-fanout
key: project.webhook.repository-fanout
status: accepted
date: "2026-11-16"
areas: [projects, triggers, github]
keywords: [Webhook, 配信, 複数Project, リポジトリ重複, fanout, 冪等性]
paths:
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/api/src/application/triggers/**
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/trigger-admission.ts
  - apps/api/src/infrastructure/d1/planning.ts
  - apps/api/src/infrastructure/d1/schema.ts
symbols: [createGithubWebhook, admitTrigger, acceptPlanningInput]
supersedes: []
decided_by: suzuki3jp
---

# 同じリポジトリの複数 Project に Webhook を配信する

## 決定

同じリポジトリに対して、異なるアカウントがそれぞれ独立した Project を作れる。リポジトリをデプロイ全体で一つの Project に限定しない。

Webhook は対象リポジトリの各 Project について受付条件を判定する。署名検証を維持し、各 Project の installation、ラベル、許可ユーザーなどの条件を満たす場合に、それぞれ独立して処理する。

同じイベントが複数 Project の条件を満たした場合、複数の Project で Agent が動いてよい。同じ Issue に複数の PR やコメントが作成されることも、意図した挙動として許容する。

## 理由

同じリポジトリを開発する人同士でも、各自の設定や会話を持つ独立した Project を利用できるようにする。Webhook の配信先を一つに限定しなければ、リポジトリの共有を理由に Project の共有まで強制せずに済む。

各 Project が自身の起動条件を判定することで、ラベルや許可ユーザーを分けた利用も、同じイベントから複数の独立した開発を開始する利用も可能にする。

## 範囲と例外

実装ラベルと計画コメントの Webhook の双方を対象にする。削除済み Project を新規起動の対象にしない既存方針を維持する。

この判断は実装済みを示さない。現在のコードにはリポジトリの一意制約、最初の一件だけを選ぶ受付、配信 ID 単位の重複防止があり、複数 Project で独立して処理できるように変更する必要がある。

複数 Project の起動を許容することは、同じ Project で Webhook の再送による重複起動を許容することではない。

## 選択肢と影響

リポジトリごとに一つの Project を共有する案では、Webhook の配信先と実行数を限定できる一方、各人が独立した Project を持てない。採用する方式では、条件が重なった Project の数に応じて実行や GitHub への投稿が増える。

## 未決事項

- 同一アカウントが同じリポジトリの Project を複数持つことも許可するか。
- 一部の Project だけ受付に失敗した場合のレスポンス、再試行、回復方法。
- 各 Project の実行に使う接続・資格情報の選択と、利用できない場合の扱い。
- Project ごとの重複防止、同時実行制御、診断と配信結果のデータ構造。
