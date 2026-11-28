---
schema: 1
id: PDR-20261126-session-continuity-claude
key: session.continuity
status: superseded
date: "2026-11-26"
areas: [sessions, agent, infrastructure]
keywords: [作業の引き継ぎ, Session, コンテナ, スナップショット, snapshotContainer, containerSnapshot, 復元, R2, rollout, thread/resume, CODEX_HOME, Claude Code, CLAUDE_CONFIG_DIR, resume, session_id, 待機時間, イメージ, digest, 30 日, 公開ベータ]
paths:
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/codex-agent.ts
  - apps/runner/src/claude-agent.ts
  - apps/runner/src/continuity.ts
  - apps/runner/src/git-workspace.ts
  - docs/plans/session-execution-model.md
symbols: [RunnerContainer, snapshotContainer, containerSnapshot]
supersedes: [PDR-20261123-session-continuity]
decided_by: suzuki3jp
---

# Session の作業はコンテナのスナップショットと R2 の保存で引き継ぎ、待機せずに眠らせる

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

## 範囲と例外

対象はリポジトリを持つ Session の Turn。作業ツリーの R2 保存には、次を含める。依存などは R2 からの復元時に作り直す。

- 基準のコミット（最初に checkout した SHA、または PR のマージ後に合わせ直した既定ブランチの SHA）と、その時点の HEAD。
- 基準から HEAD までのコミット（Agent が Turn 中に作ったコミットや、公開ツールで公開した作業ブランチのコミットを含む）。`git bundle` などで保存する。
- HEAD に対する未コミットの変更と未追跡のファイル（`.gitignore` の対象を除く）。

復元は記録した基準のコミットを checkout し、保存したコミットと変更をその上に戻す。既定ブランチの最新から戻すことはしない。Claude Code の `CLAUDE_CONFIG_DIR` も Agent のコマンドが書き込める範囲の外に置き、次の Turn に戻すのはセッションの記録だけとする。

Codex が対象リポジトリの設定を読まない（[Session 単位の隔離の境界の判断](PDR-20261123-repository-settings-session-boundary.md)）ことを、2 回目以降の Turn でも保つ。そのため Agent のコマンドが Codex の設定を書けない配置にし、書けたとしても次の Turn では使わない。

スナップショットは削除できないため、Session を削除しても作業ツリーと会話を含むスナップショットが最大 30 日残ることを受け入れる。コンテナに認証情報を書かない方針を守る。R2 に置く会話と作業ツリーは Session と同じ扱いのデータとし、Session の削除に合わせて消す。

スナップショットの作成中は次のメッセージの処理を待たせる（順番待ちは [実行モデルの判断](PDR-20261123-execution-model.md) に従う）。スナップショットの作成・復元に失敗しても Turn の結果は失敗にせず、次の Turn で R2 から戻す。

## 選択肢と影響

- **コンテナを常時起動する案**: 引き継ぎは最も単純だが、Session 数に比例して費用がかかる（1 Session 約 $55/月）。採用しない。
- **スナップショットを使わず R2 だけで戻す案**: 削除できないデータが残らないが、毎回 checkout と依存の取得が必要で遅い。採用しない。

不利益として、公開ベータの仕様変更の影響を受ける。Runner を更新するたびに、各 Session の次の Turn は R2 からの復元を通るので遅くなる。
