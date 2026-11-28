# アーキテクチャ改善の記録

[現行の責務と状態の所有権](README.md)と [依存関係のベースライン](dependencies.md)は `ac21639` の調査から作成した。ここには実装に進む候補と保留理由を記録する。

変更前の `ac21639` で `pnpm format:check`、`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm --filter @tailos/web run build` の成功を確認した。

## 改善タスク

| 状態 | 領域 | 確認した重複・境界・次の判定 |
| --- | --- | --- |
| 完了 | Web の状態・データ取得・エラー | Home、Routine、Project の Session 詳細を Shared API のエラー変換に移行した。[ラウンド 1](#ラウンド-1-web-の初期取得エラー)を参照。 |
| 実施候補 | API データ契約と共通インフラ | Project と Session のカーソルは同じ UTF-8 JSON / Base64URL の変換を別々に実装。位置・版・並び順・不正クエリの規則はリソース固有。転送表現だけの共有と既発行トークンの互換性を検証する。 |
| 実施候補 | API モジュール境界 | `Bindings` が具象 Durable Object の型を取り込み、型依存が循環している。実際の RPC 呼び出しを調べ、必要な型契約だけ公開する構成と具象型が自動で追従する構成を比較する。 |
| 要調査 | ドメインとデータアクセス | Run の状態集合が application の型、Drizzle、SQL、Web の判定に現れる。過去 migration と部分インデックスに関わるリテラルを確認し、実行時の型と判定の共有範囲を決める。 |
| 要調査 | API と Runner の設定・認証 | `bindings.ts`、Wrangler、deploy scripts、Egress に設定が分かれる。デプロイ入力と実行時の binding を照合する。生存期間が異なるログイン、MCP、Provider、Turn の資格情報は個別契約を前提とする。 |
| 要調査 | ログと可観測性 | Runner の収集と API の検査・保存で共通 redactor を利用。イベントの表現と再試行を比較するときは、配送の保証と保存の保証を別々に追う。 |
| 要調査 | Runner の Adapter と共通処理 | Codex と Claude が prompt・Turn 手順を共有し、各 Adapter が SDK と会話の復元を実装。共通化は再開失敗・診断・作業状態が同じ箇所から判断する。 |
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
