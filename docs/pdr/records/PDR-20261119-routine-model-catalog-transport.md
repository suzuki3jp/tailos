---
schema: 1
id: PDR-20261119-routine-model-catalog-transport
key: triggers.routine-model-catalog-transport
status: accepted
date: "2026-11-19"
areas: [triggers, agent, auth]
keywords: [Routine, モデル候補, effort, app-server, model/list, ChatGPT, "403"]
paths:
  - apps/api/src/infrastructure/cloudflare/credential-broker.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/codex*.ts
  - apps/runner/src/server.ts
  - packages/core/src/runner.ts
symbols: [codexModels, listCodexModels]
supersedes: []
decided_by: suzuki3jp
---

# Routine のモデル候補を app-server の model/list から取得する

## 決定

Routine のモデル・effort 候補と保存時の対応確認には、所有者の接続で認証した Codex app-server の `model/list` を使う。API Worker が ChatGPT のモデル一覧 HTTP API を直接呼び出す実装を廃止する。実行時の対応確認と同じ一覧取得処理を使い、ページングされた結果も取得する。

## 理由

本番で Worker から ChatGPT のモデル一覧へのリクエストが 403 となり、Routine の候補取得が 503 で失敗した。403 を返す上流側の理由は未確定だが、Tailos が非公開 HTTP API の URL・ヘッダー・レスポンス形式を独自に扱う経路をなくし、実行に用いる app-server のインターフェースに統一することで、候補取得と実行時の設定確認のずれを減らす。

## 範囲と例外

候補取得には実行中の Run と分離した Runner コンテナと一時的な app-server を使う。所有者の短期 access 情報だけを渡し、refresh token は API 側に残す。モデル一覧取得のために checkout、thread、turn、推論、Run の作成は行わない。取得終了・失敗・中断時は app-server と一時ディレクトリを片付け、API 側でも専用コンテナを破棄する。

候補取得は既存の Runner 起動・RPC の時間制限に従う。コンテナの起動時間と費用が加わるが、失敗時に Worker の直接 HTTP 取得へ戻す fallback は設けない。

同じ所有者・接続からの同時取得は CredentialBroker 内で一回にまとめる。接続の版が変わった場合は、以前の接続の取得には合流しない。取得結果の有効期間と破棄条件は [キャッシュの判断](PDR-20261119-routine-model-catalog-cache.md) に従う。

候補の選択と保存済み値の表示は [選択式の判断](PDR-20261118-routine-model-options.md)、取得できない場合の保存・有効化は [設定検証の判断](PDR-20261118-routine-configuration-validation.md) に従う。app-server の一覧はキャッシュや同梱情報を含み得るため、候補が存在することは推論成功の保証ではない。接続切れやプロバイダ側の変更による実行時エラーまで防ぐものではない。
