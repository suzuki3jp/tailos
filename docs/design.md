# Tailos 本実装の設計

現行の責務と境界は [アーキテクチャ](architecture/README.md) にまとめている。実装と運用を調べるときは以下の入口を使う。

## 構成と依存の境界

[実行時の構成と公開境界](architecture/README.md#実行時の構成)、[内部依存のグラフ](architecture/dependencies.md) を参照。

## Session と実行のデータモデル

[状態の所有権](architecture/README.md#状態の所有権)、[D1 の整合性](architecture/README.md#d1-の整合性)を参照。列と制約の定義は [Drizzle スキーマ](../apps/api/src/infrastructure/d1/schema.ts) と [マイグレーション](../apps/api/migrations/)にある。

## 実行と復旧

[実行時の構成](architecture/README.md#実行時の構成)、[Session の継続](pdr/records/PDR-20261128-session-continuity-branches.md)、[Diagnostics](diagnostics.md)を参照。

## 認証と GitHub の権限

[本番の認証・GitHub App 設定](deploy.md)、[Turn 中の GitHub 認証](pdr/records/PDR-20261128-agent-egress-turn-end.md)、[モデルの資格情報](pdr/records/PDR-20261126-model-credentials-claude.md)を参照。

## ローカル開発とデプロイ

[ローカル開発](local-development.md)、[本番デプロイ](deploy.md)、[PR Preview](pr-previews.md)を参照。

## 実装フェーズ

[Trigger と実行設定の抽象化](plans/trigger-run-abstraction.md)と [Session の実行モデル](plans/session-execution-model.md)に、移行の経緯と関連する判断を記録している。

### Issue コメントによる計画会話

現行の設定は [Issue 内で計画を相談する](deploy.md#issue-内で計画を相談する)、決定の経緯は [計画会話の移行](pdr/records/PDR-20261125-planning-tables-dropped.md)を参照。
