---
name: fsd
description: Tailos Web の実装・設計・レビューで Feature-Sliced Design のレイヤー、slice、公開 API、依存方向を判断する。API・Runner だけの変更には適用しない。
---

# Feature-Sliced Design

Web の配置や依存を決めるときに使う。まず [Tailos 固有の状況](references/tailos.md) を読み、現行コード・導入済みの規則・将来の抽出候補を区別する。導入計画の存在だけで、ファイル移動や新しい lint 設定の適用を依頼されたと解釈しない。

Tailos の配置方針は `src/app` にルートと App の責務、`src/_pages` に画面本体。ソースは `src` 内に収め、独立した `_app` は作らない。App の一般的な segment 規約よりフレームワークのファイル規約を優先する。

## 配置を判断する

FSD 2.1 の Pages first を使う。まず画面の UI・取得処理・状態を同じ page slice にまとめ、実際に再利用する責務が生まれたら下位レイヤーへ抽出する。コード量やファイル名が同じという理由だけで分割・共通化しない。

| レイヤー | 責務 |
| --- | --- |
| App | 起動、ルーティングへの接続、Provider、全体の layout・styles。 |
| Pages | 画面またはネストしたルートの大きな画面領域。画面固有の UI・操作・取得処理を置ける。 |
| Features | 複数の利用箇所で再利用する、ユーザーに価値を与える操作とそれに必要な UI・状態。 |
| Entities | 再利用する業務概念の型・読み取り・表現。バックエンドの全モデルを機械的に複製しない。 |
| Shared | 通信基盤、汎用 UI、設定、用途が明確なライブラリ。上位 slice に依存しない。 |

標準の依存順序は `App → Pages → Widgets → Features → Entities → Shared`。未使用レイヤーは省略できる。Processes は非推奨。現在の公式ガイドは Widgets も Features との責務の重複を理由に使用を勧めていない。単一画面の構成は Pages、再利用する操作と UI は Features、全体の layout は App をまず検討する。

Pages / Features / Entities などは `layer/slice/segment`、App / Shared は slice を持たず `layer/segment` とする。slice 名は業務や利用者の言葉に合わせる。segment は目的で分け、必要なものだけを作る。

- `ui`: 表示、コンポーネント、表示用の変換、局所的な UI state。
- `api`: request、レスポンス型・変換、queryOptions、mutation と関連する key。
- `model`: 業務ロジック、状態モデル、検証。型は所有する処理の近くに置く。
- `lib`: slice 内で必要な補助処理、Shared では用途が明確な汎用ライブラリ。
- `config`: 設定・フラグ。秘密情報をブラウザへ渡さない。

`components` / `hooks` / `types` / `utils` を横断的な segment として増やさない。例えば取得 hook は `api`、フォームの状態 hook は `model`、表示だけの hook は `ui` に所属させる。App / Shared の segment 名は用途に合わせて拡張できる。

## 依存と公開 API

- 他の slice は厳密に下位レイヤーだけを参照する。同一レイヤーの別 slice 参照は type-only でも原則禁止。上位での合成、props、下位への適切な抽出を検討する。
- App / Shared には slice の隔離規則がなく、同レイヤーの segment 同士は参照できる。循環依存は避ける。
- slice 外からは公開 API の `index.ts` を使う。必要な名前だけを export し、`export *`、slice 内部への deep import、レイヤー全体の barrel を避ける。
- slice 内は相対 import で実体を参照する。自分の公開 API を import して循環を作らない。slice 間は alias を使う。
- Shared の大きな `ui` / `lib` は必要に応じてモジュール単位の公開入口を使う。例: `@/shared/ui/button`。全体をまとめる巨大な index を作らない。
- Entities の相互参照が業務上必要な場合だけ `entities/A/@x/B.ts` で B 向けの公開契約を明示する。他レイヤーの横断を許す逃げ道として使わない。
- server 専用実装を client から使う公開入口に混ぜない。実際に環境が混在する場合は `index.server.ts` など公式の環境別入口を検討し、bundler と lint の両方で確認する。

## 実装で使う

変更対象がどの画面・業務概念・通信基盤に属するかを判断し、既存 slice とその呼び出し元を確認する。再利用がまだなければ画面内に置く。依存先、公開 API、query key と invalidation の所有者を揃え、ルート adapter に画面の実装を増やさない。

機械的な移動に polling・retry・401 の扱いなどの挙動変更を混ぜない。挙動を変える場合はリポジトリの PDR 運用を適用する。検証は現行 CI と導入済みの lint を使い、未導入の計画上のコマンドが存在すると仮定しない。

## レビューで使う

差分と呼び出し元を読み、次を確認する。

- 画面固有の責務を早く下位へ押し出していないか。反対に、実際に共有する業務処理が重複していないか。
- 依存方向、同一レイヤーの別 slice、公開 API の迂回、自己 index 経由の循環がないか。type-only、再 export、dynamic import、相対パスも追う。
- Shared に上位の業務処理や画面への依存が流入していないか。server / client の境界を barrel が壊していないか。
- lint が対象ファイルを実際に検査し、導入済みルールの違反を CI で失敗させるか。ignore や warn への変更で問題を隠していないか。
- 移動で認証、query key、invalidation、更新停止、エラー表示、CSP が変わっていないか。

指摘は、導入済みの規則と具体的な影響に結び付ける。提案中のディレクトリ名との差だけで不具合としない。通常のレビュー観点・結果の報告は [review スキル](../review/SKILL.md) と併用する。

## 参照先

必要な論点だけを読む。ツールの版や公式ガイドの推奨が変わりうるため、導入・更新時は現在の一次資料を確認する。

- 配置: [Layers](https://fsd.how/docs/reference/layers/)、[Slices and segments](https://fsd.how/docs/reference/slices-segments/)、[Pages first](https://fsd.how/docs/guides/migration/from-v2-0/)
- 境界: [Public API](https://fsd.how/docs/reference/public-api/)
- フレームワーク: [Next.js](https://fsd.how/docs/guides/tech/with-nextjs/)、[TanStack Query](https://fsd.how/docs/guides/tech/with-react-query/)
- 機械的な検査: [Steiger](https://github.com/feature-sliced/steiger)
