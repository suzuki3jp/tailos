---
schema: 1
id: PDR-20261128-agent-egress-turn-end
key: agent.network.egress
status: accepted
date: "2026-11-28"
areas: [agent, runner, github, security, api]
keywords: [外部通信, 通信許可, networkAccess, enableInternet, プロキシ, 認証情報, GitHub トークン, gh, git, CA 証明書, interceptOutboundHttps, Outbound Worker, プロンプトインジェクション, 制御用ポート, 差し込みを止める, Turn の終わり, バックグラウンドのプロセス, push の記録]
paths:
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/infrastructure/cloudflare/github-egress.ts
  - apps/api/src/infrastructure/github/app.ts
  - apps/api/src/worker.ts
  - apps/runner/Dockerfile
  - apps/runner/entrypoint.sh
  - apps/runner/src/codex-agent.ts
  - apps/runner/src/claude-agent.ts
  - apps/runner/src/egress.ts
  - apps/runner/src/git-workspace.ts
  - apps/runner/src/github-tool.ts
  - apps/runner/src/server.ts
  - packages/core/src/runner.ts
symbols: [GitHubEgress, RunnerJob, RepositoryTarget, interceptOutboundHttps, createRunnerServer, runInGitWorkspace]
supersedes: [PDR-20261122-agent-egress-credential-proxy]
decided_by: suzuki3jp
---

# Agent の外部通信を常に許可し、GitHub の認証情報はコンテナの外で Turn の間だけ差し込む

## 決定

Run で使うすべての Runner コンテナと Agent のサンドボックスで、外部への通信を常に許可する。Project ごとの通信許可という設定項目は設けない。

- Runner コンテナは、エンジン・モードに関係なく外部通信を有効にして起動する。
- Codex のサンドボックスは `implement` の書き込み可能な隔離でも `plan` の読み取り専用の隔離でも通信を許可する。ファイルシステムの扱いは変えず、`plan` は読み取り専用のままとする。
- Claude Code の `implement` のサンドボックスも、すべての宛先への HTTP(S) 通信を許可する。Claude Code の許可リストは全ドメインの指定を受け付けないため、Runner 内の転送プロキシを経由させる。`plan` で Bash を渡さない判断（PDR-20261114-005）は維持する。

外部に送られて困る認証情報はコンテナに置かない。GitHub の認証情報は次の方式に置き換える。

- `github.com` と `api.github.com` への HTTPS 通信を、コンテナの外（Workers 側）で受け、Run 用の GitHub トークンを `Authorization` ヘッダーに差し込んでから GitHub に転送する。トークンはジョブ・ファイル・環境変数・プロセスのどれにも置かない。
- 差し込むトークンは対象リポジトリだけに限定し、GitHub App に与えた権限の範囲をすべて持たせる。プロキシでは GitHub の操作を制限しない。そのため Agent は対象リポジトリで Issue・PR へのコメント、ラベル変更、既定ブランチ以外への push、PR 作成などを行える。
- Agent からは普通に `gh` と `git` を使っているように見せる。イメージに `gh` を入れ、Agent の HOME にある gh の設定（`~/.config/gh/hosts.yml`）にダミーのトークンを置く。Claude Code はコマンドの環境変数から `GH_TOKEN` を必ず取り除くため、`GH_TOKEN` では Claude Code の Run で gh が動かない。両エンジンで同じ方式にする。コンテナの起動時に置かれる横取り用の CA を、gh・git・Node が信頼するようにする。
- 横取りの対象は GitHub の上の 2 ホストに限る。それ以外の通信は横取りせず、そのまま外に出す。
- Runner の git からトークン付きヘッダーによる認証を無くす。checkout の fetch も同じ差し込みを通す。

対象 Issue の全文取得とハッシュの照合を行う `tailos_github_get`（PDR-20261118-configurable-label-prompt）は変えない。Agent は作業を git と gh で直接公開する（[作業の公開の判断](PDR-20261128-agent-git-publication.md)）。プロキシは操作を制限しないが、push されたブランチ名だけを Run の結果のために記録する。

Runner の制御用 HTTP サーバーには、Agent のコマンドから操作できないようリクエストの認証を入れる。Run の制御側がジョブを渡すときに Run ごとの鍵を渡し、以後の状態取得とジョブの再送はその鍵がないと受け付けない。

## 理由

