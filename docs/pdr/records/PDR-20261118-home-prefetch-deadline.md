---
schema: 1
id: PDR-20261118-home-prefetch-deadline
key: web.home.design-preview
status: accepted
date: "2026-11-18"
decided_by: suzuki3jp
areas: [web, projects, sessions]
keywords: [ホーム, SSR, prefetch, hydration, timeout, タイムアウト, 10秒, AbortSignal]
paths:
  - apps/web/src/_pages/home/**
  - apps/web/src/app/**
  - apps/web/src/shared/api/**
supersedes: [PDR-20261117-home-server-prefetch]
---

# ホームの初期取得に全体10秒の期限を設ける

## 決定

ホームの Projects と Sessions は、リクエスト単位の QueryClient でサーバーから並列に prefetch する。初期取得の開始から全体で 10,000ms の期限を設け、期限に達したら未完了の API リクエストを中断する。Projects の全ページと Sessions の先頭ページで同じ期限を共有し、ページごとに延長しない。

完了したクエリの結果は保持し、中断されたクエリは失敗状態として hydrate する。既存の再試行 UI を表示し、空一覧や成功状態には置き換えない。初期表示用の client-side fetch、Skeleton、hydrate 直後の重複取得と自動再試行は追加しない。

ホームの外枠と見出しは Server Component のままにする。Client 境界は Project 選択の共有 state、入力、モバイルメニュー、追加取得・再試行などの対話部分に限定する。Project の選択は左上と入力欄で連動し、先頭を初期値にする。Session はアカウント全体の更新順で表示し、後続ページは利用者の操作で取得する。

## 理由

Project は選択と入力の前提であり、並列 prefetch で有用な初期状態を揃える方針は維持する。一方で API が応答しないと、取得完了を待つホーム全体が返らず、利用者が再試行することもできない。全体の期限でこの無期限待ちを防ぐ。

10秒は通常の応答時間の実測値ではなく、障害時に再試行可能な画面へ戻すための待ち時間の上限として選ぶ。既に取得できた一覧を残すことで、一方の API の失敗で両方の結果を失わない。

## 範囲と例外

期限はホームのサーバー側初期取得に適用する。ブラウザでの手動再試行、追加ページ取得、フォーカス復帰時の再取得には、このリクエストの期限を引き継がない。Loading の表示遅延や最低表示時間、全画面共通の fetch 上限としては使わない。

Projects の全選択候補が揃う前に期限に達した場合、部分的な候補を成功扱いしない。既存の全件取得・失敗時の契約を保ち、ページ数による切り捨ては追加しない。カーソルの循環は不正なページングとして失敗させる。

認証 Cookie は [共有方針](PDR-20261117-login-cookie-scope.md) に従って API に渡す。期限とクエリのキャンセルのどちらでも通信を中断できるようにし、初期取得終了時にタイマーと QueryClient を破棄する。Cookie、内部エラーの詳細、サーバー専用の取得処理は dehydrated state に含めない。

初期値の再読み込み後の保存、Project による Session の絞り込み、入力からの実行開始、Insights は追加しない。Figma は読み取り専用で扱う。

## 選択肢と影響

無期限待ちは障害時の復帰経路を失うため採用しない。ページごとの期限はページ数に応じてホーム全体の待ち時間が伸びるため採用しない。正常でも全候補の取得に10秒以上かかる場合は失敗表示になるため、その場合は実測した取得時間と依存関係を基に取得方法や待ち状態の境界を再検討する。
