---
schema: 1
id: PDR-20261128-session-continuity-branches
key: session.continuity
status: accepted
date: "2026-11-28"
areas: [sessions, agent, infrastructure]
keywords: [作業の引き継ぎ, Session, コンテナ, スナップショット, snapshotContainer, containerSnapshot, 復元, R2, rollout, thread/resume, CODEX_HOME, Claude Code, CLAUDE_CONFIG_DIR, resume, session_id, 待機時間, イメージ, digest, 30 日, 公開ベータ, ローカルブランチ, git bundle, git の設定, HEAD, shallow]
paths:
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/codex-agent.ts
  - apps/runner/src/claude-agent.ts
  - apps/runner/src/continuity.ts
  - apps/runner/src/git-workspace.ts
  - docs/plans/session-execution-model.md
symbols: [RunnerContainer, snapshotContainer, containerSnapshot, encodeSavedWork, decodeSavedWork]
supersedes: [PDR-20261126-session-continuity-claude]
decided_by: suzuki3jp
---

# Session の作業はコンテナのスナップショットと R2 の保存で引き継ぎ、ローカルブランチと git の設定も戻す

## 決定

- **実行環境の持ち主**: Session ごとの Durable Object がコンテナを持つ。同じ Session の Turn は同じ Durable Object で処理する。
- **待機時間**: Turn の返答を保存した後、コンテナを待機させずに眠らせる。待機時間はコードの定数 1 つで決め、既定は 0 とする。定数を変えるだけで数分待機できる作りにする。
- **スナップショット**: 眠らせる前に Cloudflare Containers のスナップショット（`snapshotContainer()`）でファイルシステムを保存し、次の Turn は `start({ containerSnapshot })` で復元する。作成時のイメージの digest を一緒に記録し、復元前に今のイメージと比べて違えば使わない。
- **正本は R2**: Agent の会話状態（Codex の rollout、Claude Code のセッションの記録）と作業ツリーの変更は、毎 Turn の終わりに R2 にも保存する。スナップショットは速く戻すためのキャッシュとして扱い、使えないとき（イメージの更新後、期限切れ、障害）は R2 から戻す。
- **Agent の会話**: Codex の thread は会話を保存する設定（`ephemeral` なし）で始め、次の Turn では threadId を指定した `thread/resume` で続ける。認証情報は再開のたびに渡し直す。
- **Claude の会話**: Claude Code は会話を保存する設定で動かし、Turn の終わりにそのセッションの記録（`CLAUDE_CONFIG_DIR` の `projects/` 以下の JSONL）を保存する。次の Turn では記録を同じ相対パスに戻し、そのセッション ID を `resume` に指定して続ける。記録が戻せない、または再開できないときは、新しい会話で始め、前の会話が使えないことを Agent と利用者に伝える。
- **Codex の設定は持ち越さない**: `CODEX_HOME` は Agent のコマンドが書き込める範囲（サンドボックスの書き込み可能な領域）の外に置く。次の Turn に戻すのは会話記録（rollout）だけで、`config.toml` などの設定は Runner が毎回作り直す。
- **R2 への保存に失敗したとき**: 数回再試行する。それでも失敗したら Turn は成功のまま（返答は届ける）、Session に「引き継ぎ不可」を記録する。次の Turn でスナップショットからも戻せなければ、新しい作業ツリーから始め、前の作業を引き継げなかったことを Agent と利用者に伝える。

## 理由

PoC（2026-11-22、本番の Cloudflare で計測）で次を確かめた。

- スナップショットから作業ツリー・依存・一時領域を戻せた。復元から応答まで 0.45〜0.7 秒、作成は約 6 秒、2 回目以降は差分だけを保存する。
- Codex 0.166.0 は、同じ相対パスに置いた rollout から別プロセスで `thread/resume` でき、会話履歴とツールも戻る。認証情報はディスクに書かれない。
- Claude Code 2.1.319（Agent SDK 0.3.319）は、別の `CLAUDE_CONFIG_DIR` に置き直したセッションの記録から `resume` で再開でき、前の依頼と返答がモデルへの要求に含まれる（2026-11-26、ローカルで確認）。記録が見つからないときは「No conversation found」の結果で終わる。
- イメージを更新した後に古いスナップショットを復元すると、エラーにならず古いイメージのまま起動した。

復元が 1 秒未満なので、待機して起動を速くする利点は小さい。standard-3 の待機は 1 Session あたり約 $0.076/時かかり、開いたままの Session が増えるほど費用が増えるため、既定では待機しない。将来の利用状況に合わせて調整できるよう、待機時間は定数にしておく。

