---
schema: 1
id: PDR-20261127-react-aria-csp
key: web.csp.style-attributes
status: accepted
date: "2026-11-27"
decided_by: suzuki3jp
areas: [web, security, design-system]
keywords: [CSP, style, nonce, React Aria, GitHub, アバター, img-src]
paths:
  - apps/web/src/worker/**
  - apps/web/src/app/**
  - apps/web/src/shared/ui/design-systems/**
  - apps/web/src/widgets/page-shell/**
supersedes: [PDR-20261125-csp-github-avatars]
---

# React Aria に Worker の CSP nonce を渡す

## 決定

Web の `img-src` は `'self' https://avatars.githubusercontent.com` とする。本番の `script-src` と `style-src` は `'self'` とレスポンスごとの nonce に限定し、配置やフォームに必要となる style 属性は `style-src-attr 'unsafe-inline'` で許可する。

ルートレイアウトの `meta[property="csp-nonce"]` に、Worker がそのレスポンス用に生成した nonce を渡す。React Aria はこの値をライブラリが作る style 要素に使う。Project の Select は選択済み値と操作部をサーバーで描画する。

## 理由

React Aria は nonce を文書の meta 要素から取得する。Worker の発行値を使うことで、オーバーレイの動作に必要なスタイルと、インラインのスクリプト・スタイル要素に対する nonce 制御を両立できる。GitHub の画像配信元の明示的な許可により、認証済みプロフィールから取得したアバターを表示できる。

## 範囲と例外

Worker が返す HTML 全体に適用する。nonce は同じレスポンスに結び付け、クライアントからの任意の値は採用しない。開発時は既存のスクリプトとスタイルの許可を使う。フォント、通信先、フォーム送信先、フレーム埋め込み、キャッシュは既存の方針に従う。認証済みプロフィールに画像がない場合や読み込めない場合は汎用アカウントアイコンを表示する。
