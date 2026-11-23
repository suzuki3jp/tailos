---
schema: 1
id: PDR-20261123-model-credentials-outside
key: agent.model-credentials-outside
status: "superseded"
date: "2026-11-23"
areas: [agent, security, infrastructure]
keywords: [パス, 許可, 更新の間隔, "401", 認証情報, コンテナ, Codex, ChatGPT, アクセストークン, 置き換え, プレースホルダー, 横取り, interceptOutboundHttps, chatgpt.com, 更新, リース, モデル API]
paths:
  - apps/api/src/infrastructure/cloudflare/model-egress.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/presentation/http/handlers/refresh/refresh.ts
  - apps/runner/src/codex-agent.ts
symbols: [ModelEgress, forwardModelRequest, isCodexPath, placeholderAccessToken, modelAccess, rejectModelAccess]
supersedes: []
decided_by: suzuki3jp
---

# Codex のモデル API の認証情報はコンテナに置かず、Workers 側で差し込む

## 決定

Codex の ChatGPT のアクセストークンを Runner のコンテナに渡さない。コンテナには、アカウントとプランの情報だけを持つ置き換え用のトークンを渡す。Codex が `chatgpt.com` へ送る通信は Cloudflare Containers の HTTPS の横取りで Workers 側に受け、Run の接続の現在のアクセストークンを差し込んで転送する。

- 差し込むのは Codex が Run で使うパスだけにする。`/backend-api/codex/` 以下（モデル API）と `/backend-api/wham/usage`（使用量の取得）に限り、それ以外のパスや、区切りやドットを符号化したパスは差し込まずに 403 を返す。
- トークンの更新は API 側だけで行う。モデル API が 401 を返したら、そのアクセストークンを拒否されたものとして記録し、次の通信の前に更新する。401 による強制的な更新は、廃止した経路と同じく 1 つの Run で 5 秒に 1 回までにする。それより短い間隔の 401 は記録せず、今のトークンを使い続ける。
- Runner がトークンの更新を API に問い合わせる経路（`/_runner/runs/:runId/credentials`）は廃止する。Codex からの更新要求には、Runner が置き換え用のトークンをそのまま返す。
- Agent の作業が終わったら（公開の検査に進んだら）、GitHub と同じくモデル API への差し込みも止める。

## 理由

PDR-20261122-agent-egress-credential-proxy で外部通信を常に許可したため、プロンプトインジェクションでコンテナ内の情報が外部に送られうる。GitHub の認証情報はすでにコンテナの外で差し込んでいる。Codex の接続のトークンも同じ扱いにすれば、コンテナの中の Agent や対象リポジトリの hook から、利用者の ChatGPT の接続を持ち出せなくなる。Session 単位でコンテナを引き継ぐ実行モデル（PDR-20261123-session-continuity）でも、引き継ぐ環境にトークンが含まれない。

## 範囲と例外

対象は Codex で実行する Run。Claude の Run は今の API ではまだ起動しないので、Claude を有効にする段階（suzuki3jp/tailos#60）で `api.anthropic.com` に同じ方式を適用する。

Runner 自身が使う秘密（公開の検査に使う Run のリース、診断の送信用の Bearer、制御用の鍵）は、今回はコンテナに残る。これらは Run に限定され、利用者の外部サービスの接続には届かない。Agent のコマンドから隔離する方法は後続で扱う。

横取りはホスト単位でコンテナ全体に効くので、Codex 本体以外のプロセスも `chatgpt.com` に通信できる。パスを限ることで、Run の間に利用者の ChatGPT アカウントの他の API（会話の履歴など）をコンテナから使えないようにする。更新の間隔を限ることで、無関係な 401 を繰り返し起こして refresh token を何度もローテーションさせ、接続を失敗させることを防ぐ。Codex がこれ以外のパス（プラグインやクラウドタスクなど）を使う機能は、Run では使えない。Codex の更新で Run に必要なパスが増えたら、この範囲を見直す。

置き換え用のトークンは、横取りが有効なコンテナでのみ意味を持つ。横取りが働かない場合、Codex のモデル呼び出しは認証に失敗し、Turn は失敗する。別のトークンや経路へ黙って切り替えない。

## 選択肢と影響

- **トークンをコンテナに渡し、Codex のシェル環境から外すだけにする案**: 今の作りに近いが、同じコンテナで動く hook やプロセスからトークンに届く。採用しない。

不利益として、Codex のモデル API への通信がすべて Workers を経由する。WebSocket の通信も Workers から中継する。本番の Containers で横取りした WebSocket を中継できることは、deploy 後に確かめる。
