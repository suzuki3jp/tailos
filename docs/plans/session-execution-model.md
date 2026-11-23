# Session 単位の実行モデルへの移行計画

作成日: 2026-11-23。対象: suzuki3jp/tailos#129（実行モデルのリアーキ）と、その前提の suzuki3jp/tailos#131（Codex・Claude の認証情報をコンテナに置かない）。この文書は採択済みの判断に基づく実装計画で、PR は段階ごとに積み重ねる（train）。

## 採択済みの判断

| PDR | 内容 |
| --- | --- |
| [実行モデル](../pdr/records/PDR-20261123-execution-model.md) | Trigger・Routine・Session・Turn・Connector に分ける。出力は Connector、作業中のメッセージは順番待ち |
| [Session 単位の隔離の境界](../pdr/records/PDR-20261123-repository-settings-session-boundary.md) | 隔離の境界を Session のコンテナとファイルシステムにする（PDR-20261114-009 の後継） |
| [作業の引き継ぎ](../pdr/records/PDR-20261123-session-continuity.md) | Session の Durable Object がコンテナを持つ。スナップショットで速く戻し、正本は R2。待機時間は定数で既定 0 |
| [公開ツール](../pdr/records/PDR-20261123-publication-tool.md) | Agent が公開ツールを呼び、API が検査して署名付きコミットと PR を作る。PR は Session ごとに 1 つ |
| PDR-20261122-agent-egress-credential-proxy | 外部通信は常に許可し、GitHub の認証情報はコンテナの外で差し込む（suzuki3jp/tailos#121、実装済み） |

## 現状（2026-11-23 の `main`）

- Run ごとに Durable Object（`RUNNER.getByName(runId)`）がコンテナを起動し、Run が終わると捨てる（`apps/api/src/infrastructure/cloudflare/runner-container.ts`）。
- Codex は `thread/start` に `ephemeral: true` を付け、`CODEX_HOME` を Run ごとの一時ディレクトリに作って消す（`apps/runner/src/codex-agent.ts`）。
- リポジトリを対象にした実装の Run は、終わりに必ず公開（`pushed` か `no_changes`）を返し、`pushed` なら PR を作る。作業ブランチは `tailos/issue-<番号>/<runId>` か `tailos/run/<runId>`。
- 計画会話は `planning_inbox`・`planning_snapshots`・`planning_replies` の専用の経路を持ち、会話全体をジョブに埋め込む（32 KiB の上限）。
- Codex の ChatGPT のアクセストークンと更新用のリース、Claude のトークン、診断の Bearer はコンテナに渡している。
- suzuki3jp/tailos#132 のマージ後に本番で Codex のターンが失敗したが、suzuki3jp/tailos#137 で残すようにした診断記録から、原因は Codex の利用上限で、通信の横取りとは関係ないと分かった。

## train の構成

各 PR は前の PR のブランチを base にする。前の PR がマージされたら、次の PR の base を `main` に付け替える。

| 順 | ブランチ | 内容 | 主な完了条件 |
| --- | --- | --- | --- |
| 1 | `claude/execution-model-pdr` | PDR と計画書（この文書） | `pnpm pdr check` が通る |
| 2 | `claude/agent-credentials-outside` | #131: Codex・Claude の認証情報をコンテナに置かない | 下記 |
| 3 | `claude/session-runner` | Session の Durable Object と順番待ち | 下記 |
| 4 | `claude/session-continuity` | 作業の引き継ぎ（スナップショット、R2、Codex の再開） | 下記 |
| 5 | `claude/publication-tool` | 公開ツールと Session ごとの PR | 下記 |
| 6 | `claude/routine-triggers` | label と計画を Routine に統一し、専用の経路を廃止 | 下記 |

Session 画面からの送信（suzuki3jp/tailos#124）は 6 の後に別の PR で行う。

## 2. 認証情報をコンテナに置かない（#131）

- Codex のモデル API（`chatgpt.com` のバックエンド）と Claude の API（`api.anthropic.com`）への通信を、GitHub と同じく `interceptOutboundHttps()` で Workers 側に受け、Run の認証情報を差し込む。コンテナには置き換え用の値だけを渡す。
- トークンの更新は API 側だけで行う。Runner の更新用リース（`account/chatgptAuthTokens/refresh` の転送）は、置き換え用の値を返すだけにするか廃止する。
- 診断の送信用 Bearer など Runner 自身の秘密は、Agent のコマンドから読めない形にする（別ユーザーでの実行、または Runner の外への移動）。

**先に確かめること**: Codex はモデル API に WebSocket（失敗時は HTTPS）でつなぐ。`interceptOutboundHttps()` で横取りした WebSocket を Workers から中継できるかを、本番の Containers で確かめる。中継できない場合は方針を見直す。

