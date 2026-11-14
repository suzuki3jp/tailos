---
schema: 1
id: PDR-20261114-project-change-history
key: project.configuration.change-history
status: accepted
date: "2026-11-14"
areas: [projects, audit, web]
keywords: [変更履歴, 監査, 変更者, D1]
paths: ["apps/api/src/infrastructure/d1/**", "apps/web/src/_pages/projects/**"]
symbols: [getOperatorSession]
supersedes: []
decided_by: suzuki3jp
---

# Project の変更者と変更前後の設定を D1 に残す

## 決定

追加・変更・削除・初回インポートについて、操作の種類、対象 Project ID、運用者の内部 ID、サーバーで確定した時刻、変更前後の設定を D1 に記録する。設定画面から運用者が履歴を閲覧できるようにする。

## 理由

Project 設定は起動を許す人と Agent の通信許可を決める。最終更新日時だけでは、誰がどの権限を変えたかを追えない。設定の更新と履歴を同じトランザクションで保存すると、履歴が欠けた変更を防げる。

## 範囲と例外

履歴の書き込みに失敗した場合は設定の変更も確定しない。履歴は通常の設定操作から編集・削除できず、Project を削除しても保持する。初版では自動削除と保存期間による打ち切りを設けない。

設定値だけを保存し、Cookie・トークン・秘密鍵は履歴に含めない。DB 管理者による改変に耐える外部監査ログや履歴からの自動復元は今回の対象外とする。

## 選択肢と影響

最終更新者だけの記録は小さく済むが変更内容を追えない。全履歴の保持には、設定内の GitHub ログインを含む値が変更後も残ることと、保存量が増えるという負担がある。
