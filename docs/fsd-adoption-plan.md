# Web の FSD 導入計画

状態: 導入済み。2026-11-13 に調査し、2026-11-14 に配置・lint・CI の導入を実施した。移行手順と移行前の対応表を含むため、現行構成はソースと設定も確認する。Features / Entities の抽出は、今後実際の再利用が生じたときに行う。

2026-11-14 更新: ソースは `apps/web/src` 内に収め、`src/app` にルート、`src/_pages` に画面本体を置く。独立した `_app` は設けない。

## 推奨する方針

`apps/web` に FSD を導入する。Oxlint / Oxfmt は維持し、構造の検査には Steiger を追加する。最初は App・Pages・Shared を中心に移行し、複数の画面で再利用する業務ロジックができたときに Features・Entities を使う。空のレイヤーや slice を先に作らない。

API と Runner に FSD は適用しない。`apps/api` の application / presentation / infrastructure / bootstrap と `tailos/api-layers` は維持する。`packages/core` は実行環境に依存しない共有契約、`packages/diagnostics` は既存の責務を保ち、Web の slice を移す場所にはしない。

5つの page slice、Shared の通信・設定・汎用 UI、FSD 知識スキル、実装・レビューからの参照導線を導入した。`pnpm lint` は Oxlint と Steiger、`pnpm test` は境界 lint の CLI 回帰テストを含み、既存 CI の lint / test job から実行する。

## 調査から採用する点

