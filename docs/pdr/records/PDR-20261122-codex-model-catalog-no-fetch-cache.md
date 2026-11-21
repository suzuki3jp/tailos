---
schema: 1
id: PDR-20261122-codex-model-catalog-no-fetch-cache
key: triggers.routine-model-catalog-cache
status: accepted
date: "2026-11-22"
areas: [triggers, agent, auth]
keywords: [Routine, モデル候補, キャッシュ, コンテナ, 同時取得, 廃止]
paths:
  - apps/api/src/infrastructure/cloudflare/credential-broker.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
symbols: []
supersedes: [PDR-20261119-routine-model-catalog-cache]
decided_by: suzuki3jp
---

# モデル候補取得のまとめ・キャッシュを廃止する

## 決定

モデル候補をソース内の定義から提供するため、所有者・接続ごとの候補取得のまとめと 5 分間のキャッシュを廃止する。CredentialBroker は候補を保持せず、候補取得のための Runner コンテナも起動しない。

## 理由

まとめとキャッシュは、候補取得ごとに専用コンテナを起動する費用と同時実行枠の消費を抑えるためのものだった。[ソース内定義の判断](PDR-20261122-codex-model-catalog-in-source.md) により取得そのものがなくなるため、目的を失う。

## 範囲と例外

有効化時の接続確認は CredentialBroker の接続状態を参照し、キャッシュは持たない。
