---
schema: 1
id: PDR-20261116-home-design-preview
key: web.home.design-preview
status: accepted
date: "2026-11-16"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [ホーム, Figma, shadcn, トークン, モック, プレビュー]
paths:
  - apps/web/components.json
  - apps/web/src/app/**
  - apps/web/src/_pages/home/**
  - apps/web/src/shared/ui/**
  - apps/web/src/shared/styles/**
symbols: [HomePage, homePreview]
supersedes: []
---

# Figma に合わせたホームをモックデータで先に実装する

## 決定

shadcn を導入し、Tailos の Figma の Home と Design Systems を基に、共通のデザイントークンとホームの見た目を実装する。Figma は読み取り専用とし、ノード・コンポーネント・変数を変更しない。

ホームはサンプルのユーザー・Project・Session を表示するプレビューとする。入力や選択を画面内で確認できるが、送信しても Session・Run・GitHub Issue・PR を作らない。サンプルの Session ID を実在する Session の API に渡さない。

## 理由

デザイン基盤と画面の見た目を先に確認すると、バックエンドの新しい起動経路や一覧契約に依存せず、色・文字・余白・共通部品を揃えられる。実行されたように見せるとプレビューと実際の処理を混同するため、操作時には実行されないことを示す。

## 範囲と例外

ホームのプレビューを `/` に配置する。既存のアカウント画面は `/login` から引き続き利用でき、`/?error=...` のログイン失敗表示も維持する。設定・接続・既存の Session 詳細の URL、認証、API の契約は変更しない。

Figma のデスクトップ画面を見た目の基準とし、狭い画面でも入力とナビゲーションを利用できるようにする。API 接続、永続的な Project 選択、未読判定、セッション一覧の並び順、入力からの計画・実装開始、Insights の機能は今回確定しない。プレビューの表示値や操作を、それらのプロダクト仕様として扱わない。

Web の style 属性と UI ライブラリの SSR には、[CSP の style 属性方針](PDR-20261116-csp-style-attributes.md) を適用する。
