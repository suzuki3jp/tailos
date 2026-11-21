---
schema: 1
id: PDR-20261121-session-realtime-transport
key: sessions.realtime-transport
status: accepted
decided_by: suzuki3jp
date: "2026-11-21"
areas: [sessions, runner, api, web]
keywords: [WebSocket, SSE, polling, 双方向通信, 即時性, ローディング, cursor, 再接続]
paths:
  - apps/api/src/infrastructure/cloudflare/**
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/api/src/bindings.ts
  - apps/api/wrangler.jsonc
  - apps/runner/src/server.ts
  - apps/runner/src/codex-rpc.ts
  - apps/web/src/_pages/session-detail/**
symbols: [RunnerContainer, CodexRpc, prefetchProjectSession]
supersedes: []
---

# Session 単位の WebSocket 配信で履歴の後から更新を受け取る

## 決定

[実行タイムライン案](PDR-20261121-session-execution-timeline.md) の履歴を HTTP で取得し、同じカーソルの後から WebSocket で受信する方式を採用する。ブラウザの購読を Session ごとの新しい `SessionStream` Durable Object に集約し、既存 RunnerContainer は実行・公開・復旧の制御を担う。

新しい DO は配信用の窓口とし、この案では履歴の正本は D1 / R2 に置く。閲覧だけで Runner コンテナを起動しない。Run の切り替わりやコンテナ破棄があっても、同じ Session の履歴を閲覧できるようにする。[DO の WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) は待機中の費用削減に利用できるが、頻繁なイベントやタイマーがある間の費用がなくなるとは想定しない。

### 通信経路

```text
Codex app-server (stdio) / Claude Agent SDK
  -> Runner の Adapter・本文検査・上限付き配送
  -> 内部 ingest（Run / producer 限定の認証）
  -> D1 イベント・表示用 Item / 非公開 R2 本文の保存
  -> 保存済みの通知待ち記録 -> SessionStream DO
  -> WebSocket -> セッションのタイムライン

ブラウザの操作
  -> 認証・Origin 検証 -> SessionStream DO
  -> 操作記録 -> RunnerContainer -> Runner の内部制御 API
  -> 対象 thread / turn の操作 -> 実際の結果を保存して配信
```

Runner から ingest までは既存と同じ短い HTTP バッチを基本とする。ブラウザの双方向通信のために、すべての区間を WebSocket にする必要はない。Runner の本文検査・送信キューを短くしても、ネットワーク処理で Agent の RPC 通知の処理を塞がない。

Runner の配送バッチは検査済みの Item 更新をまとめ、配送間隔は 250 ms とする。小さな更新をまとめてリクエスト数を抑えながら、既存の 1.5 秒待機を短くするためである。エンドツーエンドの実測値ではない。開始・完了の重要な更新は優先し、細かい出力はまとめる。保存コミット前に「保存済み」として配信せず、R2 保存や本文検査に要する時間を目標から隠さない。

### 初期表示と再接続

API 案は、Project 配下のセッションに対して `GET .../timeline`（表示 Item・最近の履歴・保存済み位置）、`GET .../events?after=cursor`（復旧用の増分）、`GET .../stream`（WebSocket upgrade）、`GET .../items/:itemId/output`（必要時の本文）を設ける。パスの接頭辞と型は既存ブラウザ API に合わせる。

初期レスポンスは Session・Run・Item のスナップショットと、そのスナップショットと整合する high-water cursor を返す。別々の時点で取得した最大カーソルだけを付けて、間のイベントを取りこぼす実装にしない。初期描画後にその位置から購読する。

購読開始時は、DO 内で新規通知を受ける準備をしてから保存履歴を再送し、再送中の通知をバッファする。履歴と通知が重なっても cursor / eventId で一度だけ適用する。D1 コミット後に DO 通知が失敗する窓は、同じコミットで残す通知待ち記録の再送で補う。通常経路でブラウザを常時 polling する設計にはしない。復旧用の増分 API と限定的な整合性確認は残す。

WebSocket の再接続はクライアント実装で行い、最後に適用した cursor を送る。期限切れ等で再送範囲外なら `reset_required` を返し、最新スナップショットへ同期する。DO の hibernation 後に必要な購読先・所有者・認証期限等は `serializeAttachment` で復元できるようにし、秘密の Cookie や Bearer は含めない。遅いクライアントの未送信キューには上限を設け、無制限にメモリへ保持しない。切断して再取得する場合にも、保存済み履歴と未保存の欠落を混ぜない。

### 双方向の操作

要件からは将来の中断や追加指示を想定するが、具体的な操作の提供を本提案だけで採択したとは扱わない。最初の実装では少なくとも subscribe / resume / ping の通信を定義し、Agent を操作する機能を提供する段階では、その状態遷移を明示的に定める。

操作の envelope は `commandId / runId / expectedTurnId / kind / payload` とし、受理と適用を区別する。`accepted` は操作の記録、`applied` は Runner の適用確認とする。再接続時の再送を重複実行しないようにする。Agent に届いたか不明な操作を無条件で再実行しない。プロバイダの非冪等操作では、適用直後の ACK 消失を `unknown` として照合する規則が必要になる。

Codex への追加指示は公開ドキュメント上の `turn/steer`、中断は `turn/interrupt` が候補であり、固定版の対応確認を行う。現在の Runner は job の開始・状態取得を中心とし、手動中断用の制御口を持たない。`CodexRpc` と現在の turn を Runner 内で参照できる設計、対象を限定した制御 API、deadline と中断を統合した AbortController が必要になる。Claude では SDK の操作へ変換し、未対応操作は明示的に拒否する。

中断が commit / push / PR 作成と競合する場合、取り消せない外部操作を取り消したと報告しない。中断可能な段階、既に公開された成果物、Run の終端状態、cleanup の扱いは操作機能を実装する前の独立した判断とする。WebSocket の導入だけで既存入力欄の送信を有効化しない。

## 理由

実行中の購読と、将来の中断・追加指示を同じ通信路で扱うには WebSocket が素直である。Session は複数の Run にまたがるため、コンテナと同じ寿命の購読窓口にしない方が接続と再取得を設計しやすい。

現在のブラウザの 5 秒 polling を取り除くだけでは、Runner の 1.5 秒配送、本文が完成するまでの待ち時間、RunnerContainer の状態確認周期は残る。即時性にはそれぞれの経路の見直しが必要である。

Agent の完了通知を受けたときは、既存の状態確認・公開照合を早く実行するよう RunnerContainer を起こす案とする。Run の成功を diagnostics の通知から直接更新しない。既存 alarm / Cron は、通知が届かないときの復旧経路として維持する。業務状態・最終回答の確定後にも SessionStream へ通知する。

## 範囲と例外

最初の実装は購読・再開・ping/pong の双方向通信と、初期表示・履歴・欠落復旧を対象とする。Agent の中断や追加指示は、この通信方式の採択だけでは有効化しない。本番デプロイは別の操作として扱う。

WebSocket の upgrade は GET なので、POST の Origin 検証だけを持つ現行 operator middleware の通過を安全性の根拠にしない。許可した Web Origin、Cookie 認証、Session 所有者と Project を明示的に検証する。以後の操作も対象 Run・turn と権限を照合し、長時間接続の認証失効を扱う。認証情報を URL のクエリに載せない。CSP の `connect-src` に配信先の `wss:` origin を追加し、HTTP の CORS 設定だけで WebSocket の接続を許可したと判断しない。

### ローディングと UI

PR #112 のサーバー prefetch / hydration を維持し、セッション詳細・最近の Item・一覧初回ページを可能な限り並列に取得する。詳細の取得後でなければ分からない Run を一つずつブラウザから取得する waterfall を作らず、Session を単位に集約する。スナップショットに含む Item と cursor は整合させる。

ブラウザは取得済みの会話と Item をすぐ表示し、WebSocket の接続完了を初期表示の条件にしない。本文は展開した Item だけ取得し、過去の履歴はページングする。Session・Run・Item・cursor は同じ D1 batch で読み、prefetch の並列実行によって終端状態の通知を飛び越さないようにする。初期タイムラインは Session の応答から引き継ぎ、同じ本文を hydration state に二重に含めない。独立した遅い一覧等が会話の表示を長く塞ぐ場合は、その領域を分離して Suspense 等を検討する。実測せず一律の Skeleton や最低待機時間を設けない。

Web のタイムライン UI・取得・状態更新はまず `_pages/session-detail` の `ui / api / model` に置き、server 専用 prefetch は `index.server.ts` の境界を維持する。汎用の接続処理だけを Shared に置き、単一画面向けの仕組みを先に Widgets / Features へ抽出しない。WebSocket 受信から TanStack Query cache または画面内の reducer を更新し、token ごとに全会話を invalidation / refetch しない。

画面は、短い進捗を会話の流れに置き、コマンド・検索・ファイル変更は開始から完了まで同じカードを更新する。コマンド本文・出力・終了コード等は展開でき、完了後も同じ renderer を使う。Agent の実行状態、接続の切断・再接続、記録の欠落、本文の失効は別々に表示する。末尾を見ているときだけ追従し、過去を読んでいるときは新着の案内を出す。

## 選択肢と影響

| 配信方法 | 利点 | 不利益・判断 |
| --- | --- | --- |
| polling の間隔を短縮 | 現在のコードを活かせる。失敗から復旧しやすい | 同時閲覧数と頻度に応じて API / DB 負荷が増え、操作にも別経路が必要。通常のライブ表示の主方式にはしない |
| SSE + HTTP POST | 受信と操作を単純な HTTP で分けられる。EventSource の再接続と event ID を利用できる。閲覧中心なら第一候補 | SSE 自体はサーバーからクライアントへの一方向。POST を組み合わせればアプリとして双方向になる。配信元への fan-out と永続履歴は依然必要で、長時間応答は DO WebSocket hibernation と同じ待機方式ではない |
| WebSocket + SessionStream DO（推奨） | 一つの接続で受信と操作を扱える。複数閲覧者への配信と hibernation を Cloudflare 上で構成できる | 再接続、cursor、認証失効、ACK、流量制御を実装する。新 DO の binding / migration と運用が必要で、履歴の永続化は別途必要 |

SSE を選ぶ場合も同じ履歴・Item 契約を使える。[EventSource](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) で Cookie を使う別 origin の接続は credentials と許可 origin を揃える。任意ヘッダーが必要なら fetch による SSE と再接続処理を検討する。WebSocket と SSE を初期段階から両方保守する案にはしない。

配信窓口を既存 RunnerContainer に追加する案は DO の追加を省けるが、Run ごとの接続、コンテナの破棄と購読の寿命、複数 Run を持つ Session の復元が結び付く。SessionStream を別にする案にも追加 RPC と通知失敗の復旧が増える欠点がある。実行の初回実装を最小化する必要が高ければ、Run 単位 SSE / WebSocket は比較対象になる。

## 未決事項

- Agent に提供する操作の範囲。中断、実行中の追加指示、完了後の新しい Run の開始は別々に決める。
- 初期運用値は再接続 backoff を 1 秒から最大 10 秒、ping を 30 秒、認証の再確認を配信・操作ごとと 60 秒の alarm とする。未 ACK の送信は最大 8 frame / 合計 1 MiB、処理待ちの操作は最大 8 件とし、遅い接続は切断してスナップショットから再開する。これらは通信・メモリを有限に保つ値であり、実測に応じて見直す。
- API / DO の配置と D1 保存先による遅延。D1 の read replica を使う場合は、直前のコミットを読む制約や bookmark を引き継ぎ、古い replica でカーソルが進まない状態を避ける。
- 通知待ち記録の配送方式と再送間隔、復旧の目標時間。常時接続中でも保存後の通知消失を取りこぼさないことを確認する。
- 初期描画とライブ更新の測定目標。配送間隔の 250 ms とエンドツーエンドの到達時間は別であり、到達時間は実測する。

## 再検討条件

初期機能が閲覧中心で、Agent 操作を当面提供しないと決まった場合は SSE + POST を再評価する。高頻度更新で D1 の保存時間が支配的なら、タイムライン案の DO SQLite 正本方式を評価する。

実装の検証では、スナップショット取得と購読の間の更新、ACK 消失と再送、DO 再起動、遅延・欠落・順序逆転、複数タブ、権限外の購読・操作、不正 Origin、認証失効、コンテナ消失、本文検査失敗、期限切れ、構造化回答と短縮 turn、Agent 完了後の公開中、遅い履歴取得を確認する。初期表示とライブ到達の時間を別々に測り、既存 CI の format・lint・test・typecheck と Web build に加え、Runner bundle と Worker / DO の接続統合検証を行う。
