---
schema: 1
id: PDR-20261116-web-icons
key: web.design-system.icons
status: superseded
date: "2026-11-16"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [Tabler, アイコン, icons, Lucide, shadcn]
paths:
  - apps/web/components.json
  - apps/web/package.json
  - apps/web/src/shared/ui/**
  - apps/web/src/_pages/**
supersedes: []
---

# Web の汎用アイコンを Tabler Icons に統一する

## 決定

Tailos Web の汎用アイコンには Tabler Icons を使う。React 実装は `@tabler/icons-react` の必要なアイコンを名前付きで import し、shadcn の生成設定も `tabler` にする。Lucide の実装と直接依存は取り除く。

## 理由

デザインのアイコン体系は Tabler Icons である。同じライブラリでホームと共通部品を揃えると、線や形の不統一と、書き出した汎用アイコンの重複管理を減らせる。

## 範囲と例外

新しいホーム、shadcn の共通部品、今後変更する既存画面に適用する。ロゴ、アバターなどの固有画像と、未読マークや区切り線などの装飾はアイコンライブラリへの置き換え対象に含めない。Figma は引き続き読み取り専用で扱う。
