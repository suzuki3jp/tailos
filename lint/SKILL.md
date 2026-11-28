---
name: lint
description: Tailos の lint ルールを新規作成するとき、または既存ルールの判定や診断メッセージを変更するときに使う。
---

# lint ルールの作成・変更

既存ルールと登録先を確認する。Oxlint のカスタムルールは `lint/` にあり、設定はリポジトリルートの `.oxlintrc.json` にある。

複数ファイルの解決結果が必要な循環・workspace 境界の制約は、`lint/internal-dependencies.mjs` に加える。依存関係を調べるときは `node lint/internal-dependencies.mjs` で現在のグラフを JSON として取得する。

## 診断メッセージ

エージェントが診断を読んで修正に着手できるように、すべてのエラー文に違反内容と一般的な解決策を含める。

1. 何がどの制約に違反したかを示す。必要に応じて対象のモジュール名や import パスを含める。
2. 制約を満たすために、どのコードや依存関係をどう変更できるかを具体的に示す。複数の修正が可能な場合は、個別の事情に依存せず適用できる方法を示す。

例 `Production Web modules cannot import test modules. Move shared code into a production module and import it from both places.`

変更後は、該当する `lint/*.test.mjs` と `pnpm lint` で、違反の検出と許可されるケースを確認する。
