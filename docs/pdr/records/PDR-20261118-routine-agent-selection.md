---
schema: 1
id: PDR-20261118-automation-agent-selection
key: agent.selection
status: "superseded"
date: "2026-11-18"
areas: [agent, triggers, runs]
keywords: [Routine, engine, codex, claude, model, effort, モデル, 既定値, 接続]
paths:
  - apps/api/src/application/triggers/**
  - apps/api/src/application/routines/**
  - apps/api/src/presentation/http/handlers/routines/**
  - apps/api/src/infrastructure/cloudflare/runner-container.ts
  - packages/core/src/runner.ts
  - apps/runner/src/codex-agent.ts
symbols: [ExecutionContext, RunnerJob]
supersedes: [PDR-20261114-010]
decided_by: suzuki3jp
---

# label の実行設定を Routine ごとに選び Codex から対応する

## 決定

移行後の label 起動では、Project 全体の `agent` ではなく、トリガーと依頼を束ねる Routine の実行設定から engine・model・effort を解決する。今回の Routine 移行で選択・実行できる engine は `codex` とする。Claude の Routine 対応は、Claude 自体の実行経路の対応後に追加する。

既存 label 設定の移行では `engine: codex` とし、model・effort は未指定にする。新規 Routine も model・effort の未指定を許し、その場合は provider の既定を使う。明示値は黙って別のモデル・effort に置き換えず、保存時の対応検証と実行時の失敗結果で追えるようにする。

Run を受理するときに、指定された実行設定と接続の識別子を保存し、実行開始・復旧・再送時に最新の Routine から読み直さない。接続の token 更新は従来の API の責務とし、秘密情報を Routine に保存しない。必要な接続がない場合は別の engine や他人の接続へ切り替えない。

## 理由

同じ Project の複数の起動目的でモデルや effort を使い分けるには、選択単位をトリガーに紐づく設定へ移す必要がある。未指定を許せば、現在の provider 既定を用いる label 起動を移行時に維持できる。

将来は同じ種類の Routine でも Agent を使い分けられる構造にする。一方、現在の API のジョブ作成・repository checkout・公開には Codex 限定の分岐が残る。Claude 対応の完了を今回の移行の前提にせず、まず Codex で設定解決と共通受付を整える。

## 範囲と例外

[従来の Agent 選択](PDR-20261114-010.md) の後継として、label の選択単位を Project から Routine へ変更する。未移行の plan は現行の起動経路と選択規則を維持する。Project 設定の初回 D1 移行に agent を含めなかった [時期の判断](PDR-20261114-project-agent-field-timing.md) は、その実装範囲についての記録として残す。

プロンプト・実行設定は同じ Routine revision の値として保存する。未指定 model・effort の保存は「指定しない」という選択の固定であり、provider の既定モデルが将来も同一である保証ではない。provider が返す実効モデル等は観測可能な範囲で別に記録する。

モデル識別子、effort の許容値と組み合わせは各 provider の実装契約を確認する。既存の手動チャット、plan、旧ジョブのスキーマへ新しい必須項目を追加しない。接続不在や能力情報を確認できない場合の設定保存・有効化は [保存・有効化の判断](PDR-20261118-routine-configuration-validation.md) に従う。

今回は `claude` の Routine を保存 API で受け付けず、UI でも実行可能な選択肢として出さない。既存の Claude 接続・Adapter を削除する指示ではない。後続の対応で接続・モデル・effort・実行・公開まで設定が反映されることを確認してから追加する。

## 選択肢と影響

Project 単位の選択を続ける案は設定が少なく済む一方、トリガーごとの使い分けができない。model・effort を必須にする案は再現性を高められるが、既存の既定値利用を変更し、モデルの提供終了時に設定更新が必要になる。

