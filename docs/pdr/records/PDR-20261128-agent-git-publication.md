---
schema: 1
id: PDR-20261128-agent-git-publication
key: publication.tool
status: accepted
date: "2026-11-28"
areas: [github, agent, sessions]
keywords: [公開, 公開ツール, tailos_publish, PR, コミット, push, git push, gh pr create, 署名付きコミット, 作業ブランチ, 複数の PR, ブランチ名, マージ, 載せ直し, Run の結果, コミットの作者, GitHub App の bot, receive-pack, ブランチ保護]
paths:
  - apps/api/src/infrastructure/cloudflare/github-egress.ts
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/application/runs/advance-run.ts
  - apps/api/src/application/routines/routines.ts
  - apps/runner/src/agent-turns.ts
  - apps/runner/src/git-workspace.ts
  - apps/web/src/_pages/session-detail/model/run-result.ts
  - packages/core/src/runner.ts
symbols: [GitHubEgress, pushedBranches, RunnerContainer, runInGitWorkspace, implementationPrompt]
supersedes: [PDR-20261124-publication-base]
decided_by: suzuki3jp
---

# ブランチ・コミット・PR は Agent が git と gh で直接扱い、Tailos の公開ツールをやめる

## 決定

- Tailos の公開ツール（`tailos_publish`）をやめる。Agent は `git commit`、`git push`、`gh pr create` などで、ブランチ・コミット・PR を直接扱う。どこで何を PR にするかはハーネスで決めず、利用者がプロンプトや Routine の指示で決める。
- Session ごとに作業ブランチと PR を 1 つとする制限をなくす。`tailos/session/<sessionId>` と連番の命名規則もなくし、ブランチ名は Agent が決める。
- Tailos は Turn の始めに作業ツリーを動かさない。PR のマージを検知して既定ブランチの最新に合わせ、未公開の作業を載せ直す処理をやめる。次の Turn は前の Turn の作業ツリーをそのまま引き継ぎ、どこから作業するかは Agent が決める。
- Agent のコミットは署名されない。API がコミットを作り直す検査（作業ブランチ・tree の照合、ファイルの mode や大きさの制約）もなくす。
- 書き込みを許された Turn では、Agent のサンドボックス（Codex・Claude Code の両方）が git の管理ディレクトリにも書き込めるようにする。これまでは作業ツリーだけが書き込み可能で、Agent はコミットできなかった。
- 最初の Turn の作業ツリーは、`git clone --depth 1` と同じ形で始める。既定ブランチと同じ名前のローカルブランチを checkout し、`origin/<既定ブランチ>` を追跡させる。
- 作業ツリーには、対象リポジトリを指す `origin` と、GitHub App の bot を作者とする git の設定（`user.name` は `<App の slug>[bot]`、`user.email` はその bot の noreply アドレス）を Runner が置く。Agent はこの設定を変えてもよい（変えられないようにすることは suzuki3jp/tailos#182 で検討する）。
- Tailos は、Turn の中で Agent が push したブランチを GitHub 通信のプロキシで記録する。git の push（`git-receive-pack`）の先頭にある ref の更新から `refs/heads/` のブランチ名だけを読み、push の中身は読まない。
- Turn が成功したら、その Turn で push したブランチを head とする PR を GitHub で探し、Run の結果として Session に表示する。PR がなければ結果は「完了」とする。
- label 起動の Routine は、Run の終わりに Tailos が公開する作りから、Routine の指示で Agent が PR を作る形に移す。既定の実装 Routine の指示を「ブランチにコミットして push し、gh で Issue を参照する PR を作る」に変える。移行で作られたまま変更されていない Routine の指示も、同じ文に書き換える。

## 理由

PR やコミットの作り方をハーネスに組み込むと、利用者は柔軟なフローを組めない。たとえば 1 つの Session から複数の PR を出す、既存のブランチに積む、PR を積み重ねる、コミットを分ける、といった流れは、1 Session 1 PR と作業ツリーの自動の載せ直しを前提にした公開ツールでは表せない。Agent に git と gh を直接使わせれば、流れはプロンプトで決められる。

公開ツールを残す理由は、署名付きコミットと、API・Runner での差分の検査だった。しかし署名は GitHub の `createCommitOnBranch` でコミットを作り直すことで得ていたので、Agent が作ったコミットをそのまま push する形とは両立しない。Agent のコミットを Tailos が push の時点で作り直すと、手元とリモートの SHA がずれ、mode の制約で push が分かりにくく失敗する。既定ブランチへの変更はリポジトリのブランチ保護で守られ（GitHub App にはルールを迂回する権限がない）、既定ブランチの署名が必要なリポジトリでは squash merge で GitHub が署名したコミットが入る。そのため作業ブランチでの署名と検査は手放す。

