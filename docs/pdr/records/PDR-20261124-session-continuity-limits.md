---
schema: 1
id: PDR-20261124-session-continuity-limits
key: session.continuity.limits
status: accepted
date: "2026-11-24"
areas: [sessions, agent, infrastructure]
keywords: [作業の引き継ぎ, 上限, 100 MiB, 保存時間, 2 分, 失敗した Turn, 時間切れ, R2, 引き継ぎ不可, git bundle, rollout]
paths:
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/git-workspace.ts
  - apps/runner/src/continuity.ts
  - packages/core/src/runner.ts
symbols: [maxContinuityBytes, continuitySaveMs, saveContinuity, WorkspaceContinuity]
supersedes: []
decided_by: suzuki3jp
---

# Session の作業の保存は 100 MiB まで、Turn の後に別に 2 分を取り、失敗した Turn も引き継ぐ

## 決定

[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)で R2 に保存する作業について、次のように決める。

- **大きさの上限**: 1 回の保存は圧縮後 100 MiB まで。保存するのは基準のコミットからの差分（Agent のコミット、未コミットの変更、未追跡のファイル）と Codex の会話記録で、リポジトリ全体ではない。上限を超えたら R2 への保存に失敗したときと同じく、Turn は成功のまま Session に「引き継ぎ不可」を記録する。
- **失敗した Turn**: Agent の失敗や時間切れで終わった Turn も、その時点の作業ツリーと会話を保存し、次の Turn に引き継ぐ。利用者は「続けて」と送れば途中から再開できる。
- **保存の時間**: Turn の保存には、Run の制限時間とは別に最大 2 分を取る。Agent の作業時間を削らず、時間切れで終わった Turn でも保存できる。2 分を超えたら保存の失敗として扱う。

## 理由

GitHub は 1 ファイルを 100 MiB までに制限し、Tailos の PR にできる変更は 1 Turn で 4 MiB まで。保存するのは差分だけなので、上限 100 MiB はソースの変更には十分で、超えるのは `.gitignore` にない生成物やダウンロードしたファイルが残る場合に限られる。上限を置かないと、保存と復元が 2 分に収まらず、R2 の費用も読めなくなる。

失敗した Turn の途中までの作業を捨てると、利用者は同じ作業をやり直すことになる。Codex の会話記録には失敗した試みも残るので、作業ツリーも同じ時点に揃えて引き継ぐ。

Run の制限時間の内側で保存すると、時間切れの Turn ほど保存できず、引き継ぎが最も必要な場面で失われる。

## 範囲と例外

上限と保存の時間は `packages/core/src/runner.ts` の定数（`maxContinuityBytes`、`continuitySaveMs`）で決める。保存の失敗は数回まで再試行し、2 分の中で収まらなければ打ち切る。

Turn が作業ツリーに届く前に終わった場合（checkout の失敗、Runner の起動の失敗、Runner がジョブを断った場合など）は、前の Turn の保存をそのまま残す。この Turn は前の作業に手を加えていないため。前の保存を残すのは、そのことを Runner が確かめられた場合に限る。Runner にジョブを渡した後にコンテナや Runner のプロセスが落ちて確かめられない場合は、Agent が作業を進めていたかもしれないので、黙って古い作業に戻さず「引き継ぎ不可」を記録する。

計画会話は、Routine に移す段階（suzuki3jp/tailos#129 の段階 6）まで今の方式のままとし、作業を引き継がない。

R2 には Session ごとに最新の保存だけを残し、新しい保存ができたら前の保存を消す。保存は Session ごとのキー（`sessions/v1/<sessionId>/`）に置き、Session を削除する操作ができたら、同じ接頭辞でまとめて消す。

## 選択肢と影響

- **上限 25 MiB**: より安いが、置き忘れた生成物があるだけで引き継げなくなる。採用しない。
- **上限なし**: 保存と復元の時間と費用が読めない。採用しない。
- **直前の成功した Turn から再開する**: 失敗した Turn の作業が失われる。採用しない。
- **Run の制限時間の内側で保存する**: 時間切れの Turn を保存できない。採用しない。

不利益として、Turn の終わりから Session の Durable Object が次の Turn を始めるまでに、最大 2 分の保存の時間が加わりうる。
