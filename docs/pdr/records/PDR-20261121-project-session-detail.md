---
schema: 1
id: PDR-20261121-project-session-detail
key: web.project.session-detail
status: superseded
date: "2026-11-21"
decided_by: suzuki3jp
areas: [web, sessions, diagnostics]
keywords: [セッション詳細, 実行ログ, 会話, 平文, model, effort, 入力欄]
paths:
  - apps/web/src/_pages/session-detail/**
  - apps/web/src/app/**/sessions/**
  - apps/web/src/features/compose-loop/**
  - apps/api/src/presentation/http/handlers/sessions/**
supersedes: []
---

# Project のセッション画面で保存済みの会話と Agent の実行ログを読む

## 決定

`/{projectId}/sessions/{sessionId}` に、Figma のセッション画面に沿った会話と同じ Project のセッション一覧を表示する。保存済みのメッセージは改行を保った平文で表示する。Project 付きの詳細は、セッション所有者と保存済み Project ID の両方が一致するときに表示する。

会話内の実行時間を展開すると、既存の診断に保存されたコマンド、その出力、ツールの結果、Agent メッセージを確認できる。展開時に矢印を下向きに回転させる。実行時間は保存済みの Agent 実測値を使う。実行時間の記録がなくてもログを開ける。

ホームとセッションで入力欄を共用し、Project ピッカーはホームで表示する。モデルと effort は入力欄で選択できる。セッションの入力欄からメッセージは送信できない。

## 理由

会話と実行の根拠を同じ場所で確認できるようにする。ログを折りたたんでおけば、会話だけを読みたいときも追いやすい。保存済みの診断を使うことで、既存の認証、マスキング、保存期限が適用される。入力欄を共用すると、会話を開始する画面と既存セッションの間で操作が揃い、既存セッションで異なる Project を指定する余地がなくなる。

## 範囲と例外

会話の Markdown レンダリング、未収集の思考ログなどの追加保存、入力内容の送信と実行は対象外とする。閲覧には既存の認証を使い、削除済み Project の会話も所有者が閲覧できる。Project を持たない会話は従来の詳細 URL から開ける。ホームのセッション一覧は引き続きアカウント全体を扱う。
