---
schema: 1
id: PDR-20261128-design-system-form-controls
key: web.design-system.primitives
status: accepted
date: "2026-11-28"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [React Aria, CVA, フォーム, 生タグ, select, button, label, option, input, textarea, lint]
paths:
  - apps/web/src/shared/ui/design-systems/**
  - apps/web/package.json
  - lint/web-boundaries.mjs
supersedes: [PDR-20261127-react-aria-design-systems]
---

# フォームの6タグを Design Systems に集約する

## 決定

shadcn と Base UI から React Aria Components に移行する。Tailos の共通 UI は `apps/web/src/shared/ui/design-systems` に定義し、呼び出し元には `@/shared/ui/design-systems` の公開 API を提供する。共通部品のサイズや見た目のバリエーションには CVA と既存のデザイントークンを使う。React Aria の直接 import は Design Systems ディレクトリ内に限定し、Oxlint で検査する。

`select`、`button`、`label`、`option`、`input`、`textarea` の生 JSX タグは、リポジトリ内の Design Systems ディレクトリ外で禁止する。個別の選択肢は Select のオプションとして定義する。チェックボックスは共通の Checkbox を使う。

## 理由

フォーカス管理、キーボード操作、支援技術向けの振る舞いを React Aria に任せ、Tailos 固有の見た目と部品の API は共通 UI に集約する。画面ごとにライブラリの部品を組み立てると、同種の操作でも表示や状態の扱いがずれやすい。CVA でバリエーションを揃え、共通部品の実装を利用側から独立して更新できるようにする。フォームの操作とラベルを共通部品に通すことで、フォーカス表示、アクセシブルな名前、無効状態の修正を同じ種類のコントロールに反映できる。

## 範囲と例外

新規コード、既存画面、テストの JSX を検査対象にする。Design Systems 内の部品実装は生タグを使える。既存画面の選択肢、初期値、入力制約、送信、認証、取得条件は各機能の判断に従う。ホームと Session は現行デザインを保ち、旧管理画面のフォームは共通スタイルを適用できる。
