---
schema: 1
id: PDR-20261116-session-metadata-backfill
key: sessions.metadata-backfill
status: accepted
date: "2026-11-16"
decided_by: suzuki3jp
areas: [sessions, api, migrations]
keywords: [既存データ, 補完, 起動元, inbox, updated_at, 初期タイトル]
paths:
  - apps/api/migrations/**
  - apps/api/src/infrastructure/d1/**
  - apps/api/src/presentation/http/handlers/github-webhook/**
symbols: [sessions, planningInbox, runs]
supersedes: []
---

# 会話メタデータは保存済みの事実から補完する

## 決定

新しい GitHub 起点の Session は署名検証済み Webhook の Issue タイトルと repository・Issue 番号から初期タイトルと起動元を保存する。会話の起動元は最初の Issue で固定し、後の入力では上書きしない。GitHub 以外の新しい Session の初期タイトルは「新しい会話」、起動元は `null` とする。

既存 Session の初期タイトルは保存済みの最古の planning snapshot の Issue タイトルから補完し、復元できなければ「新しい会話」とする。既存の起動元は `target` と保存済み Run の実行コンテキストの repository・Issue 番号が一致する情報から復元し、特定できなければ `null` とする。Project の現在設定や GitHub API から過去の情報を推測しない。既存 Session の生成タイトルは未確定とし、次の正常な応答で生成を試みる。

既存 Session の `updated_at` は、作成日時、保存済みメッセージの作成日時、Run の作成日時・終了日時の最大値から補完する。過去の running 遷移時刻は保存されていないため復元したとは扱わない。

未割り当ての計画 inbox の受理だけでは `updated_at` を進めない。メッセージ追加・Run 作成に進んだ時点で既存の採択済み規則に従う。Run の状態だけが変わった時刻は API 側の Unix ミリ秒を保存し、内部再試行で変更しない。

## 理由

既存データには元の Issue タイトルや Run の開始時刻がない場合がある。保存済みの事実だけを使い、不明な起動元を別の Issue と誤認させない。外部照会を伴わない migration なら、GitHub の可用性や後から変更された Project 設定に移行結果が左右されない。

計画 inbox にはまだ Agent の会話として割り当てていない入力や開始方法の案内だけの入力もあるため、会話へ追加する時点を活動として扱う。

## 範囲と例外

API が保存・返却するメタデータの既存データの補完と、新規データの初期値に適用する。過去の Agent 応答からタイトルを再生成するための追加呼び出しは行わない。Project が削除済みでも Session は保持して一覧 API の取得対象に含める。

## 選択肢と影響

GitHub API に問い合わせれば現在の Issue タイトルを得られるが、過去の初期値の復元にはならない。代替の会話名が複数並ぶ可能性はあるが、保存されていない情報を正確に復元したように見せることを避ける。
