---
schema: 1
id: PDR-20261124-publication-base
key: publication.tool
status: superseded
date: "2026-11-24"
areas: [github, agent, sessions]
keywords: [公開, 公開ツール, PR, コミット, 署名付きコミット, 作業ブランチ, PR の更新, Session, Turn, tailos_publish, マージ済み, 未公開の作業, 載せ直し, 始点, ブランチ名, base, PR の base, invalid_base]
paths:
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/git-workspace.ts
  - apps/runner/src/publication-tool.ts
  - apps/runner/src/codex-agent.ts
  - docs/plans/session-execution-model.md
symbols: [GitHubApp, workBranchFor, CheckedPublication, SessionPublication]
supersedes: [PDR-20261124-publication-tool]
decided_by: suzuki3jp
---

# 作業の公開は Agent が Tailos の公開ツールを呼び、API が検査してから署名付きコミットと PR を作る

## 決定

- Agent は、作業を公開したいときに Tailos が用意する公開ツールを呼ぶ。Runner が差分を検査して API に預け、API が GitHub App で署名付きコミットを作り、PR を作成または更新する。今の検査（作業ブランチ・tree の照合、署名の確認、既定ブランチの保護）は維持する。
- Turn の終わりに必ず PR を作る作りをやめる。公開するかどうかは Agent がプロンプトに沿って決める。公開しない Turn も成功として扱う。
- Session が同時に開く作業ブランチと PR は 1 つとする。同じ Session で 2 回目以降に公開すると、同じ作業ブランチにコミットを足し、開いている PR を更新する。
- 作業ブランチの名前は、1 本目を `tailos/session/<sessionId>` とし、PR がマージされた後に作る 2 本目以降を `tailos/session/<sessionId>-2`、`-3` と連番にする。
- PR が閉じた後に同じ Session で公開するときは、閉じ方で分ける。
  - **マージ済み**: 次の Turn の始めに作業ツリーを既定ブランチの最新に合わせ、次の連番の作業ブランチで新しい PR を作る。マージ済みの変更が新しい PR に重複しないようにするためである。
    - 最後に公開したコミットより後の、まだ PR に入っていない作業（コミットと未コミットの変更）は、既定ブランチの最新に載せ直す。
    - 載せ直しが競合したら、既定ブランチの最新から始め、未公開の作業は作業ツリーの中の別の参照に残す。Agent と利用者には、載せ直せなかったことと、作業を残した場所を知らせる。
  - **マージせずに閉じた**: 同じ作業ブランチで新しい PR を作る。ブランチが削除されていれば、作業ツリーの先頭から作り直す。
- 上の始点は Tailos が Turn を始めるときの既定である。利用者がプロンプトで別のブランチやコミットから始めるよう頼めば、Agent が Turn の中で作業ツリーを checkout などで動かしてよい。
- PR の base は、公開ツールの任意の引数 `base` で Agent が指定する。省略したときは既定ブランチとする。
  - 最初の公開では、作業ツリーがそのブランチのどのコミットの上にあるかを Runner が求め、そのコミットを親にする。API は、その親が `base` のブランチの先頭から辿れることを GitHub で確かめる。辿れない、ブランチがない、`base` が Session の作業ブランチ自身、のどれかなら公開を断る（`invalid_base`）。
  - 一度開いた PR の base は変えない。後の公開で別の `base` を渡したら断る。省略すれば同じ base のまま公開する。
  - マージの後に次の連番のブランチで作る PR は、改めて既定ブランチを base とする。

## 理由

PDR-20261122-agent-egress-credential-proxy により、Agent は gh で対象リポジトリを操作できるようになった。それでも公開を API に通すのは、署名付きコミットと、Runner・API での差分の検査（`.git` などの書き換えや、作業ブランチ以外への変更を防ぐ）を保つためである。Agent が `git push` や `gh pr create` で直接公開すると、これらの検査を通らない。

