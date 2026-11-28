---
schema: 1
id: PDR-20261116-web-prototype-styles
key: web.design-system.prototype-migration
status: superseded
date: "2026-11-16"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [プロトタイプ, prototype, 既存画面, スタイル, フォント, アイコン]
paths:
  - apps/web/src/app/**
  - apps/web/src/_pages/**
  - apps/web/src/shared/styles/**
  - apps/web/src/shared/ui/**
supersedes: []
---

# デザイン導入で既存プロトタイプの見た目の変更を許容する

## 決定

既存の Web 画面はプロトタイプとして扱い、Tailos のデザインシステム導入によるスタイル、フォント、アイコンの変更を許容する。以前の見た目の維持を、共通トークンや部品の適用条件にしない。

## 理由

既存画面の見た目は完成した仕様ではない。旧スタイルへの互換性よりも、これから作るデザインと共通基盤に揃えることを優先できる。

## 範囲と例外

ホーム以外の設定、接続、アカウント、Session 詳細を含む Web の表示に適用する。旧 CSS の互換名や layout は必要に応じて段階的に整理できる。この判断だけで認証、API、保存データの契約を変更しない。[ホームのプレビュー方針](PDR-20261116-home-design-preview.md) は引き続き適用する。
