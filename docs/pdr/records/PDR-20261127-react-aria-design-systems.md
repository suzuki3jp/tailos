---
schema: 1
id: PDR-20261127-react-aria-design-systems
key: web.design-system.primitives
status: superseded
date: "2026-11-27"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [React Aria, CVA, shadcn, Base UI, headless, 共通 UI, lint]
paths:
  - apps/web/src/shared/ui/design-systems/**
  - apps/web/package.json
  - lint/web-boundaries.mjs
---

# React Aria と CVA で Tailos の共通 UI を定義する

## 決定

shadcn と Base UI から React Aria Components に移行する。Tailos の共通 UI は `apps/web/src/shared/ui/design-systems` に定義し、呼び出し元には `@/shared/ui/design-systems` の公開 API を提供する。共通部品のサイズや見た目のバリエーションには CVA と既存のデザイントークンを使う。React Aria の直接 import は Design Systems ディレクトリ内に限定し、Oxlint で検査する。

## 理由

フォーカス管理、キーボード操作、支援技術向けの振る舞いを React Aria に任せ、Tailos 固有の見た目と部品の API は共通 UI に集約する。画面ごとにライブラリの部品を組み立てると、同種の操作でも表示や状態の扱いがずれやすい。CVA でバリエーションを揃え、共通部品の実装を利用側から独立して更新できるようにする。

## 範囲と例外

既存の Button、Select、Input、Textarea、Dialog、Sheet、Avatar と、これらを使う共通 UI に適用する。Avatar は画像とフォールバックを組み合わせる。禁止する HTML タグの一覧は、既存の使用箇所を確認した後に決める。既存画面の選択肢、初期値、送信、認証、取得条件は各機能の判断に従う。
