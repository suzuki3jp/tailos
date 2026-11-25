---
schema: 1
id: PDR-20261124-planning-routine
key: planning.issue-conversation
status: superseded
date: "2026-11-24"
areas: [planning, triggers, notifications, sessions]
keywords: ["@tailos plan", 計画, 計画会話, Routine, issue_comment, コメント, Session, 順番待ち, 引き継ぎ, planning_inbox, planning_snapshots, planning_replies, planning_input_too_large, 返信, gh, 移行]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/infrastructure/d1/planning*
  - apps/api/src/infrastructure/d1/trigger-admission.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/runner/src/agent-turns.ts
  - packages/core/src/runner.ts
  - docs/plans/session-execution-model.md
symbols: [planningCommand, planningPrompt, acceptPlanningInput, dispatchPlanningInputs, planningReplyStore]
supersedes: [PDR-20261113-012]
decided_by: suzuki3jp
---

# 計画会話は Issue のコメントで起動する Routine とし、会話は Session の引き継ぎで続ける

## 決定

`@tailos plan` を、Project に属する plan Routine として動かす。計画会話専用の受付・入力の固定・返信の経路（`planning_inbox`・`planning_snapshots`・`planning_replies`）は使わない。

- **起動の条件:** Trigger は Issue コメントの作成（`issue_comment`）で、コマンド語は `plan`。open な Issue の新しいコメントの先頭にある `@tailos` だけをコマンドとする。メンションのない投稿、引用・コードフェンス・インデントの中のコマンド、コメントの編集・削除、Bot、PR、closed Issue、Routine の許可ユーザー以外は起動しない。
- **続きのコメント:** `@tailos plan …` は、その Issue の plan Session を始めるか続ける。コマンド語のない `@tailos <回答・修正依頼>` は、その Issue で最後に使われたコメント起動の Session に続ける。そういう Session がなければ、アプリが計画の始め方を Issue に案内する。
- **Session と順番待ち:** Session は Routine と Issue の組ごとに 1 つ（[Routine の受付の判断](PDR-20261124-issue-routine-dispatch.md)）。作業中に届いたコメントは順番待ちにし、1 件ずつ Turn にする。delivery とコメント ID の両方で重複を除く。
- **実行:** plan Routine は読み取り専用で動く。作業ツリーを書き換えず、公開ツールを渡さない。コメントから実装や PR の作成に進まない。
- **会話の続き:** 他の Session と同じく、Session の引き継ぎ（保存した Codex の会話の再開）で続け、Turn には新しいメッセージだけを渡す。D1 の会話全体をジョブに埋め込まない。そのため 32 KiB の上限と `planning_input_too_large` は無くなる。受け付けたコメントと Agent の返答は Session のメッセージとして D1 に保存し、画面に表示する。引き継ぎに失敗したときはそのことを Agent に伝える。Agent は gh で Issue のコメントを読み直せる。
- **Issue の参照:** label と同じく、受付時のイベントにある Issue のタイトル・本文から内容ハッシュを作る。それを `github.issue-comment` の trigger に持たせる。Issue のスナップショットは保存しない。
- **返信:** 計画や質問への返信は、Agent が gh で Issue にコメントする。アプリは計画の本文を Issue に投稿しない。アプリの状態コメント（処理中から完了・失敗への表示と Session へのリンク）は、Issue から起動したほかの Turn と同じく Turn ごとに付ける。その送信は [Issue 通知の永続送信の判断](PDR-20261113-006.md) に従う。
- **許可ユーザー:** plan の許可ユーザーは plan Routine に保存し、Routine の許可ユーザーだけで判定する。

### 移行

- 既存の Project ごとに、有効な plan Routine を 1 つ作る。プロンプトは従来の計画の指示、実行設定は従来の計画と同じ（Codex、モデルと effort はプロバイダの既定）とする。Project の plan の許可ユーザーをこの Routine にコピーし、Project からは外す。
- 移行前からある計画 Session には、移行後の `@tailos` も同じ Session で続ける。ただし保存した Codex の会話がないので、会話は新しく始め、そのことを Agent に伝える。以前のやり取りは Issue のコメントと Session の画面に残る。
- 移行は、進行中の Run と未送信の計画の返信がない状態で行う（[Routine の初回移行の方針](PDR-20261118-routine-initial-migration.md) と同じ）。`planning_*` の既存の行は書き換えずに残し、新しくは書き込まない。

## 理由

計画も実装も「Session に届いたメッセージに、権限の範囲で Agent が応える」同じ実行で表せる（[実行モデルの判断](PDR-20261123-execution-model.md)）。計画だけが受付・入力の固定・返信を専用に持つと、Session の続きや新しい起動元を足すたびに両方の経路で整合を取る必要がある。

会話全体をジョブに埋め込む方式では、32 KiB を超えた会話が `planning_input_too_large` で止まる。Session の引き継ぎで Codex の会話を再開すれば、会話の長さはジョブの大きさに影響しない。

返信を Agent に任せると、Agent が失敗したりコメントしなかったりすれば Issue には何も届かない。アプリの状態コメントを Turn ごとに残すことで、Issue を見ている人が結果と Session へのリンクを必ず受け取れる。

既存の計画 Session を同じ Session で続けると、画面の会話が移行の前後で分かれない。

## 範囲と例外

- この段階では、コメントで起動する Routine は plan だけにし、コマンド語は `plan` に固定する。利用者が plan Routine で変えられるのは、プロンプト・モデル・effort・許可ユーザー・有効か無効か。ほかのコマンド語やコメント起動の Routine の追加は後続とする。
- 「読み取り専用」は、作業ツリーを書き換えず公開ツールを持たないという意味である。Agent の GitHub 操作はプロキシで制限しない（[Agent の外部通信と GitHub の認証情報](PDR-20261122-agent-egress-credential-proxy.md)）。そのため plan の Agent は gh で Issue にコメントできる。GitHub 操作の制限（suzuki3jp/tailos#130）は後続とする。
- GitHub の任意のコメントは、メッセージとして取り込まない。Issue の内容の照合と全文取得は [Issue の参照の判断](PDR-20261124-routine-github-context.md) に従う。
- prompt の上限 4,000 文字、Agent の返答の上限 8,000 文字と、意味を保って要約する方針は維持する。

## 選択肢と影響

- **D1 の会話も予備としてジョブに渡す案:** 引き継ぎに失敗しても会話は残る。しかし 32 KiB の上限と専用の経路が残るため採らない。
- **移行後は新しい Session にする案:** 実装は単純だが、画面の会話が移行の前後で分かれるため採らない。
- **plan Routine を利用者が手で作る案:** 作るまで `@tailos plan` が止まるため採らない。

不利益として、次の点がある。

- 返信の本文を Agent が投稿するので、アプリがしていたメンションの無効化と投稿の回収は行われない。返信が無いことや、プロンプトに沿わない返信もあり得る。
- 引き継ぎに失敗すると、Agent はそれまでの会話を Issue のコメントからしか取り直せない。

## 再検討条件

Tailos が Session の履歴を読める API や MCP を Agent に渡すようになれば、引き継ぎに失敗しても Agent が自分で会話を取り直せる。その場合も、会話をジョブに埋め込む必要はない。
