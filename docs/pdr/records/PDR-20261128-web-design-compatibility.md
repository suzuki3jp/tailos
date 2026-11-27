---
schema: 1
id: PDR-20261128-web-design-compatibility
key: web.design-system.prototype-migration
status: accepted
date: "2026-11-28"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [プロトタイプ, prototype, 既存画面, スタイル, フォント, アイコン]
paths:
  - apps/web/src/app/**
  - apps/web/src/_pages/**
  - apps/web/src/shared/styles/**
  - apps/web/src/shared/ui/**
supersedes: [PDR-20261116-web-prototype-styles]
---

# ホームと Session のデザインを保ち、旧管理画面に共通スタイルを適用する

## 決定

ホームと Session の画面は現在の Tailos のデザインを基準とし、共通部品に移行するときも既存の画面構成、配色、余白、コントロールの見た目を保つ。設定、接続、アカウント、Diagnostics などの旧管理画面には、現行の共通部品の見た目を適用できる。

## 理由

ホームと Session は利用者が日常的に使う画面であり、Tailos のデザイン参照に合わせて整えてきた。共通部品への移行に見た目の変更を混ぜると、既に確定したデザインの差分を確認しづらくなる。旧管理画面の見た目は移行途中であり、フォームの見た目を揃えるために個別の旧 CSS を維持する必要はない。

## 範囲と例外

ホームと Session が共有するページ枠やナビゲーションにも現状維持を適用する。旧管理画面で見た目を揃える場合も、入力制約、認証、API、保存した設定の意味は各機能の契約に従う。