スナップショットは公開ベータで、削除できず、イメージに縛られ、30 日で消える。これだけに頼ると Runner の更新や期限切れで作業を失うので、正本は R2 に置く。イメージが違うスナップショットを黙って使うと古い Runner で動くので、digest を比べる。

Agent が git でブランチを切り、コミットし、push するようになった（[作業の公開の判断](PDR-20261128-agent-git-publication.md)）。HEAD までのコミットだけを保存すると、HEAD にないブランチの作業が次の Turn で消える。`git push -u` や `git config` は git の設定を書き換えるので、設定を引き継がないと追跡ブランチや作者の設定が Turn ごとに戻る。以前は設定が変わっていたら保存をやめていたが、Agent が git を使うと保存がほぼ毎回失敗する。

浅い取得の境界を bundle から除くのは、境界より前の履歴が手元になく、bundle に入れても次の Turn で繋がらないためである。境界のコミットは GitHub から取得したものなので、復元のときに取り直せる。

## 範囲と例外

対象はリポジトリを持つ Session の Turn。作業ツリーの R2 保存には、次を含める。依存などは R2 からの復元時に作り直す。

- 基準のコミット（Session の最初の Turn で checkout した既定ブランチの SHA）と、その時点の HEAD。HEAD がブランチを指していればそのブランチ名も残す。
- すべてのローカルブランチ（`refs/heads/` 以下）の位置と、そこから辿れるコミット。基準のコミットと、浅い取得の境界のコミット（`.git/shallow` に載るもの）より前は含めない。`git bundle` で保存する。リモート追跡ブランチ（`refs/remotes/` 以下）は保存しない。
- HEAD に対する未コミットの変更と未追跡のファイル（`.gitignore` の対象を除く）。
- 作業ツリーの git の設定ファイル（Agent が `git config` やブランチの追跡設定で変えた内容を含む）。

復元は記録した基準のコミットを checkout し、bundle が必要とするコミット（基準のコミットと浅い取得の境界）を GitHub から取り直してから、保存したブランチ・HEAD・変更・git の設定を戻す。既定ブランチの最新から戻すことはしない。PR がマージされても作業ツリーを動かさない（[作業の公開の判断](PDR-20261128-agent-git-publication.md)）。Claude Code の `CLAUDE_CONFIG_DIR` も Agent のコマンドが書き込める範囲の外に置き、次の Turn に戻すのはセッションの記録だけとする。

Agent は git の管理ディレクトリに書き込めるので、Runner 自身の git 操作（保存・復元）は Agent の設定を使わない。操作の間だけ Runner が作った設定に置き換え、終わったら Agent の設定に戻す。Agent の設定は中身を解釈しないデータとして保存する。管理ディレクトリが別の場所の設定を読む形（`commondir` がある）になっていたら、作業を保存せず引き継ぎ不可とする。

以前の形式で保存された作業（ローカルブランチと git の設定を持たない）は、HEAD を基準のコミットから続くブランチのない状態で戻し、git の設定は Runner が作り直す。PR のマージ後に載せ直せずに残した作業の参照（`refs/tailos/unpublished`）は、Agent が消すまで引き継ぐ。

Codex が対象リポジトリの設定を読まない（[Session 単位の隔離の境界の判断](PDR-20261123-repository-settings-session-boundary.md)）ことを、2 回目以降の Turn でも保つ。そのため Agent のコマンドが Codex の設定を書けない配置にし、書けたとしても次の Turn では使わない。

スナップショットは削除できないため、Session を削除しても作業ツリーと会話を含むスナップショットが最大 30 日残ることを受け入れる。コンテナに認証情報を書かない方針を守る。R2 に置く会話と作業ツリーは Session と同じ扱いのデータとし、Session の削除に合わせて消す。

スナップショットの作成中は次のメッセージの処理を待たせる（順番待ちは [実行モデルの判断](PDR-20261123-execution-model.md) に従う）。スナップショットの作成・復元に失敗しても Turn の結果は失敗にせず、次の Turn で R2 から戻す。

## 選択肢と影響

- **コンテナを常時起動する案**: 引き継ぎは最も単純だが、Session 数に比例して費用がかかる（1 Session 約 $55/月）。採用しない。
- **スナップショットを使わず R2 だけで戻す案**: 削除できないデータが残らないが、毎回 checkout と依存の取得が必要で遅い。採用しない。

不利益として、公開ベータの仕様変更の影響を受ける。Runner を更新するたびに、各 Session の次の Turn は R2 からの復元を通るので遅くなる。
