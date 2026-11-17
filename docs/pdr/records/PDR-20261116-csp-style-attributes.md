---
schema: 1
id: PDR-20261116-csp-style-attributes
key: web.csp.style-attributes
status: accepted
date: "2026-11-16"
decided_by: suzuki3jp
areas: [web, security, design-system]
keywords: [CSP, Content-Security-Policy, style-src-attr, nonce, インラインスタイル, Base UI, SSR]
paths:
  - apps/web/src/worker/**
  - apps/web/src/app/layout.tsx
  - apps/web/src/app/providers.tsx
  - apps/web/src/app/styles.css
  - apps/web/src/_pages/home/ui/project-select*
  - docs/design-system/**
symbols: [RootLayout, Providers, ProjectSelect]
supersedes: []
---

# JavaScript の制限を維持し、style 属性だけを許可する

## 決定

Web の CSP に `style-src-attr 'unsafe-inline'` を追加し、HTML 要素の `style` 属性を許可する。従来は `style-src 'self' 'nonce-…'` へのフォールバックにより属性も拒否していたため、この点を変更する。

JavaScript の制限は維持する。本番の `script-src` は `'self'` とレスポンスごとに生成する nonce だけとし、`'unsafe-inline'` と `'unsafe-eval'` を追加しない。開発時の既存の許可は変更しない。

`<style>` 要素と CSS ファイルに対する `style-src` も維持する。Base UI が作る `<style>` 要素には、Worker が生成して描画リクエストに設定した CSP と同じ nonce を `CSPProvider` で渡す。nonce のない `<style>` 要素を一律許可しない。

Project Select の hydration 待ちと代替ボタン、および Base UI の style 要素の停止・静的 CSS への複製を削除し、通常の SSR とライブラリのスタイル出力を使用する。

## 理由

UI ライブラリはフォーム連携用の隠し要素やポップアップの配置に style 属性を使う。属性の全面禁止を維持すると、最初の HTML とクライアントで異なる部品を描画し、同じ外見を二重管理する負担が生じる。属性に限って許可し、JavaScript と style 要素の nonce 制限を維持することで、通常の UI 実装と既存のスクリプト制御を両立する。

この判断により、HTML を注入できる不具合があれば、攻撃者が style 属性で表示や配置を変える余地は広がる。属性の許可を安全性の保証とは扱わず、外部入力のエスケープ、認証・認可、既存の読み込み先・通信先の制限は維持する。

## 範囲と例外

Web Worker が返す HTML 全体に適用し、ホームだけの例外にはしない。画像・フォント・通信先・フォーム送信先・フレーム埋め込み・キャッシュの既存ポリシーは変更しない。nonce は描画と同じレスポンスに結び付け、クライアントが送った任意の nonce を採用しない。

Figma は引き続き読み取り専用であり、ホームのモックデータと API 非接続の範囲は [ホームのプレビュー方針](PDR-20261116-home-design-preview.md) を維持する。

## 選択肢と影響

- 属性を禁止し続ける案は CSS 注入に対する制限を保てるが、UI ライブラリに合わせた SSR 回避やスタイル管理が必要になる。
- `style-src` 全体へ `'unsafe-inline'` を加える案は nonce のない style 要素まで許可するため採用しない。
- ライブラリの変更だけでは style 属性を使う実装がなくなる保証がないため、CSP の対象を明示的に分ける。
