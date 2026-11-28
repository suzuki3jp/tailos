# アーキテクチャ改善の記録

[現行の責務と状態の所有権](README.md)と [依存関係のベースライン](dependencies.md)は `ac21639` の調査から作成した。ここには実装に進む候補と保留理由を記録する。

変更前の `ac21639` で `pnpm format:check`、`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm --filter @tailos/web run build` の成功を確認した。

## 改善タスク

| 状態 | 領域 | 確認した重複・境界・次の判定 |
| --- | --- | --- |
| 完了 | Web の状態・データ取得・エラー | Home、Routine、Project の Session 詳細を Shared API のエラー変換に移行した。[ラウンド 1](#ラウンド-1-web-の初期取得エラー)を参照。 |
| 完了 | API データ契約と共通インフラ | Project と Session のカーソルを共通の転送形式に移行した。[ラウンド 2](#ラウンド-2-一覧-api-のカーソル)を参照。 |
| 完了 | API モジュール境界 | `Bindings` を RPC 契約の所有者にし、具象 Durable Object との型循環を解消した。[ラウンド 3](#ラウンド-3-cloudflare-bindings-の依存方向)を参照。 |
| 完了 | ドメインとデータアクセス | Run の状態と進行中の判定を Core に集約した。[ラウンド 4](#ラウンド-4-run-の状態と進行中の判定)を参照。 |
| 要調査 | API と Runner の設定・認証 | `bindings.ts`、Wrangler、deploy scripts、Egress に設定が分かれる。デプロイ入力と実行時の binding を照合する。生存期間が異なるログイン、MCP、Provider、Turn の資格情報は個別契約を前提とする。 |
| 完了 | ログと可観測性 | Codex と Claude が GitHub 取得の診断と Agent 向け結果の変換を共有。[ラウンド 5](#ラウンド-5-runner-の-github-取得診断)を参照。診断の収集・保存・再送はそれぞれの保証を持つ。 |
| 実施候補 | Runner の Adapter と共通処理 | Codex と Claude のコマンド環境のディレクトリ・変数が重複。プロバイダー固有の認証・会話状態と分かれた環境として共通化する。 |
| 要調査 | UI と命名 | Shared のデザインシステム、共通 PageShell、互換用の管理画面で異なるレイアウトの入口がある。既存ルート・PDR の適用範囲を根拠に、再利用できる同責務の部品だけを確認する。 |
| 要調査 | テスト・ビルド | Vitest 設定、パッケージ scripts、モノレポでの型検査の繰り返しを確認する。Worker ビルド、Runner バンドル、Preview の公開用ビルドは異なる成果物を持つ。 |
| 確認待ち | Run 実行とストレージの大きな再設計 | `runner-container.ts` は Run 進行、継続、Egress リース、診断の責務を併せ持つ。DO クラス・ストレージキー・責務の所有者を移す場合は、継続中 Session の移行とロールバックを人間と確認するまで保留する。 |
| 確認待ち | 管理画面や外部契約の廃止 | 旧管理画面のルート、直通 API と smoke 経路、保存済み Run の結果形式には現行の呼び出しや互換性要件がある。廃止・URL 変更は利用実態と後継契約の合意が必要。 |
| 実施候補 | 設計資料の現行化 | 初期設計には Run 単位 DO、旧の計画データ、公開手順の記述が残る。現行の [PDR](../pdr/README.md) とコードで根拠を確かめ、デプロイ手順から参照されている段階や移行履歴を調べてから更新する。 |

## 各ラウンドに残す事項

選んだ方法と代替案、削除した実装、実際の呼び出し元、維持する外部契約、参照した PDR、再導入を防ぐ検査、レビューと検証の結果を記録する。プロダクト上の選択は [PDR の運用](../pdr/README.md) を使う。内部設計の判断はここに残す。

## ラウンド 1 Web の初期取得エラー

- **比較と決定**。各画面がエラー形式を管理する方式、全画面の prefetch を共通の実行関数に入れる方式、変換だけを Shared API に集約する方式を比較した。変換を削除すると失敗状態の保持と詳細の除去が三つの呼び出し元に戻るため、変換を共有した。取得対象・並列化・Home の期限・cache の寿命は各呼び出し元で管理する。
- **移行**。`prefetchNavigation`、`prefetchRoutines`、`prefetchProjectSession` を同じ変換に移行した。四つあった status 抽出を一つにし、Home と Routine の抽出専用ファイルを削除した。
- **契約と検証**。エラーの公開名・文言、既知の HTTP status、不明時の省略または null を従来どおりにした。独立した差分確認で三つの server 入口と表示側を追った。共有の回帰テストが、成功値、pending の除外、二つのエラーフィールドの安全な変換、サーバー cache の非変更を確認する。Home の既存テストが期限と再試行を確認する。
- **参照した判断**。[初期取得の期限](../pdr/records/PDR-20261118-home-prefetch-deadline.md)、[Routine の画面](../pdr/records/PDR-20261128-routine-pages.md)、[Session のリアルタイム配信](../pdr/records/PDR-20261121-session-realtime-transport.md)。内部実装の整理で、新しいプロダクト判断は発生しなかった。
- **結果**。CI と同じ四つの検証、Web Worker ビルド、差分の空白検査が成功した。

## ラウンド 2 一覧 API のカーソル

- **比較と決定**。Project と Session が変換を個別に持つ方式、一覧のリクエスト全体を抽象化する方式、トークンの変換だけを共有する方式を比較した。UTF-8 JSON と Base64URL の変換を一つにし、位置のスキーマ、版、クエリの解釈、並び順の責務は各一覧に置いた。共有実装を削除するとトークンの変換が両方に戻る。
- **移行**。Project 一覧と、アカウントおよび Project スコープの Session 一覧を新しい関数に移行した。局所的な二つの変換を削除し、復号後は各入口の Valibot スキーマが検証する。
- **契約と検証**。旧形式のトークンを明示する回帰テストを先に通した。Unicode の Project 名と同じ日時の Session をページングし、旧トークンを受け付けて同じトークンを発行することを API 経由で確認した。差分レビューで malformed cursor の 400 と所有者条件も確認した。
- **参照した判断**。[Project 一覧](../pdr/records/PDR-20261116-project-account-list.md)、[Session 一覧](../pdr/records/PDR-20261116-session-list-contract.md)。新しいプロダクト判断は発生しなかった。
- **結果**。CI と同じ四つの検証、Web Worker ビルド、差分の空白検査が成功した。

## ラウンド 3 Cloudflare Bindings の依存方向

- **比較と決定**。ランタイムから消える型循環を許容する方式、具象クラスごとに環境型を切る方式、`Bindings` に必要な RPC の型を宣言する方式を比較した。呼び出し側と実装が一つの短い契約を参照する方法を採用した。この契約を除くと呼び出し側は再び実装クラスを参照する。
- **移行**。Runner の受付、ヘルスチェック、診断、Egress と SessionStream の通知が必要とする型を定義した。R2 の形も既存の型を移し、以前の宣言を削除した。DO の名前、メソッド、ストレージキー、通信経路は既存の構成で動く。
- **契約と検証**。DO 実装の `implements` と TypeScript が RPC を照合する。Oxlint が `Bindings` から infrastructure への型 import を拒否し、許可される application と Workers の型をテストした。差分レビュー後の構文解析でファイル単位の循環は実行時・型参照とも 0 件だった。
- **参照した判断**。[Session の継続](../pdr/records/PDR-20261128-session-continuity-branches.md)、[Session のリアルタイム配信](../pdr/records/PDR-20261121-session-realtime-transport.md)。新しいプロダクト判断は発生しなかった。
- **結果**。CI と同じ四つの検証、Web Worker ビルド、Preview API Worker の Wrangler dry-run、差分の空白検査が成功した。

## ラウンド 4 Run の状態と進行中の判定

- **比較と決定**。API だけで状態を共有する方式、SQL の結果を Web へ追加する方式、既存の状態値と進行中の部分集合を Core に置く方式を比較した。API と Web が同じ状態と判定を参照し、D1 が同じ一覧から SQL を生成する方法を採用した。Runner 内部の応答は待機中の Run を表さないため、既存の別契約を使う。
- **移行**。Run 実行・Session 一覧・照会の型、MCP のバリデーション、D1 の受付・復旧・診断・スキーマ、Web の Session 詳細の判定を移行した。保存済みの状態値と既存 migration は引き継ぐ。
- **契約と検証**。変更前後の Drizzle 出力で 25 テーブルの SQL が一致した。D1 の実マイグレーションを適用するテストで Run の CHECK と三つの部分インデックスを照合した。差分レビューで SQL のリテラル、MCP の入力値、Web の再取得の条件を確認した。
- **参照した判断**。[実行モデル](../pdr/records/PDR-20261123-execution-model.md)、[Issue の順番待ち](../pdr/records/PDR-20261124-issue-routine-dispatch.md)、[Session への送信](../pdr/records/PDR-20261126-session-message-provider.md)。新しいプロダクト判断は発生しなかった。
- **結果**。CI と同じ四つの検証、Web Worker ビルド、API Worker の Wrangler dry-run（コンテナのビルドを省略）、差分の空白検査が成功した。

## ラウンド 5 Runner の GitHub 取得診断

- **比較と決定**。Adapter ごとに診断を維持する方法、汎用 span API を変更する方法、GitHub 取得の入口で診断して Agent 用の結果を返す方法を比較した。GitHub Reader と同じモジュールに置き、取得の診断理由を結果から除く責務を共有した。
- **移行**。Codex の RPC と Claude の MCP から同じ関数を呼ぶようにした。各 Adapter はプロトコル、ツール名、対象 Turn の照合を所有する。二つの診断・結果変換を削除した。
- **契約と検証**。Claude の回帰テストを変更前に通し、編集後の Issue 本文をツール結果にも診断本文にも入れず、診断属性に `issue_changed` が残ることを確認した。既存の Codex テストは取得・再試行・診断失敗・診断理由の除去を通す。レビューでは両 Adapter のツール公開条件と診断データを確認した。
- **参照した判断**。[Routine の Issue 参照](../pdr/records/PDR-20261124-routine-github-context.md)、[Runner の失敗診断](../pdr/records/PDR-20261119-runner-failure-diagnostics.md)。新しいプロダクト判断は発生しなかった。
- **結果**。CI と同じ四つの検証、Web Worker ビルド、差分の空白検査が成功した。Runner のテストに本番バンドルの起動確認を含む。
