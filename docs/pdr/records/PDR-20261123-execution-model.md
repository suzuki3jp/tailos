---
schema: 1
id: PDR-20261123-execution-model
key: execution.model
status: accepted
date: "2026-11-23"
areas: [triggers, sessions, agent, github]
keywords: [実行モデル, リアーキ, Trigger, Routine, Session, Turn, Connector, 疎結合, 入力, 出力, 順番待ち, inbox, plan, 計画会話, メッセージ]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/application/sessions/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/infrastructure/d1/planning.ts
  - apps/runner/src/**
  - packages/core/src/runner.ts
  - docs/plans/session-execution-model.md
symbols: [TriggerAdmission, ExecutionContext, RunTrigger, RunnerContainer]
supersedes: []
decided_by: suzuki3jp
---

# Trigger・Routine・Session・Turn・Connector に分け、入出力を実行から切り離す

## 決定

Tailos の実行モデルを次の 5 つの概念に分ける。

| 概念 | 役割 |
| --- | --- |
| Trigger | 外部のイベントを「Session へのメッセージ」に変える。新しい Session を作るか、既存の Session に追加するかもここで決める。例: Web のメッセージ、`issues.labeled`、`issue_comment`、将来の `pull_request.opened` や cron |
| Routine | どの Trigger に反応するかの条件、プロンプト、Agent の設定、権限。何をするかはプロンプトで決める |
| Session | 会話と作業環境を持ち続ける単位。メッセージを 1 件ずつ順番に処理する |
| Turn | Session のメッセージ 1 件を処理する Agent の 1 回分の作業。保存上は今の `runs` を使う |
| Connector | Agent が自分の判断で使う道具。GitHub（gh）、MCP、Tailos が用意するツール（公開など） |

- Trigger は実行の中身を決めない。Issue 番号などの参照は、メッセージに付く起動元の値（`trigger` の variant）として Agent に渡す。
- 出力は Agent が Connector で行う。Issue へのコメントや PR の作成・更新を、Turn の終わりにアプリが必ず行う作りをやめる。返答は常に Session に保存する。
- `@tailos plan` は「`issue_comment` の Trigger と、読み取り専用の権限と、計画を返すプロンプトを持つ Routine」として表す。専用の受付・入力の固定・返信の経路は、この仕組みに置き換える。
- Agent の作業中に同じ Session へ届いたメッセージは、届いた順に保存して順番待ちにし、今の Turn が終わってから 1 件ずつ処理する。Web の入力欄は作業中は送信できない。

## 理由

これまで Run は、起動元（Issue のラベル・コメント、Web）と出力先（PR、Issue コメント）と強く結びついていた。リポジトリを対象にした実装の Run は必ず PR を作るか「変更なし」で終わり、計画会話は受付・入力の固定・返信をすべて専用に持っていた。そのため、Session の続きのメッセージのような機能を足すたびに、既存の経路それぞれと整合を取る必要があった。

計画も実装も「Session に届いたメッセージに、権限の範囲で Agent が応える」という同じ実行で表せる。違いはプロンプトと権限と使う Connector だけなので、入出力を Trigger と Connector に寄せれば、新しい起動元や出力先は組み合わせの追加で済む。ユーザーが設定だけでループを組めるというプロダクトの目的にも合う。

作業中のメッセージを順番待ちにするのは、GitHub のコメントのように送信側を止められない Trigger があり、捨てると利用者の指示が黙って失われるためである。同時に処理すると同じ作業環境を二つの Turn が書き換えることになるので、1 件ずつにする。

## 範囲と例外

この記録は目指す形と移行の方針を決める。実装は [計画書](../../plans/session-execution-model.md) の段階に分けて行い、各段階で置き換える既存の判断（計画会話の永続化、Issue への通知など）は、その段階で後継の PDR を用意する。実装前の既存の挙動は、置き換えるまで維持する。

Session の作業環境と隔離の境界は [Session 単位の作業環境の判断](PDR-20261123-repository-settings-session-boundary.md)、作業の引き継ぎは [作業の引き継ぎの判断](PDR-20261123-session-continuity.md)、公開は [公開ツールの判断](PDR-20261123-publication-tool.md) に従う。作業中の Agent の停止・割り込み（suzuki3jp/tailos#128）、Session 画面からの送信（suzuki3jp/tailos#124）、GitHub 操作の制限（suzuki3jp/tailos#130）は後続とする。

順番待ちのメッセージは、Session の Project が削除された場合や、Session が処理できない状態になった場合は処理しない。Trigger ごとの受付条件（許可ユーザーなど）は受付時に判定し、順番待ちの後に再判定しない。

## 選択肢と影響

- **今の Run と入出力の結びつきを保ったまま機能を足す案**: 短期的には変更が小さいが、Trigger・出力先を足すたびに整合の手間が増える。採用しない。
- **作業中のメッセージを捨てる案**: 仕組みは単純だが、止められない Trigger の指示が失われる。採用しない。

不利益として、移行の間は新旧の経路が並ぶ。出力を Agent に任せるため、プロンプトや Agent の判断次第で PR やコメントが作られないことがある。
