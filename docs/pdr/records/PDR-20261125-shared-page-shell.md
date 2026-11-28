---
schema: 1
id: PDR-20261125-shared-page-shell
key: web.navigation.page-shell
status: superseded
date: "2026-11-25"
decided_by: suzuki3jp
areas: [web, api, design-system]
keywords: [サイドバー, ヘッダー, Page, 本人情報, プロフィール, アバター, GitHub]
paths:
  - apps/web/src/**
  - apps/api/src/bootstrap/http.ts
  - apps/api/src/presentation/http/handlers/account/**
  - apps/api/src/infrastructure/d1/account.ts
supersedes: []
---

# Page の外枠とサイドバーを共有し、認証済みの本人情報を表示する

## 決定

Figma の共通 Page に合わせ、ホーム・Project の Session 詳細・既存の管理画面で外枠とサイドバーを共有する。デスクトップの上部ヘッダーは取り除き、サイドバー下部に本人のアバター・名前・メールを表示する。サイドバーは幅240px、上部60px、ナビ項目36px、アイコンと文字の間隔12px、ナビグループ間24pxとする。中央配置の画面では右側に240pxの Slot を確保し、本文幅640pxと左右24pxの余白を使う。ホームの本文上余白は72px、共通 Page の基本は48pxとする。

認証済み本人だけが取得できるプロフィール API を追加し、保存済みユーザーの名前・メール・画像を必要な項目だけ返す。ホームの呼びかけにも同じ本人情報を使う。固定の名前やサンプル画像を本人として扱わない。未認証時はログイン導線、取得失敗時は本人情報の失敗表示と再試行を使い、プロフィールが取得できなくても画面の操作を妨げない。取得は既存のサーバー側 prefetch と共有 query cache に接続する。

CSP の画像許可先に HTTPS の avatars.githubusercontent.com を追加する。GitHub アバターを直接表示し、他の外部画像配信元は許可しない。アバターがない場合や読み込めない場合は汎用アカウントアイコンを使う。

## 理由

画面ごとに外枠とナビを複製すると寸法・本人表示・操作の修正がずれる。共通 Page に対応する部品を共有し、画面固有の本文や右側 Slot、Project の表示・選択は合成できるようにする。本人情報を認証済み API から取得することでサンプルと実ユーザーの混同を防ぎ、アバター配信元だけの許可で既存の画像制限を保つ。

## 範囲と例外

ホーム、Project 付きの Session 詳細、設定・接続・アカウントと従来 Session 詳細の外枠に適用する。ルートと既存の業務操作を維持する。Insights の機能、Session 一覧の絞り込み、Project 選択の永続化は追加しない。Project の選択・一覧取得や Session の会話と右側パネルは既存の契約を維持する。

モバイルの専用デザインは未確定であり、既存 Sheet によるナビとログイン導線を使えるようにする。既存のホーム初期取得の期限と失敗時の契約は維持し、本人情報もその並列取得と同じ期限に含める。管理画面の共通ナビに必要な Projects と本人情報も同じ prefetch 処理を使い、障害時に共通ナビの待ちだけで画面が無期限に停止しないようにする。API が本人情報を持たない間に汎用アイコンを使う従来の表示を、本人情報が得られた場合の実データ表示へ更新する。Figma は読み取り専用とする。
