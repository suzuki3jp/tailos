# Session 単位の実行モデルへの移行計画

作成日: 2026-11-23。対象: suzuki3jp/tailos#129（実行モデルのリアーキ）と、その前提の suzuki3jp/tailos#131（Codex・Claude の認証情報をコンテナに置かない）。この文書は採択済みの判断に基づく実装計画で、PR は段階ごとに積み重ねる（train）。

## 採択済みの判断

| PDR | 内容 |
| --- | --- |
| [実行モデル](../pdr/records/PDR-20261123-execution-model.md) | Trigger・Routine・Session・Turn・Connector に分ける。出力は Connector、作業中のメッセージは順番待ち |
| [Session 単位の隔離の境界](../pdr/records/PDR-20261123-repository-settings-session-boundary.md) | 隔離の境界を Session のコンテナとファイルシステムにする（PDR-20261114-009 の後継） |
| [作業の引き継ぎ](../pdr/records/PDR-20261123-session-continuity.md) | Session の Durable Object がコンテナを持つ。スナップショットで速く戻し、正本は R2。待機時間は定数で既定 0 |
| [公開ツール](../pdr/records/PDR-20261124-publication-tool.md) | Agent が公開ツールを呼び、API が検査して署名付きコミットと PR を作る。Session が同時に開く PR は 1 つ。マージ後は未公開の作業を既定ブランチの最新に載せ直す（PDR-20261123-publication-tool の後継） |
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
| 3 | `claude/session-runner` | Session の Durable Object と Turn の順番待ち | 下記 |
| 4 | `claude/session-continuity` | 作業の引き継ぎ（R2、Codex の再開） | 下記 |
| 4b | `claude/session-snapshot` | スナップショットでの高速な復元 | 下記 |
| 5 | `claude/publication-tool` | 公開ツールと Session ごとの PR | 下記 |
| 5b | `claude/publication-after-merge` | マージ後の載せ直し | 下記 |
| 5c | 未定 | 始点の検査 | 下記 |
| 6 | `claude/routine-triggers` | label と計画を Routine に統一し、専用の経路を廃止 | 下記 |

Session 画面からの送信（suzuki3jp/tailos#124）は 6 の後に別の PR で行う。

## 2. 認証情報をコンテナに置かない（#131）

判断: [Codex のモデル API の認証情報をコンテナに置かない](../pdr/records/PDR-20261123-model-credentials-outside.md)。

- Codex のモデル API（`chatgpt.com`）への通信を、GitHub と同じく `interceptOutboundHttps()` で Workers 側（`ModelEgress`）に受け、Run の接続の現在のアクセストークンを差し込む。コンテナにはアカウントとプランだけを持つ置き換え用のトークンを渡す。
- トークンの更新は API 側だけで行う。モデル API が 401 を返したら拒否されたアクセストークンを記録し、次の通信の前に更新する。Runner がトークンを更新する経路は廃止する。
- Claude は今の API ではまだ Run を起動しないので、Claude を有効にする段階（suzuki3jp/tailos#60）で `api.anthropic.com` に同じ方式を適用する。
- Runner 自身の秘密（公開のリース、診断の Bearer、制御用の鍵）を Agent のコマンドから隔離する方法は後続とする。

**deploy 後に確かめること**: Codex はモデル API に WebSocket（失敗時は HTTPS）でつなぐ。横取りした WebSocket を Workers から中継でき、Codex のターンが本番で完了すること。

完了条件: Runner に渡すジョブ・環境変数に Codex の本物のトークンが含まれないこと。置き換え用のトークンで Codex のターンが本番で完了すること。

## 3. Session の Durable Object と順番待ち

- Runner の Durable Object を Session 単位にする（`RUNNER.getByName(sessionId)`）。Run（Turn）の状態は引き続き D1 の `runs` に持ち、Durable Object は今の Turn の runId を記録する。Run の予約・回復・公開の検査・診断の受け取り・通信の横取りは、Run の Session の Durable Object に届ける。
- Durable Object は同じ Session の Run を 1 つずつ処理する。進行中の Run があれば次の Run を Durable Object の中で順番待ちにし、終わった Run の状態（リース、横取りの停止、制御用の鍵）を消してから次を始める。診断のリースは遅れて届く記録のために Run ごとに分け、期限が切れたら消す。
- 既存の label 起動・Web からの開始は、今と同じく新しい Session を作って最初のメッセージを追加する。受付の冪等性・同時実行キーの規則は変えない。
- Session 共通のメッセージの順番待ち（`session_inbox`）は、既存の Session にメッセージを足す経路を置き換える段階 6 で入れる。今その経路は計画会話だけで、`planning_inbox` が Session ごとに 1 つずつ Run を作っている。
- 移行は、進行中の Run がない状態を運用で作って行う（PDR-20261118-routine-initial-migration と同じ方針）。Durable Object の名前が変わるため、移行前に始まった Run は新しい Durable Object から続けられない。