完了条件: コンテナの環境変数・ファイル・プロセスの引数に Codex・Claude のトークンがないこと。置き換え用の値で Codex と Claude のターンが本番で完了すること。

## 3. Session の Durable Object と順番待ち

- Runner の Durable Object を Session 単位にする（`RUNNER.getByName(sessionId)`）。Run（Turn）の状態は引き続き D1 の `runs` に持ち、Durable Object は今の Turn の runId を記録する。
- 順番待ちを Session 共通の仕組みにする（`session_inbox`）。Trigger は Session にメッセージを追加し、進行中の Turn がなければ Turn を作る。Turn が終わったら次のメッセージで Turn を作る。
- 既存の label 起動・Web からの開始は、新しい Session を作って最初のメッセージを追加する形に移す。受付の冪等性・同時実行キーの規則は維持する。
- 移行は、進行中の Run がない状態を運用で作って行う（PDR-20261118-routine-initial-migration と同じ方針）。

完了条件: 同じ Session の Turn が同じ Durable Object で処理される。作業中に追加したメッセージが順に処理される。既存の label 起動と計画会話が回帰しない。

## 4. 作業の引き継ぎ

- コンテナ内の作業領域を固定の場所（例: `/work`）に置く。`CODEX_HOME` は Codex のサンドボックスの書き込み可能な範囲（`writableRoots`）の外に置き、次の Turn に戻すのは rollout（`sessions/` 配下）だけにする。`config.toml` などは Runner が毎回作り直す。`thread/start` から `ephemeral` を外し、threadId を Session に保存して `thread/resume` で続ける。
- Turn の返答を保存した後、`snapshotContainer()` を取り、ID と作成時のイメージの digest を Durable Object に保存する。待機時間は定数（既定 0）で決める。
- 毎 Turn の終わりに rollout と作業ツリーを R2 に保存する。作業ツリーは、基準のコミットと HEAD の SHA、基準から HEAD までのコミット（`git bundle`）、HEAD に対する未コミットの変更と未追跡ファイルを保存する。復元時はスナップショット（digest が一致する場合）を優先し、使えなければ記録した基準のコミットを checkout してから R2 の内容を戻す。
- R2 への保存は数回再試行し、それでも失敗したら Turn は成功のまま Session に「引き継ぎ不可」を記録する。次の Turn で戻せなければ新しい作業ツリーから始め、そのことを Agent と利用者に伝える。
- git メタデータの改ざん検知の基準（今の `trustedConfig`）を Session 側に持ち、復元のたびに比べる。
- Codex の再開を CI 相当で確かめるテスト（別プロセスで threadId から再開できること）を追加する。

完了条件: 続きのメッセージで、前の Turn の作業ツリー（Agent のコミットを含む）と Codex の会話が戻る。イメージを更新した後も R2 から戻せる。Agent のコマンドが書いた Codex の設定が次の Turn で読まれない。

## 5. 公開ツールと Session ごとの PR

- Codex の dynamic tool（Claude は MCP）として公開ツールを追加する。Runner が今の検査を行って API に預け、API が署名付きコミットを作る。
- 作業ブランチを Session ごと（例: `tailos/session/<sessionId>`）にし、2 回目以降は同じブランチにコミットを足して PR を更新する。PR がマージ済みなら次の Turn の始めに作業ツリーを既定ブランチの最新に合わせ、新しい作業ブランチで PR を作る。マージせずに閉じていれば同じブランチ（削除済みなら作業ツリーの先頭から作り直す）で新しい PR を作る。
- Turn の終わりに必ず公開する作りをやめる。label 起動の既定のプロンプトに公開の指示を入れる。
- 置き換える判断: Run の結果として PR を保存する既存の判断。

完了条件: 公開ツールで PR を作成・更新できる。公開しない Turn が成功で終わる。既存の検査（tree・署名・既定ブランチの保護）が維持される。

## 6. label と計画を Routine に統一

- 計画会話を「`issue_comment` の Trigger、読み取り専用の権限、計画を返すプロンプト」の Routine に移す。返信は Agent が gh（Connector）で Issue にコメントする。
- `planning_inbox`・`planning_snapshots`・`planning_replies` と Issue への受付通知の扱いを、Session の順番待ちと Connector に置き換える。
- 置き換える判断: 計画会話の永続化（PDR-20261113-012 ほか）、Issue への通知（PDR-20261113-006）。後継 PDR を用意する。

完了条件: `@tailos plan` と label 起動が Routine として動き、専用の経路を使わない。

## 検証

各 PR で CI と同じ `pnpm format:check`、`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm --filter @tailos/web run build` を通す。PDR を変えた PR では `pnpm pdr catalog --write` と `pnpm pdr check` を通す。本番の Cloudflare での確認が必要な段階（2、4）は、deploy の前にユーザーに確認する。
