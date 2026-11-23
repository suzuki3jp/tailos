---
schema: 1
id: PDR-20261123-model-credentials-outside
key: agent.model-credentials-outside
status: accepted
date: "2026-11-23"
areas: [agent, security, infrastructure]
keywords: [認証情報, コンテナ, Codex, ChatGPT, アクセストークン, 置き換え, プレースホルダー, 横取り, interceptOutboundHttps, chatgpt.com, 更新, リース, モデル API]
paths:
  - apps/api/src/infrastructure/cloudflare/model-egress.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/presentation/http/handlers/refresh/refresh.ts
  - apps/runner/src/codex-agent.ts
symbols: [ModelEgress, forwardModelRequest, placeholderAccessToken, modelAccess]
supersedes: []
decided_by: suzuki3jp
---

# Codex のモデル API の認証情報はコンテナに置かず、Workers 側で差し込む

## 決定

Codex の ChatGPT のアクセストークンを Runner のコンテナに渡さない。コンテナには、アカウントとプランの情報だけを持つ置き換え用のトークンを渡す。Codex が `chatgpt.com` へ送る通信は Cloudflare Containers の HTTPS の横取りで Workers 側に受け、Run の接続の現在のアクセストークンを差し込んで転送する。

- トークンの更新は API 側だけで行う。モデル API が 401 を返したら、そのアクセストークンを拒否されたものとして記録し、次の通信の前に更新する。
- Runner がトークンの更新を API に問い合わせる経路（`/_runner/runs/:runId/credentials`）は廃止する。Codex からの更新要求には、Runner が置き換え用のトークンをそのまま返す。
- Agent の作業が終わったら（公開の検査に進んだら）、GitHub と同じくモデル API への差し込みも止める。

## 理由

PDR-20261122-agent-egress-credential-proxy で外部通信を常に許可したため、プロンプトインジェクションでコンテナ内の情報が外部に送られうる。GitHub の認証情報はすでにコンテナの外で差し込んでいる。Codex の接続のトークンも同じ扱いにすれば、コンテナの中の Agent や対象リポジトリの hook から、利用者の ChatGPT の接続を持ち出せなくなる。Session 単位でコンテナを引き継ぐ実行モデル（PDR-20261123-session-continuity）でも、引き継ぐ環境にトークンが含まれない。

## 範囲と例外

対象は Codex で実行する Run。Claude の Run は今の API ではまだ起動しないので、Claude を有効にする段階（suzuki3jp/tailos#60）で `api.anthropic.com` に同じ方式を適用する。

Runner 自身が使う秘密（公開の検査に使う Run のリース、診断の送信用の Bearer、制御用の鍵）は、今回はコンテナに残る。これらは Run に限定され、利用者の外部サービスの接続には届かない。Agent のコマンドから隔離する方法は後続で扱う。

置き換え用のトークンは、横取りが有効なコンテナでのみ意味を持つ。横取りが働かない場合、Codex のモデル呼び出しは認証に失敗し、Turn は失敗する。別のトークンや経路へ黙って切り替えない。

## 選択肢と影響

- **トークンをコンテナに渡し、Codex のシェル環境から外すだけにする案**: 今の作りに近いが、同じコンテナで動く hook やプロセスからトークンに届く。採用しない。

不利益として、Codex のモデル API への通信がすべて Workers を経由する。WebSocket の通信も Workers から中継する。本番の Containers で横取りした WebSocket を中継できることは、deploy 後に確かめる。
