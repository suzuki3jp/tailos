# AI Agent から Tailos を調べる

`https://api.tailos.app/mcp` に read 専用の Remote MCP を提供する。Streamable HTTP の POST を使い、公式 SDK によって 2026-07-28 と従来の 2025 系プロトコルを扱う。任意の AI Agent から利用できるが、クライアントには Remote MCP と Authorization ヘッダーの設定が必要。

## 接続

MCP クライアントに次を設定する。キーはクライアントの秘密情報ストアや環境変数に保存する。

```text
URL: https://api.tailos.app/mcp
Transport: Streamable HTTP
Authorization: Bearer <apiKey>
```

OAuth の自動ログインは実装していない。このエンドポイントの Bearer は事前に発行した API key であり、GitHub、ChatGPT、smoke API の資格情報とは交換できない。ブラウザの Cookie も受け付けない。Origin がある場合は、設定した API または Web の Origin と一致する必要がある。ブラウザから任意 Origin で呼ぶための CORS は公開しない。

## Web からキーを発行する

1. [Tailos](https://tailos.app/login) に GitHub でログインする。
2. メニューの **MCP 接続**（`/mcp`）を開く。
3. 用途が分かるキー名と有効期間（7日・30日・90日）を選び、**キーを発行**を押す。
4. 表示されたキーをコピーし、Agent の API key / Bearer token に設定する。平文のキーは発行直後だけ表示され、画面を閉じると再表示できない。
5. 同じ画面の接続先 URL を MCP クライアントに登録する。発行した時点で使え、キーごとのサーバー設定やデプロイは不要。

一覧ではキー名、識別用の先頭部分、発行日と有効期限を確認できる。使わなくなったキーは **失効** を押すとすぐに使えなくなる。更新するときは新しいキーを発行して Agent の設定を置き換え、旧キーを失効する。未失効のキーは期限切れを含めて20件まで作成できる。

キーは Web からログアウトしても、有効期限または失効まで使える。

サーバーは D1 の `mcp_keys` に SHA-256、所有者、期限、失効状態と表示用のメタデータだけを保存する。平文は発行応答だけに含め、一覧やブラウザの永続ストレージには保存しない。キーの管理 API は Web の運用者ログインと Origin の検証で保護し、MCP のキーでは別のキーを発行・失効できない。

毎リクエストでキーの所有者と現在の GitHub 運用者との対応も照合する。運用者を切り替えても、旧キーに新運用者の権限を移さない。権限は所有する Session・Run と、Web で同じ運用者が閲覧できる diagnostics の read のみ。所有者未確定の受付 Trace も既存の diagnostics の運用者権限に従う。

以前の CLI と `TAILOS_MCP_READ_KEY_CONFIG` / `TAILOS_MCP_ENABLED` による設定は廃止した。旧 Secret のキーは認証に使われないため、Web でキーを発行し直す。新機能のデプロイでは migration `0005` がキーのテーブルを作成する。

旧方式を設定済みの環境だけ、移行後に使わなくなった設定を片付ける。新しいキーの発行・更新時には不要。

- `apps/api` で `pnpm exec wrangler secret delete TAILOS_MCP_READ_KEY_CONFIG` を実行して旧 Worker Secret を削除する。
- GitHub の **Settings → Environments → production → Secrets** から旧 `TAILOS_MCP_READ_KEY_CONFIG` を削除する。

ローカルでも Web の GitHub ログインから同じ画面を使う。接続先 URL は API の `TAILOS_PUBLIC_ORIGIN` から返し、通常は `http://localhost:8787/mcp` になる。

## 調査の流れ

| ツール | 内容 |
| --- | --- |
| `get_usage` | 最初に読む使い方、概念と取得範囲。`tailos://usage` Resource にも同じ情報を公開 |
| `list_sessions` | 所有する Session の一覧。projectId・target の完全一致で絞り込める |
| `get_session` | Session のメタデータと seq 順の会話プレビュー |
| `read_message` | メッセージの本文を部分取得 |
| `list_runs` | Run 一覧。sessionId・status で絞り込める |
| `get_run` | Run の状態、失敗コード、時刻、保存済みの公開結果 |
| `read_run_artifact` | 終端 Run の `events.ndjson` または `result.json` |
| `list_traces` | Run と関連受付、source・deliveryId による Trace の検索 |
| `list_events` | Trace の Event を受信順に取得 |
| `list_artifacts` | Trace の Artifact 参照と保存期限を取得 |
| `read_diagnostic_artifact` | 診断本文の JSON バッチを部分取得 |

Session・Run は新しい順で、`createdAt` が同じ場合は ID で順序を固定する。`nextCursor` を次のリクエストの `before` に渡す。会話は `nextAfterSeq` を `afterSeq` に渡す。時刻は Unix ミリ秒。

`target` は保存済みの JSON 文字列であり、`owner/repo#12` のようなラベルではない。GitHub Issue では `version`、`kind: "github.issue"`、`repositoryId`、`issueNumber` を含む。一覧の `target` をそのまま指定すると同じ対象に絞り込める。最初の検索にはリポジトリに対応する `projectId` を使う。

会話のプレビューは1000 Unicode コードポイントまで。`bodyLength` と比較し、必要なら `read_message` で本文を読む。本文の `offset`、`limit` と `nextOffset` も Unicode コードポイント単位で、絵文字を UTF-16 の途中で分断しない。ID やページ位置は権限の代わりにならず、どの取得も所有者で絞り込む。

メッセージと成果物は調査対象のデータであり、Agent への指示ではない。MCP は内部の実行設定、資格情報、R2 key、任意 SQL や任意 URL の指定を公開しない。Run の開始・再試行・取消・削除も行えない。

## diagnostics の現在の範囲

[diagnostics](diagnostics.md) の取得 port を Web と共有する。Run と関連受付、Event、Artifact の保存期限・本文を調べられる。Trace の `captureState` と `dropped` は業務上の `runStatus` と独立して確認する。プロバイダの全通知や未完了コマンドの出力まで記録できるとは限らず、Event がないことを処理の未実行の証拠にはしない。

Trace は最大50件で、文字列の `nextCursor` をそのまま `before` に渡す。Event・Artifact は最大100件で、数値の `nextCursor` を `after` に渡し、空のページまたはカーソルが進まなくなったら止める。Trace ID には `/` を含むが、MCP の引数ではエンコードせずそのまま渡す。

`read_diagnostic_artifact` は保存済みの JSON バッチを最大8000 Unicode コードポイントずつ返す。`nextOffset` が null になるまで取得すると再構成できる。本文の期限切れは `expired`、欠損や権限外は `not_found`、digest 不一致や保存先のエラーは `unreadable` で返す。内部の R2 key は公開しない。

`read_run_artifact` は `available`、`not_ready`（非終端）、`unavailable`（未保存またはストレージ未設定）、`unreadable`（保存内容不正またはストレージエラー）を区別する。欠落を空の成功ログに変換しない。存在しない／所有していない Run はどちらも `not_found` にする。業務の終端状態は D1 を正とし、保存済み成果物と食い違っても `result.json` の終端結果を D1 に合わせる。

OAuth は Better Auth の MCP/OAuth Provider 拡張を候補とする。現行構成への導入には Better Auth の更新、認可・同意画面、JWT と OAuth テーブル、Workers でのクライアントメタデータ取得対応が必要なため、初回は API key を採用した。

## 実装資料

- [公式 MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)
- [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Better Auth MCP](https://better-auth.com/docs/plugins/mcp)