どのブランチへ push してよいか、force push を許すかは、リポジトリのブランチ保護で決めることであり、アプリのハーネスでは決めない。

PR を記録するのに push のブランチ名を使うのは、Agent が `gh pr create` を使っても REST や GraphQL を直接呼んでも、PR の head は push したブランチになるからである。push の先頭にある ref の更新は pack の前に平文で並ぶので、中身を読まずに取り出せる。

Codex と Claude Code のサンドボックスは、どちらも書き込み可能な範囲に入っていない git の管理ディレクトリへの書き込みを断る。Runner は git の管理ディレクトリを作業ツリーの外に置いているので、そのままでは `git commit` も `git config` も失敗する。管理ディレクトリを書き込み範囲に足すと、Codex 0.166.0 と、Claude Code と同じサンドボックスの仕組み（sandbox-runtime 0.0.83）の両方で、コミット・設定の変更ができることを確かめた（2026-11-28、Runner と同じ Debian のコンテナで確認）。Agent が管理ディレクトリの設定や hooks を書き換えても Runner に影響しないよう、Runner 自身の git 操作は Agent の設定を使わない（[作業の引き継ぎの判断](PDR-20261128-session-continuity-branches.md)）。

最初の作業ツリーを clone と同じ形にするのは、Agent が普段のリポジトリと同じ前提で git を使えるようにするためである。既定ブランチの名前のローカルブランチに push しても、ブランチ保護で断られる。

コミットの作者を GitHub App の bot にするのは、Tailos が作ったコミットであることを履歴から分かるようにするためである。

label 起動の Routine は、Tailos が公開しなくなると、指示を変えない限り PR を作らなくなる。移行で作られたまま変更されていない指示は「Tailos handles publishing」と書かれ、今後は意味を持たないので、新しい既定の指示に置き換える。利用者が書き換えた指示は変えない。

## 範囲と例外

対象はリポジトリを持つ Session の Turn。読み取り専用の Turn（計画など）も同じ git の設定で動くが、作業ツリーへの書き込みは今までどおりサンドボックスで止める。

- 記録するのは、対象リポジトリへの push のうち、削除ではない `refs/heads/` の更新だけ。1 Turn に 20 本まで記録し、それ以上は記録しない。REST や GraphQL でブランチを作った場合（`gh api` で ref を作るなど）は記録しない。
- push が GitHub に拒否されても、ブランチ名は記録する。PR を探すときに見つからないだけである。
- PR は、記録したブランチごとに、そのブランチを head とする最も新しい PR（開いている・閉じた・マージ済みのどれでも）を表示する。前の Turn で push して、この Turn では push せずに PR だけ作った場合は表示しない。
- PR を探すのに失敗しても Turn は成功のままとし、見つかった分だけ表示する。
- Turn が失敗したときは PR を探さない。
- 保存済みの Run の結果（1 つの PR の URL）は今までどおり表示する。
- 既定ブランチの保護ルール（作成・更新・削除の制限）がないリポジトリで書き込みのある Turn を断る今の確認は残す。

## 選択肢と影響

- **公開ツールを複数ブランチに広げる案**: 署名と検査は残るが、git で直接 push する流れを使えず、フローがツールの引数に縛られる。採用しない。
- **push を Tailos が受けて、コミットを API で作り直す案**: 署名は残るが、手元とリモートの SHA がずれ、mode の制約で push が失敗する。実装も大きい。採用しない。
- **Tailos が PR を一切追跡しない案**: 最も単純だが、Session 画面から PR に辿れなくなる。採用しない。
- **PR の作成を GitHub への要求から読み取る案**: `gh pr create` 以外の作り方（REST、GraphQL の別の操作）をすべて読み分ける必要がある。push のブランチ名の方が作り方に依らない。採用しない。
- **アプリで push 先のブランチや force push を制限する案**: リポジトリのブランチ保護と役割が重なり、ハーネスで流れを縛ることになる。採用しない。

不利益として、作業ブランチのコミットは署名されず、Tailos はファイル単位の検査をしない。Agent は対象リポジトリで、ブランチ保護で守られていないブランチを自由に書き換えられる。Agent が push しない限り PR はできないので、プロンプトで PR の作り方を指示する必要がある。