完了条件: 同じ Session の Turn が同じ Durable Object で処理される。前の Turn が終わる前に予約された Turn は、前の Turn の状態が消えてから始まる。既存の label 起動と計画会話が回帰しない。

## 4. 作業の引き継ぎ（R2 と Codex の再開）

正本である R2 での引き継ぎを先に入れ、スナップショットによる高速化は 4b に分ける。スナップショットは公開ベータで削除できないため、R2 だけで正しく動くことを先に確かめる。

- Codex の `thread/start` から `ephemeral` を外し、Turn の終わりに rollout（`CODEX_HOME/sessions/` 配下）を取り出す。次の Turn は同じ相対パスに rollout を置き、threadId を指定した `thread/resume` で続ける。`CODEX_HOME` は今どおり Codex のサンドボックスの書き込み可能な範囲（`writableRoots`）の外に毎回作り、戻すのは rollout だけにする。
- 作業ツリーは、HEAD の上に作業ツリー全体（未コミットの変更と未追跡のファイル、`.gitignore` の対象を除く）を載せたコミットを作り、基準のコミットからの `git bundle` にする。rollout と合わせて 1 つの圧縮した保存にまとめる（[上限などの判断](../pdr/records/PDR-20261124-session-continuity-limits.md)）。
- Session の Durable Object は、Turn の終わりにコンテナを捨てる前に Runner から保存を受け取り、R2（`sessions/v1/<sessionId>/continuity/<runId>`）に置いて、基準のコミットとともに記録する。次の Turn は記録した基準のコミットで checkout し、ジョブの前に保存を Runner に渡す。
- 保存に失敗したら再試行し、それでも駄目なら「引き継ぎ不可」を記録する。次の Turn は基準のコミットから始め、Agent にはプロンプトで、利用者には Timeline の実行ステージ（`continuity`）で伝える。Turn が作業ツリーに届かなかった場合は前の保存を残す。
- 計画会話は対象外とし、段階 6 で Routine に移すときに扱う。

完了条件: 続きのメッセージで、前の Turn の作業ツリー（Agent のコミットを含む）と Codex の会話が戻る。失敗した Turn の作業も戻る。Runner を更新した後も R2 から戻せる。Agent のコマンドが書いた Codex の設定が次の Turn で読まれない。

## 4b. スナップショットでの高速な復元

- 作業ツリーと git メタデータをコンテナ内の固定の場所（`TAILOS_WORK_DIR=/work` の `repo` と `git`）に置き、Turn の後も消さない。`CODEX_HOME` は今どおり Turn ごとに作り直し、会話は R2 の保存から戻す。
- Turn の保存の後に `snapshotContainer()` を取り、ID と作成時のイメージを R2 の保存の記録と組にして Durable Object に置く。次の Turn はイメージが今と同じならスナップショットから起動し、復元後の `inspect()` でもイメージを確かめる。使えなければイメージから起動する。
- R2 の保存は毎回 Runner に渡す。Runner は、その場の作業ツリーが保存とまったく同じ（基準のコミット、HEAD、ファイル、git の設定）ときだけそのまま使い、違えば R2 から戻す。git の設定を信頼する基準（ハッシュ）は R2 の保存に入れて Session 側に持つ。
- 待機時間は `sessionIdleMs`（既定 0）で決める。0 より大きいと、Turn の後にコンテナを破棄せずに待たせ、次の Turn が同じコンテナで続く。待機中のコンテナを使う後の Turn のために、横取りの Worker は Session の今の Run の認証情報を問い合わせる。
- 本物の Codex CLI（`@openai/codex` を Runner の devDependency にする）で、別のプロセス・別の作業ディレクトリから rollout だけで thread を再開できることを確かめるテストを追加する。

完了条件: 同じイメージの間はスナップショットから戻り、イメージを更新した後は R2 から戻る。その場の作業ツリーは git の設定が変わっていれば使わない。

## 5. 公開ツールと Session ごとの PR