通信をオフにすると、Agent は Web のドキュメントやパッケージレジストリを参照できず、依存関係のインストールや dev server での動作確認もできない。Codex のサンドボックスは通信がオフだと待ち受けにも失敗するため、Browser Run のような機能も作れない。通信許可を Project ごとに切り替える設定は、オンにしない限りこれらがすべてできず、オンにすれば今回と同じリスクを負うので、設定項目として残す意味が小さい。

外部通信を常に許可すると、プロンプトインジェクションによって、リポジトリのソースや Issue の内容が外部に送られる可能性がある。このリスクは Agent の作業精度を上げるために受け入れる。一方で認証情報が外部に送られると、Run の外でリポジトリを操作されるなど被害が Run の範囲を超えるため、これは防ぐ。GitHub のトークンをコンテナの外で差し込めば、コンテナ内のコマンドが何を外部に送ってもトークンは漏れない。

Agent の GitHub 操作を最初から細かく制限すると、どの操作が必要かを決めないまま作業が止まる。まずは対象リポジトリに限定したトークンで App の権限の範囲を通し、操作の制限は後から検討する。既定ブランチはリポジトリのブランチ保護で守られ、App にはルールを迂回する権限がない。

Turn の終わりで差し込みを止めるのは、もとは API が公開を検査してからコミットを作るまでの間に、検査されていない変更を push させないためだった。公開ツールをやめた後も、Turn の後に残ったプロセスが GitHub を操作できても、その結果は Agent も利用者も見ないので、止める意味は残る。

Runner の HTTP サーバーは、サンドボックスの通信を許可すると Agent のコマンドから届く。待ち受けるアドレスを変えても、同じコンテナのコマンドはどのアドレスにも接続できるため、リクエストの認証で守る。鍵は環境変数で渡さずジョブを受け取るリクエストで渡し、Runner のメモリだけに置く。ジョブを受け取る前には Agent が動いていないため、最初に届いた鍵を正しいものとして扱える。

## 範囲と例外

すべてのエンジン（Codex・Claude）とモード（`plan`・`implement`）の Run に適用する。Run ではない Runner の起動確認も同じ設定で起動する。

- 横取りは対象リポジトリのある Run だけで行う。リポジトリのない Run では横取りの CA は置かれず、GitHub の認証情報も差し込まない。
- 差し込むのは、横取りした通信の宛先が `github.com` または `api.github.com` で HTTPS のときだけ。宛先が一致しない場合は転送しない。リダイレクトは自動で追わず、そのまま Agent に返す。
- Turn が終わった後は差し込まない。Runner が実行中以外の状態（成功・失敗）を返した時点で差し込みを止める。Agent が残したバックグラウンドのプロセスが、返答の後に誰も見ていないところで GitHub を操作できないようにするためである。コンテナを待機させる時間を延ばしても、その間は差し込まない。
- トークンの期限が過ぎた後と、Run の最終処理でトークンを revoke した後も差し込まない。
- `gh` の `viewer` を前提にするコマンドや、`gh` による画像のアップロードは GitHub App のトークンでは動かない。これは制約として受け入れる。
- Codex・Claude の認証情報（OAuth トークンなど）をコンテナから無くすことはこの判断に含めない。
- Agent の GitHub 操作をプロキシで制限することは今回行わない。

過去の Run の実行設定や Project の変更履歴に残る通信許可の値は書き換えない。読み込むときには無視し、エラーにしない。

## 選択肢と影響

- 通信許可の設定を残す案: オフのままだと上記の作業ができず、オンにすると今回と同じリスクを負う。設定の意味が「精度を下げるかどうか」になり、利用者が判断する価値が小さいため採らない。
- GitHub のトークンをコンテナに渡したまま通信を許可する案: トークンが外部に送られる可能性があり、被害が Run の範囲を超えるため採らない。
- 読み取り専用のトークンだけを差し込む案: Issue へのコメントや PR の操作を Agent が行えない。最初は App の権限を通し、制限は後から検討する。
- 不利益: ソースや Issue の内容が外部に送られる可能性を常に受け入れる。Agent は対象リポジトリに対して App の権限内の操作を自由に行える。

## 再検討条件

- Agent の GitHub 操作による問題が起きた場合や、操作を限定する要件が決まった場合は、プロキシで許可する操作を見直す。
- Codex・Claude の認証情報をコンテナから無くす場合は、同じ差し込みの方式を検討する。
