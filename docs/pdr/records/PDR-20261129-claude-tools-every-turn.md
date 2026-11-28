---
schema: 1
id: PDR-20261129-claude-tools-every-turn
key: agent.claude.plan-mode-commands
status: accepted
date: "2026-11-29"
areas: [agent, plan]
keywords: [Claude Code, plan, 計画, 読み取り専用, コマンド, Bash, Edit, Write, ツール, サンドボックス]
paths: [apps/runner/src/claude-agent.ts]
symbols: [ExecutionMode]
supersedes: [PDR-20261114-005]
decided_by: suzuki3jp
---

# Claude Code には、リポジトリを持つどの Turn にも同じツールを渡す

## 決定

Claude Code でリポジトリを持つ Turn を実行するときは、計画の Routine かどうかによらず、ファイルの読み取り・検索・編集・書き込み、Bash、Skill、Tailos の GitHub 参照ツールを渡す。Bash はサンドボックスの中で実行する。

## 理由

[前の判断](PDR-20261114-005.md) では、計画の Turn が作業ディレクトリを変更しないことを、コマンドを渡さないことで保証していた。計画と実装のモードをなくし、Turn の権限を Routine で絞らないことにしたので（[Turn の権限の判断](PDR-20261129-turn-permissions.md)）、計画の Turn だけツールを減らす理由がなくなった。

ツールを減らしたままでは、計画の Agent が `git log` や依存関係の状態、既存のテストの結果を根拠にできず、既定のプロンプトが求める `gh issue comment` での返信もできない。同じ依頼でも Codex と Claude で計画の根拠に差が出ていた。

## 範囲と例外

リポジトリを持つ Claude Code の Turn に適用する。リポジトリを持たない Turn の扱いは変えない。サンドボックスを使えない環境では、計画の Routine の Turn も始まらない。

## 選択肢と影響

- **計画の Routine だけツールを減らし続ける案:** Routine によって権限を変えることになり、Turn の権限の判断と合わない。採用しない。

不利益として、Claude Code の計画の Agent も作業ツリーを書き換え得る。
