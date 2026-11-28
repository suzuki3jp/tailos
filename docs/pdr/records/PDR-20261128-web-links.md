---
schema: 1
id: PDR-20261128-web-links
key: web.navigation.links
status: accepted
date: "2026-11-28"
areas: [web, design-system]
decided_by: suzuki3jp
keywords: [next/link, a, アンカー, スキップリンク, フォーカス, lint]
paths: [apps/web/src/**, lint/web-boundaries.mjs, docs/design-system/README.md]
---

# Web のリンクを next/link に統一する

## 決定

Web の画面内リンクと外部 URL へのリンクには `next/link` の `Link` を使う。Oxlint は `apps/web/src` の JSX に直接書かれた `<a>` を検出し、`Link` の使用を案内する。

## 理由

ページ間の移動にフレームワークのクライアント側ナビゲーションを使い、リンクの実装を統一する。外部 URL は `Link` を通してブラウザー標準の遷移で開ける。ページシェルのスキップリンクには、スクロールに加えて本文へキーボードフォーカスを移すブラウザー標準のフラグメント遷移が必要になる。

## 範囲と例外

検査対象には Design Systems と Web のテストを含む。ページシェルの `#page-content` へのスキップリンクは生の `<a>` を使い、その箇所に限って理由付きで lint を抑制する。本文には `tabIndex={-1}` を付け、スキップリンクの起動時にフォーカスできるようにする。
