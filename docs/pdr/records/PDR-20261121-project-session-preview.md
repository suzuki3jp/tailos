---
schema: 1
id: PDR-20261121-project-session-preview
key: web.project.session-detail
status: superseded
date: "2026-11-21"
decided_by: suzuki3jp
areas: [web, sessions, diagnostics]
keywords: [セッション詳細, 実行時間, 実行ログ, 平文, model, effort, 入力欄]
paths:
  - apps/web/src/_pages/session-detail/**
  - apps/web/src/app/**/sessions/**
  - apps/web/src/features/compose-loop/**
  - apps/api/src/presentation/http/handlers/sessions/**
supersedes: [PDR-20261121-project-session-detail]
---

# Project のセッション画面で保存済みの会話と実行時間を表示する

## 決定

`/{projectId}/sessions/{sessionId}` に会話と同じ Project のセッション一覧を表示する。保存済みのメッセージは改行を保った平文で表示する。セッション所有者と保存済みの Project ID が両方一致するときに詳細を表示する。

会話内の `Worked for …` は保存済みの Agent 実測値を表示する。クリックで矢印が回転する。セッション詳細から診断ログの本文や詳細を取得・展開する機能は後続の実装で扱う。

ホームとセッションで入力欄を共用し、Project ピッカーはホームで表示する。モデルと effort は入力欄で選択できる。セッションの入力欄からメッセージは送信できない。

## 理由

会話画面と実行時間を先に提供することで、ログの取得と表示を含む変更と分けて検証できる。入力欄を共用するとホームとセッションで操作が揃い、既存セッションの入力で別の Project を指定する余地がなくなる。

## 範囲と例外

会話の Markdown レンダリング、新たなログ収集、セッション詳細内の診断ログ表示、入力内容の送信と実行は対象外とする。既存の診断画面でログを調べられる。削除済み Project の会話も所有者が閲覧できる。Project を持たない会話は従来の詳細 URL から開ける。ホームのセッション一覧はアカウント全体を扱う。
