---
schema: 1
id: PDR-20261123-repository-settings-session-boundary
key: agent.claude.repository-settings
status: accepted
date: "2026-11-23"
areas: [agent, security, sessions]
keywords: [Claude Code, 対象リポジトリ, 信頼, .claude/settings.json, hook, skills, CLAUDE.md, settingSources, コンテナ, 隔離, 隔離の境界, Session, 持ち越し]
paths: ["apps/runner/**", "apps/api/src/infrastructure/cloudflare/runner-container.ts"]
symbols: [settingSources, strictMcpConfig]
supersedes: [PDR-20261114-009]
decided_by: suzuki3jp
---

# 対象リポジトリの Claude Code 設定は読み込み、隔離の境界は Session のコンテナとファイルシステムに置く

## 決定

Claude Code を実行するとき、対象リポジトリの Claude Code 設定を読み込む。`CLAUDE.md`、`.claude/rules`、skills、コマンド定義、サブエージェント定義、`.claude/settings.json` とそこに書かれた hook が有効になる。ユーザー領域の設定と、対象リポジトリの `.mcp.json` が定義する MCP サーバーは読み込まない。

対象リポジトリの内容に対する隔離の境界は、**Session ごとの Cloudflare コンテナと、そのファイルシステム**とする。同じ Session の Turn は同じ作業ツリーと作業領域を引き継ぐ。ある Turn で対象リポジトリの hook や Agent が書いたファイルは、同じ Session の後の Turn に残る。別の Session には持ち越さない。

Claude Code の OS レベルの隔離は Bash のコマンドに適用し続けるが、対象リポジトリが設定で用意したコマンドを止める境界としては扱わない。

## 理由

設定の読み込みについては従来の理由を維持する。`CLAUDE.md` と skills はリポジトリの作業規約と手順であり、Agent SDK はこれらを設定ファイルや hook と同じ単位で読み込み、一部だけを選ぶ指定を持たない。

境界を Run から Session に広げるのは、Session で作業内容（作業ツリー、依存、Agent の会話状態）を引き継ぐためである（[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)）。Turn ごとにすべてを捨てると、続きのメッセージのたびに checkout・依存の取得・会話の再構成が必要になり、手元の Agent と同じように作業を続けられない。同じ Session の Turn は同じ利用者の同じ作業の続きであり、前の Turn の結果が残ること自体が目的に合う。

## 範囲と例外

Claude Code・Codex のどちらで実行する Session にも、mode を問わず適用する。Codex は従来どおり対象リポジトリを信頼しない設定で実行し、リポジトリの設定ファイルと hook を読まない。

前の Turn で書かれた設定や hook が後の Turn の Agent に読まれ、実行されることを受け入れる。対象リポジトリへの書き込み権限を持つ人と、Agent に設定ファイルを書かせられる入力は、同じ Session の後の Turn にも影響できる立場として扱う。

コンテナには認証情報を置かない方針を取る。GitHub の認証情報はコンテナの外で差し込み（PDR-20261122-agent-egress-credential-proxy）、Codex・Claude の認証情報も同様にする（suzuki3jp/tailos#131）。それが完了するまでは、コンテナの中のトークンや Bearer に、同じ Session の後の Turn で動く hook も届く。

## 選択肢と影響

- **境界を Run のままにし、Turn ごとに作業環境を作り直す案**: 汚染は持ち越されないが、作業の引き継ぎができない。採用しない。
- 設定を読み込まず `CLAUDE.md` と skills だけを渡す案は、従来どおり採らない。

不利益として、ある Turn で入った不正な hook やファイルが、Session を作り直すまで残る。Session を新しく始めれば作業環境も新しくなる。
