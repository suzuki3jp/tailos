---
schema: 1
id: PDR-20261116-project-account-ownership
key: project.configuration.ownership
status: accepted
date: "2026-11-16"
areas: [projects, auth]
keywords: [Project, アカウント, 所有者, 複数リポジトリ, メンバー, whitelist]
paths:
  - apps/api/src/application/projects/**
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/schema.ts
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/src/infrastructure/auth/**
symbols: [ProjectStore, d1Projects, createProjectRoutes]
supersedes: [PDR-20261114-project-ownership]
decided_by: suzuki3jp
---

# Project をアカウントの所有にする

## 決定

Project はデプロイ全体の共有設定から、アカウントが所有する単位に変える。一人の開発者が複数のアプリを Tailos 上で開発できるように、アカウントはリポジトリごとに複数の Project を持てる。今回のアカウント向け Project 一覧は、自分が所有する Project を対象とする。

将来は Project にメンバーとして参加できる形へ拡張する方向とする。ただし、今回メンバー招待やロールの仕様は確定しない。

## 理由

一人の開発者が扱うアプリは一つとは限らない。開発対象ごとに Project を持ち、その一覧を自分のアカウントから取得できれば、複数の開発を Tailos 上で管理できる。

デプロイ全体の共有設定では、将来ログインできる人が増えた際に各人の開発対象を分離できない。まず所有者を明確にし、その後にメンバー参加を追加することで、個人利用から共同開発へ広げる。

## 範囲と例外

これは仕様の採択であり、実装済みを示さない。既存 Project は現在のコードでは共有設定であり、既存データの所有者の割り当ては [所有者の割り当て方針](PDR-20261116-project-owner-assignment.md) で採択済みである。

ログインを将来 whitelist 形式にする方向性はあるが、今回の一覧 API の検討だけではログイン可能な人を増やさない。whitelist の保存場所、追加・削除の方法、許可取消時の扱いは未決とする。

既存の認証と変更リクエストの Origin 検査を、この判断を理由に取り除かない。Session・Run・接続の所有権移転、MCP や Agent による Project 設定変更の追加は含めない。

## 未決事項

- メンバー参加、ロール、所有権移転、退会の仕様。
