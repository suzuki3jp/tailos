---
schema: 1
id: PDR-20261126-session-agent-provider
key: sessions.agent-provider
status: accepted
date: "2026-11-26"
areas: [sessions, agent, web, api]
keywords: [Session, Model Provider, プロバイダー, 切り替え, Codex, Claude, 会話の引き継ぎ, 作業ツリー, Routine, engine]
paths:
  - apps/api/src/application/sessions/continue-session.ts
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/runner/src/claude-agent.ts
  - apps/runner/src/codex-agent.ts
  - apps/web/src/features/compose-loop/**
  - apps/web/src/_pages/session-detail/**
symbols: [continueSession, LoopComposer, ModelEffortSelect]
supersedes: []
decided_by: suzuki3jp
---

# Session の途中では Model Provider を切り替えない

## 決定

Session 画面から続きを送るときは、その Session の直前の Turn と同じ Model Provider（Codex または Claude）で動かす。入力欄のモデル選択には、その Provider のモデルと effort だけを出す。API も別の Provider を指定した続きは受け付けない（`409 session_provider_fixed`）。

Routine が続けている Issue の Session では、Turn の Provider は Routine の今の設定に従う（[Agent の選択の判断](PDR-20261126-agent-selection-claude.md)）。Routine の engine が変わった後の Turn は、作業ツリーを引き継ぐが、前の Provider の会話は引き継がない。Agent には、前の会話が使えず作業ツリーは前の Turn のままであることを伝え、利用者にもそう伝えさせる。

## 理由

利用者は、Session の途中でも Provider を切り替えてそのまま続けられることを望んだ。ただし、続けられる条件として、難しければ Session の中では切り替えられない制限でよいとした。

会話の引き継ぎは Provider ごとの形式（Codex のスレッドの記録、Claude Code のセッションの記録）で保存し、同じ Provider でしか再開できない。Provider をまたいで続けるには、Tailos が会話を別の形式に作り直すか、これまでのやり取りを文章として渡す必要がある。前者は各 Agent の内部形式に依存し、後者は渡す量の上限と省略の規則を新たに決める必要がある（以前、計画会話の履歴をバイト予算で省略する案は採用しなかった）。どちらも今回の対応の範囲を大きく超えるので、Session 画面からの切り替えは許さない。

Routine は Provider を Routine の設定として持つので、Routine を直した後の Turn は新しい Provider で動くのが自然である。その場合も作業ツリーは Provider に依存せず引き継げるので、会話だけが失われることを Agent に伝えて続ける。

## 範囲と例外

対象は Session 画面からの続きと、Routine が続けている Session の Turn。新しい Session を始めるホームの入力欄では、Provider を自由に選べる。

## 選択肢と影響

- **Provider を切り替え、これまでのやり取りを文章で渡す案**: 切り替えても会話の流れを保てるが、渡す量の上限と省略の規則を決める必要がある。今回は採用せず、要望が続けば別に判断する。
- **Routine の engine が変わっても、続いている Session では前の Provider を使い続ける案**: 会話は保てるが、Routine の設定が効かない Session が残る。採用しない。

不利益として、Session 画面で別の Provider に頼みたいときは、ホームから新しい Session を始める必要がある。
