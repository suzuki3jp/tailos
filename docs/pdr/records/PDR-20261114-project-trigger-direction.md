---
schema: 1
id: PDR-20261114-project-trigger-direction
key: project.future.project-session-trigger-model
status: proposed
date: "2026-11-14"
areas: [projects, sessions, triggers, agent]
keywords: [将来構想, 複数 Project, repository, Session, trigger, Agent 選択, agent.selection]
paths: ["apps/api/src/application/triggers/**", "apps/api/src/application/sessions/**", "apps/api/src/infrastructure/d1/**", "apps/api/src/presentation/http/handlers/github-webhook/**", "apps/web/src/_pages/projects/**", "packages/core/src/runner.ts"]
symbols: [ExecutionContext, projectId, projectsSchema]
supersedes: []
---

# 複数 Project と Session の紐付け、trigger ごとの Agent 選択を検討する

## 決定

構想段階の方向性として、複数の Project を定義し、それぞれが対象 repository を持ち、Session が Project に紐付く構成を検討する。起動する Agent は Project 全体で一つに固定せず、trigger によって決める方向で検討する。

今回の Project 設定の D1 移行ではこの構想全体を実装しない。Project ID の UUID 化とリポジトリの select 方式は別途採択済みであり、今回の変更に含める。

## 理由

Project は起動設定だけでなく、対象リポジトリと作業の会話をまとめる単位として使うことを想定している。同じ Project に異なる起動経路が加われば、それぞれの目的に応じて Agent を選びたい。今回の設定保存だけを将来の関連モデルの完成形と見なすと、後続で分離する責務を固定してしまうため、未確定の方向性も検索可能な形で残す。

## 範囲と例外

この記録は `proposed` であり、複数 Project をまたぐ権限、リポジトリの共有可否、trigger のデータモデル、Agent の選択規則、Session の移動・継続・削除を確定しない。今回の実装範囲や、別途採択した所有者・編集項目・削除の判断を変更するものでもない。

GitHub 上の PDR-20261114-010 は、Project の `agent` で選び、未指定を codex とする方針を採択している。trigger に選択を移す構想は、その選択単位を変えるものになる。構想を正式に採択する段階で `agent.selection` の後継 PDR を用意し、現行方針との差分と移行方法を決める。この構想を理由に、現行の選択方針を変更したり Claude 対応の追加時期を確定したりしない。

## 選択肢と影響

Project 単位の Agent 選択は設定が少なく済む。trigger 単位の選択は同じ Project でも起動経路に応じた選択ができる一方、trigger の管理と既存 Project 設定からの移行が必要になる。

## 未決事項

- 一つの Project が持つリポジトリの数と、同じリポジトリを複数 Project で扱えるか。
- trigger の種類・識別子・Project との関係と、複数の trigger が同時に一致したときの扱い。
- Agent の未指定時の既定値、接続の割り当て、既存の Project 単位の設定からの移行方法。
- Project を持たない Session と、会話を継続して新しい Run を作る際の設定の確定方法。
