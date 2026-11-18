---
schema: 1
id: PDR-20261118-configurable-label-prompt
key: runner.github-context-acquisition
status: accepted
date: "2026-11-18"
areas: [runner, planning, github, triggers]
keywords: [設定可能プロンプト, 固定prompt, label, githubContext, contentHash, bodyOffset]
paths:
  - apps/api/src/presentation/http/handlers/github-webhook/**
  - apps/api/src/application/triggers/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - packages/core/src/runner.ts
  - apps/runner/src/agent-turns.ts
  - apps/runner/src/github-tool.ts
symbols: [githubIssueDigest, ExecutionContext, RunnerJob, agentPrompt]
supersedes: [PDR-20261114-004]
decided_by: suzuki3jp
---

# label の依頼は設定から取得し Issue の参照と内容照合を維持する

## 決定

label 起動の開始プロンプトを、API に固定した実装指示からユーザーが保存した指示に変更する。Issue のタイトル・本文をプロンプトへ自動展開せず、構造化した `githubContext: { kind: "issue", number, contentHash }` を Runner に渡し、対象リポジトリに限定した `tailos_github_get` で Agent が取得する方式を維持する。

従来の固定指示を既存 label 設定の移行元にする。移行方法や新規設定の初期値は [Routine の受付方針](PDR-20261118-label-routine-dispatch.md) に従う。設定可能になるのは依頼内容であり、Issue の内容照合、ツールの対象、実行モード、資格情報、公開の制約はプロンプトから変更できない。

## 理由

トリガーごとの目的をユーザーが指定するには、依頼内容を固定の実装指示から分離する必要がある。一方で、本文をジョブへ埋め込まない方式と内容ハッシュは、ジョブのサイズを抑え、許可された起動後の未確認の Issue 編集を指示として使わないために必要である。プロンプトの設定化を理由に、この境界を緩める必要はない。

## 範囲と例外

[前の判断](PDR-20261114-004.md) の「新しいラベル受付のプロンプトは固定の作業指示だけにする」を変更する。それ以外の取得契約と互換性は次のとおり維持する。

- label 受付時の署名検証済みイベントのタイトル・本文から SHA-256 を保存する。ハッシュの入力は `JSON.stringify([title, body ?? ""])` の UTF-8 バイト列で、null と空の本文は同じ内容として扱う。plan は開始前の保存済みスナップショットから計算する。
- 最初の取得結果を Run 中に保持し、ページをまたぐ編集内容を混在させない。ハッシュが一致しなければ本文を指示として返さない。元の内容へ戻すか、新しい label 受付または計画入力で開始する必要がある。
- 一回の本文取得は既存の 16,000 UTF-16 コード単位を維持し、`bodyOffset` / `nextBodyOffset` で全文を取得する。サロゲートペアを分割しない。全文未取得のまま終了した場合は `agent_failed` とし、取得失敗は同じ実行中に再試行できる。
- plan の Issue スナップショットを D1 に保存する。`planningContext` には本文を含めず、基準 SHA と受理済み会話を渡す。任意の GitHub コメントを指示に取り込まず、Issue のタイトル・本文を自動編集しない。
- prompt の 4,000 UTF-16 コード単位、最終ジョブの UTF-8 サイズの 32 KiB、計画会話超過時の `planning_input_too_large` を維持する。会話の受付順・保存・通知・モードの制約も維持する。
- `githubContext` やハッシュを持たない旧ジョブを引き続き処理する。保存済みの依頼本文を移行で書き換えず、実行中 Run は新ジョブとして再送せず poll を継続する。
- Worker と名前付きの不変な Runner イメージを同じリリースとして扱い、Run ごとの DO がその Worker 版のイメージを起動する。GitHub 読み取りの宛先・資格情報・診断記録は従来の制約を維持する。

これは今後の label 移行の仕様であり、この記録の追加だけでは既存 handler の固定プロンプトは置き換わらない。PR 起動や cron 起動に Issue 全文取得を要求する判断ではない。

## 選択肢と影響

Issue 本文を任意のテンプレートへ展開する案は、入力サイズや信頼境界の規則を別途必要とする。今回の方式ではユーザーが指示を変更できる一方、Issue 取得の義務や既存の実装・公開経路は残る。任意のプロンプトを設定できることだけでは、PR レビューや読み取り専用実行を提供したことにはならない。
