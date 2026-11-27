---
schema: 1
id: PDR-20261125-csp-github-avatars
key: web.csp.style-attributes
status: superseded
date: "2026-11-25"
decided_by: suzuki3jp
areas: [web, security, design-system]
keywords: [CSP, style, nonce, Base UI, GitHub, アバター, img-src]
paths:
  - apps/web/src/worker/**
  - apps/web/src/app/**
  - apps/web/src/shared/ui/**
  - apps/web/src/widgets/page-shell/**
supersedes: [PDR-20261116-csp-style-attributes]
---

# style 属性と nonce の方針を維持し、GitHub のアバター配信元を許可する

## 決定

Web の CSP の `img-src` を `'self' https://avatars.githubusercontent.com` にする。本人情報 API の画像をサイドバーに表示するため、HTTPS の GitHub アバター配信元を追加する。他の外部画像ホストや任意の HTTPS 画像は許可しない。

従来の `style-src-attr 'unsafe-inline'` を維持し、Base UI の style 属性を許可する。本番の `script-src` と `style-src` は `'self'` とレスポンスごとの nonce に限定し、スクリプトの `'unsafe-inline'` や `'unsafe-eval'` は追加しない。ルートの `CSPProvider` に Worker が生成した同じ nonce を渡し、ライブラリの style 要素にも適用する。Select は通常の SSR とライブラリのスタイル出力を使う。

## 理由

実ユーザーの GitHub アバターを表示するには、その画像配信元をブラウザに許可する必要がある。ホストを明示して追加すれば、任意の外部画像の読み込みを許可せずに本人表示を実現できる。Base UI の配置・フォーム用 style 属性と、スクリプトおよび style 要素の nonce 制御は引き続き両立させる。

## 範囲と例外

Worker が返す HTML 全体に適用する。前の判断では画像の既存ポリシーを維持していたが、今回は GitHub アバター配信元だけを追加する。フォント・通信先・フォーム送信先・フレーム埋め込み・キャッシュの方針は変えない。nonce は同じレスポンスに結び付け、クライアントからの任意の nonce を採用しない。開発時の既存スクリプト許可は維持する。

画像は認証済みプロフィールから取得する。固定のサンプル画像を本人として表示しない。プロフィールと共通 Page の表示は [共通 Page の判断](PDR-20261125-shared-page-shell.md) に従う。Figma は読み取り専用とする。