実行モデルでは出力を Connector に寄せる（[実行モデルの判断](PDR-20261123-execution-model.md)）。公開もその一つとして Agent が呼ぶ形にすれば、「答えるだけ」「調査して報告するだけ」の Turn と、PR を出す Turn を同じ仕組みで扱える。Session ごとに作業ツリーを引き継ぐので（[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)）、続きのメッセージで「さっきの PR を直して」と頼めば、同じ PR に修正が積まれる。

マージ後に未公開の作業を載せ直すのは、作業を引き継げなかったら Agent と利用者に伝えるという引き継ぎの判断と揃え、作業を黙って捨てないためである。競合したときに元の作業ツリーで続けないのは、次の PR にマージ済みの変更が重複するからである。競合の解消は、残した作業を見て Agent が行える。

2 本目以降のブランチ名を `/` ではなく `-` でつなぐのは、git では `tailos/session/<sessionId>` と `tailos/session/<sessionId>/2` を同時に持てないためである。

始点を Tailos が固定せず Agent に動かせるのは、既存のブランチの続きや特定のコミットからの作業を、入力の項目を増やさずにプロンプトだけで頼めるようにするためである。base を Agent が明示するのは、始点のコミットが複数のブランチに含まれるときに API が推測すると曖昧になり、既定ブランチに固定すると別ブランチの未マージの変更まで PR に入るからである。PR の base を途中で変えないのは、開いた PR の差分の意味が途中で変わらないようにするためである。

## 範囲と例外

対象はリポジトリを持つ Session。公開ツールを呼べるのは書き込みを許された Routine と Web の Session に限り、読み取り専用の Routine（計画など）には渡さない。

[前の公開ツールの判断](PDR-20261124-publication-tool.md) の後継として、PR の base の選び方を決め、次の失敗時の挙動を記録する。それ以外は前の判断を引き継ぐ。

- Turn の始めに Session の PR を GitHub から読めないときは、マージを検知できないので載せ直さない。次の Turn でもう一度確かめる。
- 読み取り専用の Turn（計画など）は公開しないので、マージを検知しない。次の書き込みを許された Turn で確かめる。

Agent が gh で直接 push や PR 作成を行うことは、GitHub 操作の制限（suzuki3jp/tailos#130）までは技術的には止めない。ただし Tailos の Run の結果として扱うのは公開ツールで公開したものだけとする。

Session が同時に開く作業ブランチと PR を 1 つに限るのは、公開を公開ツールに通している間の制限である。今後、Agent が git や gh でブランチを切り、コミットし、PR を作ることを正式に認めるときは、この制限を撤廃する。そのときは後継 PDR で、Session が複数のブランチと PR を持つ場合の扱いを決める。

既存の label 起動の Run は、この判断を実装する段階で公開ツールを使う形に移す。それまでは従来どおり Run の終わりに公開する。

## 選択肢と影響

- **Agent が gh で直接 push と PR 作成を行う案**: 最も単純だが、署名付きコミットと API 側の検査がなくなる。採用しない。
- **Turn ごとに新しいブランチと PR を作る案**: 今の作りに近いが、続きのメッセージで同じ PR を直せない。採用しない。
- **マージ後の載せ直しが競合したら元の作業ツリーで続ける案、未公開の作業があれば合わせ直さない案**: 作業は失われないが、次の PR にマージ済みの変更が重複しうる。採用しない。
- **2 本目以降のブランチ名に Turn の runId を付ける案**: どの Turn で作ったかが分かるが、名前が長くなる。採用しない。
- **始点のブランチやコミットをメッセージの項目で指定し、Tailos が Turn の前に合わせる案**: 入力の項目が増える。採用しない。
- **始点を含むブランチを API が推測して base にする案**: Agent の指定は要らないが、複数のブランチに含まれるときに曖昧になる。採用しない。
- **base を常に既定ブランチにする案**: 単純だが、別ブランチから始めるとそのブランチの未マージの変更も PR に入る。採用しない。

不利益として、Agent が公開ツールを呼ばなければ PR はできない。プロンプトで公開を指示する必要がある。始点を Agent が動かせるので、最初の公開の検査は「Turn の始めに checkout したコミット」との照合ではなく、「base のブランチのコミットの上にあるか」を GitHub に問い合わせて行う。そのぶん最初の公開で GitHub への問い合わせが増える。
