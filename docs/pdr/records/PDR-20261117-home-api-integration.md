---
schema: 1
id: PDR-20261117-home-api-integration
key: web.home.design-preview
status: superseded
date: "2026-11-17"
decided_by: suzuki3jp
areas: [web, projects, sessions]
keywords: [ホーム, API, 一覧, Project, Session, ページング]
paths:
  - apps/web/src/_pages/home/**
  - apps/web/src/app/page.tsx
supersedes: [PDR-20261116-home-design-preview]
---

# ホームの Project と Session 一覧を実データに接続する

## 決定

ホームの固定 Project・Session を、認証情報を含める既存の API クライアントから取得した `GET /api/projects` と `GET /api/sessions` のデータに置き換える。プロジェクト一覧は [概要一覧の契約](PDR-20261116-project-account-list.md)、セッション一覧は [会話一覧の契約](PDR-20261116-session-list-contract.md) に従う。

Project 選択には ID と自由な名前を使い、候補には repository も表示する。左上と入力欄の選択は連動し、一覧の先頭を初期選択にする。選択は画面内の状態とし、再読み込み後には保持しない。候補がなくなった場合は現在の一覧の先頭、空一覧なら未選択として扱う。

セッションは API の順序で表示し、選択すると既存の `/sessions/:id` へ移動する。起動元の repository・Issue 番号・リンク、更新日時、最新 Run の状態を API から表示する。未読情報は返らないため未読マークを推測で表示しない。固定ユーザー名・サンプルアバターも実ユーザーとして表示しない。

## 理由

一覧 API が利用可能になったため、デザイン確認用のサンプルを実際の開発対象・会話へ置き換えられる。2か所の選択を共有し、先頭を初期値にすれば、同じホームで異なる開発対象を選んだように見える状態と、毎回の選び直しを避けられる。API が持たない本人情報や未読情報を作らず、実データとサンプルを混同させない。

## 範囲と例外

`/` と既存の `/?error=...` のログイン失敗表示、管理画面の URL は維持する。セッション一覧はアカウント全体であり、Project 選択による絞り込みは行わない。Figma は引き続き読み取り専用で扱う。

Project は既定のページサイズで後続カーソルも取得して選択候補を揃える。Session は先頭ページを表示し、利用者の「Load more sessions」で後続ページを追加する。ページ間に同じ ID が再出現した場合は表示を重複させない。空一覧では空状態、取得中は読み込み状態、未認証は既存のログイン導線、その他の取得失敗は既存の再試行表示を使う。自動再試行と定期ポーリングは追加せず、既存 QueryClient の再取得の挙動を使う。

入力から Session・Run を作る API の接続と Insights は対象外。入力内容は保持し、送信操作では未接続であることを明示する。CSP と共通デザイン基盤は既存方針を維持する。