- [`isc-fes` の lint](https://github.com/ISC-MakeIT/isc-fes/blob/dc8e970bf2723cf7a3e165fcd67a6b1a67a1e180/frontend/package.json) は `oxlint && steiger ./src`。Tailos の既存ツールを生かせる。
- [ルートの実例](https://github.com/ISC-MakeIT/isc-fes/blob/dc8e970bf2723cf7a3e165fcd67a6b1a67a1e180/frontend/src/app/login/page.tsx) はルーティングと検索パラメーターを扱い、画面を `_pages/login` の公開 API から呼ぶ。[slice の入口](https://github.com/ISC-MakeIT/isc-fes/blob/dc8e970bf2723cf7a3e165fcd67a6b1a67a1e180/frontend/src/_pages/login/index.ts) は必要なコンポーネントだけを export する。この責務分離を参考にする。
- [FSD 2.1](https://fsd.how/docs/guides/migration/from-v2-0/) は Pages から始め、単一画面の UI・ロジックをその画面に残す考え方。既存の約 1,000 行の Web を、名詞・ボタンごとに分割する必要はない。
- [Next.js 向け公式ガイド](https://fsd.how/docs/guides/tech/with-nextjs/) はフレームワークとの衝突回避に `_app` / `_pages` を案内している。Tailos では Pages のみ `_pages` とし、App の責務は既存の `src/app` にまとめる。フレームワークのルート規約を優先するローカルな配置として、構造 lint の対象と import の境界を明示する。
- [`isc-fes` の Steiger 設定](https://github.com/ISC-MakeIT/isc-fes/blob/dc8e970bf2723cf7a3e165fcd67a6b1a67a1e180/frontend/steiger.config.ts) には `_pages` の typo 判定の抑制と Entities の分割粒度への警告がある。これは参考リポジトリの例外であり、Tailos にそのまま複写しない。公式ガイドでは接頭辞対応が案内されており、導入する版で必要性を確認する。

## 導入した配置

ソースは `apps/web/src` 内に置く。`src/app` がルーティングとアプリ全体の組み立てを担当し、`src/_pages` が画面ごとの UI・取得処理・状態を担当する。Provider・layout・全体 CSS は `src/app` に残す。Worker は既存の `src/worker` に置く。App のための別ディレクトリは増やさない。

```text
apps/web/
├── src/
│   ├── app/                     # Vinext のルートと App の責務
│   │   ├── layout.tsx           # HTML、metadata、ヘッダー、ナビゲーション
│   │   ├── providers.tsx        # QueryClient の生成と Provider
│   │   ├── styles.css          # アプリ全体の CSS
│   │   ├── page.tsx            # / → account slice
│   │   ├── login/page.tsx      # /login → 同じ account slice
│   │   ├── connect/page.tsx
│   │   ├── mcp/page.tsx
│   │   ├── diagnostics/page.tsx
│   │   ├── sessions/[id]/page.tsx
│   │   └── health/route.ts
│   ├── worker/                  # 既存の Worker、CSP、関連テスト
│   ├── _pages/                  # 画面ごとの slice
│   │   ├── account/
│   │   │   ├── index.ts         # 公開 API
│   │   │   ├── ui/              # AccountPage、Account
│   │   │   └── api/             # account の queryOptions / 取得処理
│   │   ├── connect/             # ui/、api/、必要な場合のみ model/
│   │   ├── mcp-keys/
│   │   ├── session-detail/
│   │   └── diagnostics/
│   └── shared/                  # slice を作らず segment に分ける
│       ├── api/                 # Hono Client の transport と型の入口
│       ├── config/              # API origin など公開可能な設定
│       ├── ui/                  # 業務に依存しない RequestState など
│       └── lib/                 # 用途が明確な汎用関数が必要になった場合
├── public/                      # URL で配信する既存画像・favicon
├── steiger.config.ts
├── vite.config.ts
├── vitest.config.ts
└── wrangler.jsonc
```

`api` / `model` / `lib` などの segment は実体が必要なときだけ作る。`hooks` / `components` / `utils` / `types` という種類別の大きな置き場は新設せず、処理の目的に応じた `api` / `model` / `ui` 内に置く。型は利用する処理の近くに置く。

Features は再利用するユーザー操作と、それを実行する UI・状態をまとめる。Entities は再利用する業務概念の型・読み取り・表現をまとめる。例えば複数画面で Session の取得と表示を共有するようになれば `entities/session`、接続操作を複数画面で提供するなら `features/connect-chatgpt` を検討する。今の Session 詳細や接続画面を移すだけで、これらを作る必要はない。

Processes は使わない。Widgets も初期導入では作らない。現在の公式 Layers ガイドは Features との責務の重複を理由に Widgets の使用を非推奨としており、単一画面の UI は Pages、再利用する操作は Features、業務を持たない UI は Shared、全体の layout は App に置く。

## 移行前後の配置と責務

以下のパスは `apps/web/src` からの相対パス。

| 移行前 | 導入後・扱い |
| --- | --- |
| `app/page.tsx`、`app/login/page.tsx` | 配置を維持し、両方が `_pages/account` の同じ公開画面を使う。ルート同士を import しない。`searchParams` の await と変換はルートに残す。 |
| `app/login/account.tsx` | `_pages/account/ui/account.tsx`。取得は同じ slice の `api/` へ必要に応じて分離。 |
| `app/connect/page.tsx` | ルートは維持し、画面本体を `_pages/connect/ui/connect-page.tsx` へ。取得・更新・query key は同じ slice の `api/`。 |
| `app/mcp/page.tsx` | ルートは維持し、画面本体を `_pages/mcp-keys/ui/mcp-keys-page.tsx` へ。キー作成・失効・一度だけ見せる値の状態はこの slice 内。 |
| `app/sessions/[id]/*` | `page.tsx` は維持し、本体を `_pages/session-detail/ui/` へ。`params` の解決はルート、取得と polling は slice。 |
| `app/diagnostics/*` | `page.tsx` は維持し、Explorer と本文表示を `_pages/diagnostics/ui/`、一覧・イベント・本文取得を同じ slice の `api/` へ。 |
| `app/api.ts` | `shared/api/client.ts` と公開入口 `shared/api/index.ts`。`@tailos/api/browser` は引き続き type-only import。 |
| `api-origin.ts` | `shared/config/api-origin.ts` と公開入口 `shared/config/index.ts`。Worker もここから設定を読み、Hono Client を経由しない。 |
| `app/request-state.tsx` | 汎用の失敗表示を `shared/ui/request-state/`。401 時の GitHub ログイン導線は呼び出し側から ReactNode などで渡す。Shared に `/login` と業務文言を固定しない。既存の見た目とリンクは保つ。 |
| `app/providers.tsx` | 配置を維持。QueryClient の生成と retry 設定はここで管理。 |
| `app/layout.tsx` | 配置を維持。metadata、ヘッダー、HTML 全体、Provider の組み立てを担当。 |
| `app/styles.css` | 配置を維持し、`app/layout.tsx` から読み込む。 |
| `app/health/route.ts` | 配置とレスポンスを維持。単純な health handler のために別の実装ファイルを作らない。 |
| `worker/index.ts` とテスト | 配置と Wrangler の `main` を維持。API origin の参照先変更に合わせて import / mock を更新。 |

### API・状態管理

`shared/api` は base URL、credentials などの通信基盤を担当する。画面固有の endpoint、query key、`queryOptions`、mutation、invalidate は所有する slice の `api/` に置く。フォーム・フィルター・選択中の値はローカル state から始め、複雑になれば `model/` へ移す。

query key を全部まとめたグローバルファイルは作らない。再利用が生じたら取得処理と key を同じ下位 slice にまとめる。API レスポンスの型を Web 用に複製したり、バックエンドの application / infrastructure を実行時 import したりしない。

`"use client"` は hooks やイベントを使うコンポーネントの入口で保持する。共有の `index.ts` に server 専用モジュールを混ぜて client graph に伝播させない。混在が実際に必要な slice では公式の `index.server.ts` 方式を使い、lint もその公開入口を検査する。

## import と公開 API のルール

依存は `app → _pages → features → entities → shared` の下向き。途中のレイヤーは飛ばしてよい。Pages / Features / Entities の同一レイヤーの別 slice は互いに import しない。同じ slice 内の segment 間の import は可能。App / Shared は slice を持たない。`app` 内はフレームワークのファイル規約を優先し、layout から Provider を参照するなどアプリ全体の組み立てを行う。

- slice 外からは `@/_pages/connect`、`@/entities/session` のように公開入口を使う。`@/_pages/connect/ui/connect-page` のような内部参照は禁止。
- slice 内は相対 import を使い、自分の `index.ts` を経由しない。循環依存を避ける。
- `index.ts` は名前を明示して export する。`export *` とレイヤー全体を束ねる `_pages/index.ts` / `entities/index.ts` は作らない。
- `shared/api` / `shared/config` は segment の入口、`shared/ui/request-state` や `shared/lib/date` は各モジュールの入口を使う。`shared/index.ts` や全 UI を集める巨大な barrel は作らない。
- Entities 間で型の関連を表す必要がある場合だけ `entities/A/@x/B.ts` を検討する。Features / Pages の横断や循環依存を許す用途に流用しない。初期移行では不要。
- `app/**/page.tsx` は `_pages` の公開画面を呼び、ルートパラメーターの解決と接続を担当する。画面の UI・取得処理・状態は `_pages` に置き、他のルートや slice 内部を直接参照しない。
- `_pages` / Features / Entities / Shared から `app` や `worker` への依存は禁止。`worker` は起動処理とヘッダー付与を担当し、公開設定を Shared から参照する。画面を直接 import しない。

## lint の設計

### 役割と実行経路

| ツール | 担当 |
| --- | --- |
| Oxfmt | 既存の整形。設定を維持する。 |
| Oxlint | 既存のコード品質と `tailos/api-layers`。Steiger の検査外となるルート adapter・ワークスペース境界の不足だけを補う。 |
| Steiger + `@feature-sliced/steiger-plugin` | FSD の依存方向、slice の隔離、公開 API、ディレクトリ構造。 |
| TypeScript / Vitest / Worker build | 型、実行時の振る舞い、RSC と Cloudflare の統合。構造 lint だけでは保証できない。 |

ルート devDependencies に Steiger `0.9.0` と FSD plugin `0.8.2` を exact pin で追加し、lockfile も更新した。Steiger は Node 22.18 以上を要求し、CI は Node 22 を使用する。既存の公開後5日待機ルールを満たす版を選んだ。ESLint は追加しない。

導入した scripts は次の形。Steiger の設定探索を安定させるため Web を cwd にする。

```jsonc
// root package.json の scripts（抜粋）
{
  "lint:code": "oxlint --threads=1 --no-error-on-unmatched-pattern .",
  "lint:fsd": "pnpm --filter @tailos/web run lint:fsd",
  "lint": "pnpm run lint:code && pnpm run lint:fsd"
}
```

```jsonc
// apps/web/package.json の scripts（抜粋）
{
  "lint:fsd": "steiger ./src"
}
```

これで現行 CI の `pnpm lint` に必ず FSD 検査が入る。CI の新しい job は不要。移行済みモジュールに error があれば失敗させる。既存領域の一時例外はファイル・rule・解消する移行単位を限定し、全体を warn / ignore にしない。FSD lint が正常・異常 fixture で機能することを確認してから CI に接続する。

### ルールの選び方

`apps/web/steiger.config.ts` は `defineConfig` と `fsd.configs.recommended` を使う。主要な禁止事項は error。`_pages` は依存判定上 Pages として認識される一方、名前の typo 診断が出るため、このパスの `fsd/typo-in-layer-name` だけを無効にした。CLI 回帰テストで `_pages` に対する上位参照と slice 横断の検出を確認する。

`src/app/**` はフレームワーク規約、`src/worker/**` は Worker の起動規約に従うため、通常の FSD の segment・公開 API 配置を強制しない。この二つは Steiger の対象から除外し、Oxlint のコード品質検査と後述の境界 rule で import を検査する。`src/_pages`・Features・Entities・Shared は Steiger の検査対象にする。この配置上の例外と、移行中だけの一時例外を区別する。

| ルール | 目的・設定 |
| --- | --- |
| `fsd/forbidden-imports` | 上位参照と同じレイヤーの別 slice 参照を error。古い個別ルールとの二重設定はしない。 |
| `fsd/public-api`、`fsd/no-public-api-sidestep` | 公開入口の存在と内部への直接 import を検査。 |
| `fsd/no-layer-public-api` | レイヤー単位の barrel を禁止。 |
| `fsd/no-segmentless-slices`、`fsd/no-segments-on-sliced-layers` | slice / segment の階層を検査。 |
| `fsd/no-processes` | 非推奨レイヤーの追加を禁止。 |
| `fsd/import-locality`、`fsd/no-wildcard-exports` | 公式 README では既定無効。上の import 方針に合わせて明示的に error で有効化。 |
| `fsd/insignificant-slice`、`fsd/excessive-slicing` | 分割の妥当性は warn とレビューで判断。未再利用という理由だけで機械的に統合しない。 |

Steiger は beta であり、設定を写すだけでは検査の有効性を保証できない。以下の受入条件に対し、`lint/web-architecture.test.mjs` は導入済み config と実際の Oxlint / Steiger CLI を一時プロジェクトで実行する。

1. `_pages` が Pages として解釈され、Features・Entities・Shared との依存方向が検査される。typo の警告だけを止めても、依存判定が有効とは限らない。
2. Shared のモジュール別公開入口、`index.server.ts`、同居テストが想定どおり扱われる。必要な調整はその入口・rule に限定し、Shared 全体の公開 API 検査を止めない。
3. alias・相対パス・type-only import・再 export・静的な dynamic import のいずれでも禁止された依存を検出する。非静的な動的 import で境界を迂回できないかも確認する。
4. `src/app`・`src/worker` と下位レイヤーの間、`@tailos/api/browser` の type-only 制約、API 内部への相対パス参照を `lint/web-boundaries.mjs` の小さな Oxlint rule で検査する。Steiger の除外設定に依存せず全 Web ソースの import を見て、下位→App / Worker、ルートからの deep import、Worker からの画面参照を検出する。既存 `lint/api-layers.mjs` の登録方式に合わせる。

境界 lint の fixture は、ルートから公開 API 経由の正常例、layout から Provider の正常例、Worker から公開設定の正常例、同一 slice 内の正常例、下位→上位、別 slice の横断、deep import、下位から `app` / `worker` への参照、ルートからの deep import、ルート同士の参照、Worker からの画面参照、API 実装の value import を用意する。alias と相対パスの両方を含め、正常例の exit 0 と異常例の非 0 を確認する。これらの恒久テストは `pnpm test` に接続済み。

## 段階的な実施順序

| 単位 | 作業 | 完了条件 |
| --- | --- | --- |
| 0. 計画と知識（完了） | この計画、`fsd` スキル、AGENTS / review からのリンクを追加。 | 実装・レビューで導入済みの配置を参照できる。 |
| 1. ツールの検証（完了） | Steiger の互換版と config を試し、上記 fixture で接頭辞・公開 API・境界を検証する。 | 有効な設定と不足分が確定し、検査を無効化して通す状態ではない。 |
| 2. 共通基盤（完了） | `src/app` と `src/worker` の配置を維持し、通信基盤と公開設定を Shared へ移す。未移行の画面本体は一時的にルートに残す。 | TypeScript の include と Wrangler の `main` は既存設定を使用。import / mock、関連ドキュメントを更新。Worker build・ルートの到達・CSP テストが通る。未移行ファイルの例外を明記。 |
| 3. Pages への移動（完了） | account → connect → mcp-keys → session-detail → diagnostics の順に画面単位で移す。RequestState の汎用表示とログイン導線を分ける。 | 各ルートが公開 API を使用し、移行した画面の例外を削除。各単位で完結した build ができる。 |
| 4. CI で強制（完了） | 移行中の一時例外を解消し、root の `pnpm lint` に FSD と境界 lint を接続。 | 全画面の本体が `_pages` にあり、`src/app` にルートと全体の組み立てが残る。旧 `src/app/api.ts` / `src/app/request-state.tsx` / `src/api-origin.ts` を削除し、境界の異常例が CI で失敗する。 |
| 5. 継続運用 | 実際の再利用に合わせて Features / Entities を抽出。スキルの Tailos 固有説明を実装と同期する。 | 見込みだけの抽象化をせず、新しい境界と公開 API を検査できる。 |

単位 0〜4 を実施し、移行中の一時例外は残していない。恒久的なフレームワーク配置の例外は `app` / `worker` のみ。単位 5 は継続運用とする。

## 検証と挙動の保持

各実装単位では現行 CI と同じコマンドを使う。

```sh
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm --filter @tailos/web run build
```

構造変更のためだけにすべての UI を単体テストにしない。Worker の既存テストを参照先の更新後も実行し、境界 lint の正常・異常例、取得ロジックを分離した際の意味のある回帰箇所を検証する。

移行時の smoke 確認は `/`、`/login`、`/connect`、`/mcp`、`/sessions/:id`、`/diagnostics`、`/health`。ログイン前後、401 / 404 / 通信失敗と再試行、接続開始・解除、MCP キーの一度だけの表示、Session と diagnostics の更新停止条件を確認する。実データや資格情報が必要な操作は fixture / 検証環境で行う。

既存の URL、表示文言、query key、polling 間隔・停止条件、retry、Cookie / credentials、CSP・nonce、Origin / CORS、health のレスポンスは移動に伴って変更しない。変更が必要になった場合は独立したプロダクト判断として扱う。

PDR は FSD・フロントエンド・Vinext・認証境界・lint・`apiOrigin` と関連パスで検索した。今回の内部整理に直接適用する採択済み FSD 方針は確認できなかった。確認した `PDR-20261113-002` は、挙動を保つ内部整理まで新しい承認を要求しないと定めている。今回の内部構成と lint の導入を、将来の UX・既定値・エラー挙動の変更への合意とは扱わず、挙動変更時は個別に検索・記録する。今回は PDR レコードを変更しない。

## 知識スキルの運用

- `.agents/skills/fsd/SKILL.md` に FSD 共通の依存・配置・公開 API の判断基準と、実装／レビューの使い方を置く。
- Tailos の現行構成、段階移行の扱い、参照先は `references/tailos.md` に分ける。実装済みの配置と、将来の抽出候補を区別する。
- ルート AGENTS から Web の実装時に参照し、review スキルから Web の構成レビュー時に参照する。API / Runner だけの変更には適用しない。
- スキルは lint の代わりにせず、slice の責務・再利用の必要性・server / client 境界など lint で判断できない部分を補う。

## 公式の参照先

- [Overview](https://fsd.how/docs/get-started/overview/) / [Layers](https://fsd.how/docs/reference/layers/)
- [Slices and segments](https://fsd.how/docs/reference/slices-segments/) / [Public API](https://fsd.how/docs/reference/public-api/)
- [Pages first への移行](https://fsd.how/docs/guides/migration/from-v2-0/)
- [Next.js](https://fsd.how/docs/guides/tech/with-nextjs/) / [TanStack Query](https://fsd.how/docs/guides/tech/with-react-query/)
- [Steiger の導入・設定・ルール](https://github.com/feature-sliced/steiger)