- Codex の dynamic tool（`tailos_publish`）として公開ツールを追加する。Claude はまだ Run を始められないので、MCP での提供は Claude の実行を入れるときに行う。Agent は Conventional Commits の見出しを渡して呼ぶ。Runner が作業ツリー全体を、Session のブランチの先頭（最後に公開したコミット、なければ基準のコミット）からの変更として今の検査にかけ、API（`POST /_runner/runs/:runId/publish`）に渡す。Session の Durable Object が署名付きコミットを作り、PR を作るか、開いている PR にコミットを足して、PR の URL とコミットを Agent に返す。Agent は結果を待ってから続ける。
- 公開した後は、Runner が作業ツリーの HEAD を公開したコミットに移す（ファイルはそのまま）。次の公開はその上に積む。
- 作業ブランチを Session ごと（`tailos/session/<sessionId>`）にし（同時に開くのは 1 つ。Agent が git や gh でブランチ・コミット・PR を作ることを正式に認めるときに撤廃する）、2 回目以降は同じブランチにコミットを足して PR を更新する。マージせずに閉じていれば同じブランチ（削除済みなら最後に公開したコミットから作り直す）で新しい PR を作る。
- Durable Object は Session が最後に公開したコミットと PR を保存し、次の Turn のジョブに `publishedSha` として渡す。引き継いだ作業を戻せなかった Turn も、そのコミットから始める。同じ変更が応答の喪失で 2 回届いても、コミットは 1 回だけ作る。
- Turn の終わりに必ず公開する作りをやめる。Run の結果は、その Turn で最後に公開した PR か、公開しなければ `no_changes` とする。返答の `headline` はなくす。label 起動の Run（Issue から始まる作業）には、変更を公開してから終えるようプロンプトで指示する。
- PR がマージ済みのときは、この段階では公開を断り、Agent に利用者へ伝えさせる。載せ直しは 5b で行う。
- 置き換える判断: Run の結果として PR を保存する既存の判断。
- 既に始まった Session の会話は、再開しても公開ツールを持たない（dynamic tool は thread の開始時に決まる）。この段階のデプロイ前に始まった Session は、新しい Session で公開する。

完了条件: 公開ツールで PR を作成・更新できる。公開しない Turn が成功で終わる。既存の検査（tree・署名・既定ブランチの保護）が維持される。

## 5b. マージ後の載せ直し

- Turn を始めるとき、Session が最後に公開したブランチの PR を確かめる。マージ済みなら、次の連番の作業ブランチ（`tailos/session/<sessionId>-2`、`-3`）に移り、作業ツリーを既定ブランチの最新から始める。PR を読めなければ、次の Turn でもう一度確かめる。
- 前の Turn の保存は、それ自体の基準のコミットの上に戻してから載せ直す（ジョブの `checkout.realign`）。最後に公開したコミットから作業ツリー全体までの差分（ローカルのコミットと未コミットの変更）を、既定ブランチの最新に `git apply --3way` で当て、未コミットの変更として残す。Runner の git は 2.39 なので、`merge-tree --merge-base` は使わない。
- 競合したら既定ブランチの最新から始め、未公開の作業は `refs/tailos/unpublished` に残す。Agent には、載せ直したこと、または競合して残した場所と比べ方を伝え、利用者に知らせるよう指示する。残した参照は、公開した tree の根のコミットとその上の作業ツリーのコミットからなり、他のコミットを前提にしないので保存の bundle に入れて後の Turn に持ち越す。Agent が `git update-ref -d` で消すまで残す。
- 載せ直した作業を保存できたら（または保存できなかったら）、以後の Turn は載せ直さない。保存を始める前に終わった Turn の後は、次の Turn がもう一度載せ直す。
- Turn の途中で PR がマージされたら、その Turn では公開を断り、次の Turn で載せ直す。

完了条件: マージ後の Turn で未公開の作業が載せ直され、競合しても失われない。

## 5c. 始点の検査

- 始点は既定であり、プロンプトで頼まれれば Agent が Turn の中で checkout などで動かしてよい。公開ツールの検査は、Turn の始めに checkout したコミットとの照合をやめ、公開するときの HEAD が対象リポジトリのコミットの上にあることを確かめる形にする。PR の基準もその始点に合わせる。
- 始点のブランチを PR の base にどう選ぶかは未決。実装の前に人間と決める。

## 6. label と計画を Routine に統一

- 計画会話を「`issue_comment` の Trigger、読み取り専用の権限、計画を返すプロンプト」の Routine に移す。返信は Agent が gh（Connector）で Issue にコメントする。
- Session 共通のメッセージの順番待ち（`session_inbox`）を入れる。Trigger は Session にメッセージを追加し、進行中の Turn がなければ Turn を作る。Turn が終わったら次のメッセージで Turn を作る。
- `planning_inbox`・`planning_snapshots`・`planning_replies` と Issue への受付通知の扱いを、Session の順番待ちと Connector に置き換える。
- 置き換える判断: 計画会話の永続化（PDR-20261113-012 ほか）、Issue への通知（PDR-20261113-006）。後継 PDR を用意する。

完了条件: `@tailos plan` と label 起動が Routine として動き、専用の経路を使わない。

## 検証

各 PR で CI と同じ `pnpm format:check`、`pnpm lint`、`pnpm test`、`pnpm typecheck`、`pnpm --filter @tailos/web run build` を通す。PDR を変えた PR では `pnpm pdr check` を通す。本番の Cloudflare での確認が必要な段階（2、4、4b）は、deploy の前にユーザーに確認する。
