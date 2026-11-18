---
schema: 1
id: PDR-20261117-home-server-prefetch
key: web.home.design-preview
status: superseded
date: "2026-11-17"
decided_by: suzuki3jp
areas: [web, projects, sessions]
keywords: [ホーム, SSR, prefetch, hydration, Loading, Server Component]
paths:
  - apps/web/src/_pages/home/**
  - apps/web/src/app/**
  - apps/web/src/shared/api/**
supersedes: [PDR-20261117-home-api-integration]
---

# ホームの初期データをサーバーで並列取得する

## 決定

ホームの Project と Session は、リクエスト単位の QueryClient でサーバー側から並列に prefetch し、取得を待ってから描画する。TanStack Query の dehydration / hydration で結果を引き継ぎ、初期表示のための client-side fetch と Skeleton は置かない。hydrate 直後の重複取得と失敗時の自動再試行も行わない。

ホームの大きなコンテナ、見出し、ナビゲーションなどは Server Component にする。Client 境界は Project 選択の共有 state、入力、モバイルメニュー、追加取得・再試行など、対話が必要な部分に限定する。親の Client モジュールから画面全体を import し直す構成にはしない。

Project 選択は左上と入力欄で連動し、API の先頭を初期値にする。セッションはアカウント全体の更新順で、追加ページを利用者の操作で取得する。前の判断の一覧・選択・入力の範囲は維持する。

## 理由

Project は選択と入力の前提で、初期取得も独立した一覧 API である。操作できないホームの殻を先に描いて Loading に切り替えるより、サーバーで有用な初期状態を揃える。両方の取得を並列に開始すると不要な waterfall を避けられる。選択・入力・追加読み込みは対話のため Client に残す必要があるが、画面全体の Client 化は不要である。

## 範囲と例外

取得失敗もサーバーで確定し、機密を含まない状態で既存のログイン・再試行 UI に渡す。認証 Cookie は [共有方針](PDR-20261117-login-cookie-scope.md) に従って API に引き継ぐ。認証情報は dehydrated state に含めず、利用者ごとにキャッシュを分離する。

Project の全選択候補と Session の先頭ページを初期取得する。追加読み込みと再試行中の局所的な状態表示、フォーカス復帰時の再取得は維持する。初期取得が実際には遅い場合は、取得時間と依存関係を根拠に server-side の Suspense / loading.tsx の導入を再検討する。一律の時間閾値は設けない。

初期値の再読み込み後の保存、Project による Session の絞り込み、入力からの実行開始、Insights は追加しない。Figma は読み取り専用で扱う。
