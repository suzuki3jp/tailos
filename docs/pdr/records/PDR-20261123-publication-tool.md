---
schema: 1
id: PDR-20261123-publication-tool
key: publication.tool
status: superseded
date: "2026-11-23"
areas: [github, agent, sessions]
keywords: [公開, 公開ツール, PR, コミット, 署名付きコミット, 作業ブランチ, PR の更新, Session, Turn, tailos_publish]
paths:
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/runner/src/git-workspace.ts
  - apps/runner/src/codex-agent.ts
  - docs/plans/session-execution-model.md
symbols: [GitHubApp, workBranchFor, CheckedPublication]
supersedes: []
decided_by: suzuki3jp
---

# 作業の公開は Agent が Tailos の公開ツールを呼び、API が検査してから署名付きコミットと PR を作る

## 決定

- Agent は、作業を公開したいときに Tailos が用意する公開ツールを呼ぶ。Runner が差分を検査して API に預け、API が GitHub App で署名付きコミットを作り、PR を作成または更新する。今の検査（作業ブランチ・基準コミット・tree の照合、署名の確認、既定ブランチの保護）は維持する。
- Turn の終わりに必ず PR を作る作りをやめる。公開するかどうかは Agent がプロンプトに沿って決める。公開しない Turn も成功として扱う。
- 作業ブランチと PR は Session ごとに 1 つとする。同じ Session で 2 回目以降に公開すると、同じ作業ブランチにコミットを足し、既存の PR を更新する。
- PR が閉じた後に同じ Session で公開するときは、閉じ方で分ける。
  - **マージ済み**: 次の Turn の始めに作業ツリーを既定ブランチの最新に合わせ、新しい作業ブランチで新しい PR を作る。マージ済みの変更が新しい PR に重複しないようにするためである。
  - **マージせずに閉じた**: 同じ作業ブランチで新しい PR を作る。ブランチが削除されていれば、作業ツリーの先頭から作り直す。

## 理由

PDR-20261122-agent-egress-credential-proxy により、Agent は gh で対象リポジトリを操作できるようになった。それでも公開を API に通すのは、署名付きコミットと、Runner・API での差分の検査（`.git` などの書き換えや、作業ブランチ以外への変更を防ぐ）を保つためである。Agent が `git push` や `gh pr create` で直接公開すると、これらの検査を通らない。

実行モデルでは出力を Connector に寄せる（[実行モデルの判断](PDR-20261123-execution-model.md)）。公開もその一つとして Agent が呼ぶ形にすれば、「答えるだけ」「調査して報告するだけ」の Turn と、PR を出す Turn を同じ仕組みで扱える。Session ごとに作業ツリーを引き継ぐので（[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)）、続きのメッセージで「さっきの PR を直して」と頼めば、同じ PR に修正が積まれる。

## 範囲と例外

対象はリポジトリを持つ Session。公開ツールを呼べるのは書き込みを許された Routine と Web の Session に限り、読み取り専用の Routine（計画など）には渡さない。

Agent が gh で直接 push や PR 作成を行うことは、GitHub 操作の制限（suzuki3jp/tailos#130）までは技術的には止めない。ただし Tailos の Run の結果として扱うのは公開ツールで公開したものだけとする。

既存の label 起動の Run は、この判断を実装する段階で公開ツールを使う形に移す。それまでは従来どおり Run の終わりに公開する。

## 選択肢と影響

- **Agent が gh で直接 push と PR 作成を行う案**: 最も単純だが、署名付きコミットと API 側の検査がなくなる。採用しない。
- **Turn ごとに新しいブランチと PR を作る案**: 今の作りに近いが、続きのメッセージで同じ PR を直せない。採用しない。

不利益として、Agent が公開ツールを呼ばなければ PR はできない。プロンプトで公開を指示する必要がある。
