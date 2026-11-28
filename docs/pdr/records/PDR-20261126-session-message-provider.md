---
schema: 1
id: PDR-20261126-session-message-provider
key: sessions.continue-message
status: accepted
date: "2026-11-26"
areas: [sessions, web, api]
keywords: [Session, 続き, メッセージ, 送信, セッション画面, 入力欄, 実行設定, モード, plan, implement, requestId, 順番待ち, Model Provider, Codex, Claude]
paths:
  - apps/api/src/application/sessions/**
  - apps/api/src/infrastructure/d1/session-inbox.ts
  - apps/api/src/presentation/http/handlers/sessions/**
  - apps/web/src/_pages/session-detail/**
  - apps/web/src/features/compose-loop/**
symbols: [continueSession, admitSessionMessage, LoopComposer]
supersedes: [PDR-20261124-session-message]
decided_by: suzuki3jp
---

# Session 画面から既存の Session に続きのメッセージを送り、直前の Turn の設定で動かす

## 決定

Project の Session 画面の入力欄から、その Session に続きのメッセージを送れるようにする。送ったメッセージは、その Session の次の Turn になる。

- 送れるのは Project の所有者だけとする。Project が削除された Session や、まだ Turn のない Session には送れない。
- Session が作業中（進行中の Turn か、順番待ちのメッセージがある）のときは送れない。入力欄も送信できない状態にする（[実行モデルの判断](PDR-20261123-execution-model.md)）。
- 次の Turn は、直前の Turn の実行設定を引き継ぐ。モード（計画の読み取り専用か実装か）、Routine の指示、リポジトリ、起動元がこれにあたる。入力欄で選べるのは、直前の Turn と同じ Model Provider のモデルと effort だけで、選ばなければ直前の Turn と同じにする。Provider は切り替えない（[Session の Provider の判断](PDR-20261126-session-agent-provider.md)）。
- 計画（読み取り専用）の Session に送ったメッセージは、読み取り専用のまま動く。実装に進めたいときは、label など書き込みを許された Routine で始める。
- メッセージは利用者のメッセージとして Session に保存し、Session の順番待ちを通して Turn にする。時間上限は Project の今の設定とする。
- 二重送信を防ぐため、クライアントが入力ごとに発行する `requestId` で重複を判定し、同じ `requestId` の再送には最初の結果を返す。
- 直前の Turn の Provider の接続（Codex は ChatGPT 接続、Claude は Claude 接続）がなければ何も保存せず、送れなかったことを入力欄に表示する。

## 理由

これまで Session に続きを足せるのは Issue のコメントと label だけで、Web から始めた Session は 1 回のやり取りで終わっていた。Session は会話と作業ツリーを引き継ぐので（[作業の引き継ぎの判断](PDR-20261123-session-continuity.md)）、画面から続きを頼めれば同じ PR の修正などを続けて頼める。

直前の Turn の設定を引き継ぐのは、Session がどの Routine や起動元から始まっても、同じ権限と指示のまま続けるためである。送るたびに設定を選ばせると、入力の項目が増え、計画の Session が画面から書き込み可能になるなど、権限が入力欄の操作で変わってしまう。

## 範囲と例外

- 作業中の Session への送信（順番待ち）は、この判断では許さない。作業中の Agent の停止・割り込み（suzuki3jp/tailos#128）と合わせて後続とする。
- 直前の Turn の起動元をそのまま使うので、label で始まった Session では、その Issue の label が外れていると Turn の開始の確認で失敗する。Issue の本文が起動後に編集されていると、Agent は Issue の本文を指示として読めない。
- ホームの入力欄から新しい Session を始める挙動は変えない（[ホームからの開始の判断](PDR-20261126-home-message-start-provider.md)）。

## 選択肢と影響

- **Routine の今の設定で動かす案**: Routine を直した後の続きに新しい設定が効くが、Web から始めた Session との扱いが分かれる。採用しない。
- **入力欄で計画と実装を切り替えられる案**: 計画の会話をそのまま実装に使えるが、入力欄の操作で権限が広がる。採用しない。

不利益として、計画の Session から実装に進むには別の Routine で始め直す必要がある。

## 再検討条件

計画と実装のモードの区別をなくし、読み取りか書き込みかを Agent の判断に任せる方針に移るときは、この判断のモードの引き継ぎと、計画の Session を読み取り専用に保つ規則を見直す。
