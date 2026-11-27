---
schema: 1
id: PDR-20261127-home-centered-layout
key: web.navigation.page-shell
status: accepted
date: "2026-11-27"
decided_by: suzuki3jp
areas: [web, api, design-system]
keywords: [ホーム, 中央揃え, サイドバー, 右側 Slot, Page, 本人情報, プロフィール, アバター, GitHub]
paths:
  - apps/web/src/**
  - apps/api/src/bootstrap/http.ts
  - apps/api/src/presentation/http/handlers/account/**
  - apps/api/src/infrastructure/d1/account.ts
supersedes: [PDR-20261125-shared-page-shell]
---

# ホームの本文を左サイドバーの右に広がる領域の中央に配置する

## 決定

Figma のホームに合わせ、左サイドバーを除いた領域の中央にホームの本文を配置する。ホームの右側に Slot 用の幅を確保しない。既存の管理画面では広い画面で右側に240pxの Slot を確保する。中央配置の本文は最大640px、本文の左右余白は各24pxとする。ホームの本文上余白はデスクトップで72px、共通 Page の基本は48pxとする。

ホーム・Project の Session 詳細・既存の管理画面で外枠とサイドバーを共有する。デスクトップのナビゲーションはサイドバーに配置し、サイドバー下部に本人のアバター・名前・メールを表示する。サイドバーは幅240px、上部60px、ナビ項目36px、アイコンと文字の間隔12px、ナビグループ間24pxとする。

認証済み本人だけが取得できるプロフィール API は、保存済みユーザーの名前・メール・画像を必要な項目だけ返す。ホームの呼びかけにも同じ本人情報を使う。未認証時はログイン導線、取得失敗時は本人情報の失敗表示と再試行を使い、プロフィールが取得できなくても画面の操作を妨げない。取得はサーバー側 prefetch と共有 query cache に接続する。

CSP の外部画像許可先は HTTPS の avatars.githubusercontent.com とする。アバターがない場合や読み込めない場合は汎用アカウントアイコンを使う。

## 理由

ホームの右側に空の Slot を確保すると、広い画面で本文が表示領域の中央から左にずれる。空の Slot を取り除くことで、入力欄と Recent Sessions の左右の余白が揃う。

外枠とナビを共有することで画面間の寸法・本人表示・操作を揃え、本文や右側 Slot、Project の表示・選択は画面ごとに合成できる。本人情報を認証済み API から取得することでサンプルと実ユーザーの混同を防ぎ、アバター配信元だけの許可で画像の読み込み元を制限できる。

## 範囲と例外

中央揃えの変更はホームに適用する。共通の外枠は引き続きホーム、Project 付きの Session 詳細、設定・接続・アカウントと従来 Session 詳細に適用する。ルート、既存の業務操作、Project の選択・一覧取得、Session の会話と右側パネルの契約を引き継ぐ。Insights の機能、Session 一覧の絞り込み、Project 選択の永続化は対象外とする。

モバイルでは既存の Sheet によるナビとログイン導線を使う。本人情報はホームの初期取得と同じ期限で並列取得する。管理画面の共通ナビに必要な Projects と本人情報も同じ prefetch 処理を使う。Figma は読み取り専用とする。
