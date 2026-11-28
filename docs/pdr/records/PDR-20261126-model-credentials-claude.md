---
schema: 1
id: PDR-20261126-model-credentials-claude
key: agent.model-credentials-outside
status: accepted
date: "2026-11-26"
areas: [agent, security, infrastructure]
keywords: [Claude, api.anthropic.com, OAuth トークン, "/v1/messages", count_tokens, workspace routing discovery, accounts/check, 拒否のログ, パス, 許可, 更新の間隔, "401", 認証情報, コンテナ, Codex, ChatGPT, アクセストークン, 置き換え, プレースホルダー, 横取り, interceptOutboundHttps, chatgpt.com, 更新, リース, モデル API]
paths:
  - apps/api/src/infrastructure/cloudflare/model-egress.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/codex-agent.ts
  - apps/runner/src/claude-agent.ts
symbols: [ModelEgress, forwardModelRequest, forwardClaudeRequest, isCodexPath, isClaudePath, placeholderAccessToken, placeholderClaudeToken, modelAccess, claudeAccess, rejectModelAccess]
supersedes: [PDR-20261124-model-credentials-workspace-check]
decided_by: suzuki3jp
---

# Codex・Claude のモデル API の認証情報はコンテナに置かず、Workers 側で差し込む

## 決定

Agent のモデル API の認証情報を Runner のコンテナに渡さない。コンテナには置き換え用のトークンだけを渡し、Agent がモデル API へ送る通信は Cloudflare Containers の HTTPS の横取りで Workers 側に受け、Run の接続の現在の認証情報を差し込んで転送する。Codex と Claude の両方に適用する。

### Codex

- コンテナには、アカウントとプランの情報だけを持つ置き換え用のトークンを渡す。横取りするのは `chatgpt.com` への通信。
- 差し込むのは Codex が Run で使うパスだけにする。`/backend-api/codex/` 以下（モデル API）、`/backend-api/wham/accounts/check`（Codex が最初のモデル要求の前に行うワークスペースの確認）、`/backend-api/wham/usage`（使用量の取得）に限る。
- トークンの更新は API 側だけで行う。モデル API が 401 を返したら、そのアクセストークンを拒否されたものとして記録し、次の通信の前に更新する。401 による強制的な更新は 1 つの Run で 5 秒に 1 回までにする。それより短い間隔の 401 は記録せず、今のトークンを使い続ける。
- Runner がトークンの更新を API に問い合わせる経路は持たない。Codex からの更新要求には、Runner が置き換え用のトークンをそのまま返す。

### Claude

- コンテナには、長期 OAuth トークンと同じ形の置き換え用のトークン（`sk-ant-oat01-` で始まり、利用者の値を含まない）を `CLAUDE_CODE_OAUTH_TOKEN` として渡す。横取りするのは `api.anthropic.com` への通信。
- 差し込むのは Claude Code が Run で使うモデル API のパスだけにする。`/v1/messages` と `/v1/messages/count_tokens` に限る。`Authorization` を接続の OAuth トークンに置き換え、コンテナが送った `Authorization`・`X-Api-Key`・`Proxy-Authorization`・`Cookie` は転送しない。
- 貼り付けたトークンは更新できないので、401 が返っても更新はしない。接続も自動では無効にしない（[認証の拒否の判断](PDR-20261114-006.md)）。

### 共通

- 許可していないパスや、区切りやドットを符号化したパスには差し込まずに 403 を返し、Run の ID・ホスト・パスだけを Workers のログに残す。ヘッダーとクエリは記録しない。
- 差し込むのは、その時点の Run の Agent と同じ接続のホストだけにする。Codex の Run の間に `api.anthropic.com` へ送られた通信、Claude の Run の間に `chatgpt.com` へ送られた通信には差し込まない。
- Agent の作業が終わったら（公開の検査に進んだら）、GitHub と同じくモデル API への差し込みも止める。

## 理由

PDR-20261122-agent-egress-credential-proxy で外部通信を常に許可したため、プロンプトインジェクションでコンテナ内の情報が外部に送られうる。GitHub の認証情報はすでにコンテナの外で差し込んでいる。モデル API の接続のトークンも同じ扱いにすれば、コンテナの中の Agent や対象リポジトリの hook から、利用者の ChatGPT や Claude の接続を持ち出せなくなる。Session 単位でコンテナとスナップショットを引き継ぐ実行モデル（PDR-20261123-session-continuity）でも、引き継ぐ環境にトークンが含まれない。

Claude のトークンは有効期間が 1 年で、Run をまたいで同じ値を使う。漏れたときの影響が Codex の短命なアクセストークンより大きいため、Codex と同じくコンテナに置かないことを利用者が求めた。差し込みは Workers 側で `Authorization` を置き換えるだけで、Claude Code の要求の本文やほかのヘッダーは変えずに転送する。Claude Code 自身の要求を模倣して作り直すことはしない。

Claude Code 2.1.319（Agent SDK 0.3.319）が OAuth トークンで Run に使う通信は、ローカルで送り先を記録して確かめた範囲では `POST /v1/messages` だけだった。トークン数の確認（`/v1/messages/count_tokens`）も同じモデル API の機能なので含める。パスを限ることで、Run の間に利用者の Claude アカウントのほかの API をコンテナから使えないようにする。

Codex で差し込むパスに `/backend-api/wham/accounts/check` を含めるのは、Codex 0.166.0 が最初のモデル要求の前に「workspace routing discovery」として確認を行い、これを拒否すると Codex のすべてのターンが失敗したためである。このパスはアカウントとワークスペースの情報だけを返す。更新の間隔を限るのは、無関係な 401 を繰り返し起こして refresh token を何度もローテーションさせ、接続を失敗させることを防ぐためである。

## 範囲と例外

Codex または Claude で実行する Run に適用する。横取りはホスト単位でコンテナ全体に効くので、Agent 本体以外のプロセスもそのホストに通信できる。差し込むパスを限ることで影響をモデル API に留める。Agent の更新で Run に必要なパスが増えたら、拒否のログを手がかりにこの範囲を見直す。

Runner 自身が使う秘密（公開の検査に使う Run のリース、診断の送信用の Bearer、制御用の鍵）は、今回はコンテナに残る。これらは Run に限定され、利用者の外部サービスの接続には届かない。Agent のコマンドから隔離する方法は後続（suzuki3jp/tailos#159）で扱う。

置き換え用のトークンは、横取りが有効なコンテナでのみ意味を持つ。横取りが働かない場合、モデル呼び出しは認証に失敗し、Turn は失敗する。別のトークンや経路へ黙って切り替えない。

## 選択肢と影響

- **トークンをコンテナに渡し、Agent のシェル環境から外すだけにする案**: 作りは簡単だが、同じコンテナで動く hook やプロセスからトークンに届く。採用しない。
- **Claude だけはトークンをコンテナに渡す案**: Claude Code の通信を作り直さずに済むが、1 年有効のトークンがコンテナとスナップショットに残る。採用しない。

不利益として、モデル API への通信がすべて Workers を経由する。Claude Code の通信が本番の Containers の横取りで成り立つこと（Claude Code が横取りの証明書を信頼すること）は、deploy 後に確かめる。
