---
schema: 1
id: PDR-20261119-routine-model-catalog-cache
key: triggers.routine-model-catalog-cache
status: proposed
date: "2026-11-19"
areas: [triggers, agent, auth]
keywords: [Routine, モデル候補, キャッシュ, コンテナ, 同時取得]
paths:
  - apps/api/src/infrastructure/cloudflare/credential-broker.ts
symbols: [codexModels]
supersedes: []
---

# Routine のモデル候補取得を所有者・接続ごとにまとめる

## 決定

提案：同じ所有者・接続のモデル候補取得を同時には一回にまとめ、成功した非空の一覧を取得完了から5分間キャッシュする。失敗はキャッシュしない。接続解除・変更時にはキャッシュを破棄し、接続が存在しなければキャッシュも返さない。

## 理由

app-server の一覧取得には専用コンテナの起動が伴う。画面のフォーカス復帰、複数タブ、保存時の確認で重複して起動すると費用とアカウントのコンテナ同時実行枠を消費する。同時取得の共有と短時間のキャッシュによって、通常の編集で繰り返される起動を減らす。5分なら編集から保存まで再利用しやすく、提供状況の変化を反映するまでの遅延も限定できる。

## 範囲と例外

候補の表示と保存時の確認が同じキャッシュを利用する。5分間は上流のモデル提供変更が反映されない場合があり、画面の再取得操作もキャッシュ有効期間内は保持済み候補を返す。実行時は従来どおり、その Run の app-server で対応を確認する。

キャッシュは所有者単位の CredentialBroker のメモリに置き、接続の版で分離する。DO の再起動時は再取得する。失敗時の無効保存・有効化の扱いは [設定検証の判断](PDR-20261118-routine-configuration-validation.md) に従う。
