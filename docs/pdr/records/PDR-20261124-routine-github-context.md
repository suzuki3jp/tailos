---
schema: 1
id: PDR-20261124-routine-github-context
key: runner.github-context-acquisition
status: accepted
date: "2026-11-24"
areas: [runner, planning, github, triggers]
keywords: [設定可能プロンプト, 固定prompt, label, plan, issue_comment, githubContext, contentHash, bodyOffset, スナップショット, planning_input_too_large]
paths:
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - apps/api/src/infrastructure/d1/sessions.ts
  - apps/web/src/_pages/session-detail/**
  - packages/core/src/runner.ts
  - apps/runner/src/agent-turns.ts
  - apps/runner/src/github-tool.ts
symbols: [githubIssueDigest, ExecutionContext, RunnerJob, agentPrompt]
supersedes: [PDR-20261118-configurable-label-prompt]
decided_by: suzuki3jp
---

# Routine の依頼は設定から取得し、Issue の参照と内容の照合を維持する

## 決定

Issue を起点にする Routine（label と計画）の開始プロンプトは、利用者が保存した指示とする。Issue のタイトル・本文をプロンプトへ自動展開しない。構造化した `githubContext: { kind: "issue", number, contentHash }` を Runner に渡し、対象リポジトリに限定した `tailos_github_get` で Agent が取得する方式を維持する。

設定で変えられるのは依頼内容だけである。Issue の内容照合、ツールの対象、実行モード、資格情報、公開の制約はプロンプトから変更できない。

Session 画面では、起動元から得た構造化ジョブコンテキストを初期プロンプトと一緒に表示する。初期入力の一部として、どの Issue と内容ハッシュが渡されたかを会話上で確認できるようにする。

## 理由

トリガーごとの目的を利用者が指定するには、依頼内容を固定の指示から分離する必要がある。一方で、本文をジョブへ埋め込まない方式と内容ハッシュには次の役割がある。

- ジョブの大きさを抑える。
- 許可された起動の後に行われた、確認されていない Issue の編集を指示として使わない。

プロンプトの設定化を理由に、この境界を緩める必要はない。計画も label と同じ方式にすれば、計画のためだけに Issue のスナップショットを保存する経路が要らなくなる。

## 範囲と例外

[label の依頼を設定から取得する判断](PDR-20261118-configurable-label-prompt.md) の後継として、計画の Issue の参照を label と同じ方式に変える（[計画会話の判断](PDR-20261124-planning-routine.md)）。

- 受付時の署名検証済みイベントのタイトル・本文から SHA-256 を保存する。ハッシュの入力は `JSON.stringify([title, body ?? ""])` の UTF-8 バイト列で、null と空の本文は同じ内容として扱う。label は `issues.labeled`、計画は `issue_comment` のイベントにある Issue から計算する。計画の Issue スナップショットは保存せず、`planningContext` は渡さない。
- 最初の取得結果を Run 中に保持し、ページをまたぐ編集内容を混在させない。ハッシュが一致しなければ本文を指示として返さない。一致させるには、元の内容へ戻すか、新しい label またはコメントで起動し直す必要がある。
- 一回の本文取得は 16,000 UTF-16 コード単位を維持し、`bodyOffset` / `nextBodyOffset` で全文を取得する。サロゲートペアを分割しない。全文を取得しないまま終了した場合は `agent_failed` とし、取得失敗は同じ実行中に再試行できる。
- 任意の GitHub コメントを指示に取り込まない。Issue のタイトル・本文を自動編集しない。
- prompt の上限 4,000 UTF-16 コード単位と、最終ジョブの UTF-8 サイズの上限 32 KiB を維持する。計画の会話はジョブに埋め込まないので、`planning_input_too_large` は無くなる。
- `githubContext` やハッシュを持たない旧ジョブも引き続き処理する。保存済みの依頼本文を移行で書き換えない。実行中の Run は新しいジョブとして再送せず、poll を続ける。
- 画面表示には初期メッセージに紐づく Run の保存済みコンテキストを使う。構造化ジョブコンテキストを持たない入力ではプロンプトだけを表示する。
- Worker と名前付きの不変な Runner イメージを同じリリースとして扱い、その Worker 版のイメージを起動する。GitHub 読み取りの宛先・資格情報・診断記録は従来の制約を維持する。

PR 起動や cron 起動に Issue の全文取得を求める判断ではない。

## 選択肢と影響

Issue 本文を任意のテンプレートへ展開する案は、入力サイズや信頼境界の規則を別に必要とするため採らない。今回の方式では利用者が指示を変えられる。一方で、Issue を取得する義務と公開の経路は残る。
