---
schema: 1
id: PDR-20261128-local-development-seed
key: development.local-seed
status: accepted
date: "2026-11-28"
decided_by: suzuki3jp
areas: [development, auth, api]
keywords: ["シード", "ダミーユーザー", "Cookie", "E2E", "worktree", "D1"]
paths: ["apps/api/scripts/seed-local.mjs", "apps/api/src/infrastructure/d1/local-seed.ts", "docs/local-development.md"]
---

# ローカル D1 のシードでダミー運用者として画面を確認できるようにする

## 決定

開発用コマンドで、ローカル D1 にダミー運用者と、その運用者に属する Project、Session、Run、Routine を投入する。要求された場合は Better Auth のログインセッションを作り、利用中の開発 API が検証できる署名済み Cookie を返す。

## 理由

worktree やリモート開発環境を作るたびに GitHub OAuth を設定してログインすると、画面の確認に手間がかかる。ダミー運用者と署名済み Cookie があれば、E2E の CI に GitHub の認証情報を登録せず、通常の所有者認証を通してログイン後の画面を確認できる。

## 範囲と例外

投入先と署名鍵はシード用の Wrangler ローカル環境に限定する。投入は一括で行い、同じ環境で再実行してもサンプルの件数や手動編集した内容を保持する。Run は終了済み、Routine は無効の状態で投入する。Cookie の有効期限と検証は既存の Better Auth の設定に従う。Cookie の出力は明示指定時に限り、CI ではテストのセットアップに渡す。
