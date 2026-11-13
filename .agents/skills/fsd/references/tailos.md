# Tailos での適用

## 構成

- `apps/web`: Vinext / React / TanStack Query / Tailwind CSS / Cloudflare Worker。
- `src/app`: `page.tsx`、layout、Provider、全体 CSS、health handler。画面の組み立てとルートパラメーターの解決を担当。
- `src/_pages`: `account`、`connect`、`mcp-keys`、`session-detail`、`diagnostics`。各 slice の公開入口は `index.ts`、画面本体は `ui/`、取得・mutation・query key は `api/`。
- `src/shared/api`: `@tailos/api/browser` を type-only import する Hono Client。Cookie の credentials を保持。
- `src/shared/config`: 公開可能な API origin。Worker と client の双方から利用。
- `src/widgets/request-state`: ログイン誘導を含む、保護された画面の共通の失敗表示。401 はここで扱い、その他の失敗は Shared の表示を使う。
- `src/shared/ui/request-state`: 業務に依存しない404・再試行表示。401 をログアウト状態に変換する account slice はこれを直接使う。
- `src/worker`: CSP などを付ける既存 Worker とテスト。Wrangler の `main` は既存配置のまま。

全ソースを `apps/web/src` 内に置き、独立した `_app` は作らない。Features / Entities は実際の再利用が生まれたときに追加し、空ディレクトリを作らない。

## import と検査

- `@/*` は Web の `src/*` を指す。ルートからは `@/_pages/account` など公開 API を使い、ルート同士を参照しない。
- query key・取得・mutation・invalidation は所有する slice にまとめる。Provider と QueryClient の生成は App。MCP キーの平文は mutation の返り値や cache に残さず画面の一時 state に閉じる。
- `_pages` / Features / Entities / Shared から App / Worker への依存は禁止。Worker は公開設定だけを参照し、client / React / 画面を import しない。
- `pnpm lint` は `lint:code`（Oxlint、API / Web の境界 rule）と `lint:fsd`（Steiger）を実行し、CI の lint job に含まれる。
- Steiger は `0.9.0`、公式 plugin は `0.8.2`。`apps/web/steiger.config.ts` が正本。`src/app` と `src/worker` はフレームワーク規約のため除外し、独自 Oxlint rule が import の境界を補う。`_pages` の typo 診断だけを局所的に無効にし、依存検査は有効のまま。
- `lint/web-architecture.test.mjs` は導入済み config と実際の CLI で正常例・禁止例を検証する。`pnpm test` と CI の test job に含まれる。
- slice 内は相対 import。Shared の segment 間でも Steiger の import-locality に合わせて相対 import を使う。
- ファイル監視を制限する環境で Steiger が `EMFILE` / `watch` エラーになった場合は、`CHOKIDAR_USEPOLLING=1 pnpm lint` / `CHOKIDAR_USEPOLLING=1 pnpm test` で実行する。

## 対象外と挙動

`apps/api` のレイヤー、Runner の Adapter、`packages/core` の共有契約は既存設計に従う。Web の FSD を理由にこれらを並べ替えない。

URL、検索パラメーター、query key、polling・retry、認証・Cookie、CSP、health の契約は移動と一緒に変えない。変更が必要なら既存 PDR を検索する。`PDR-20261113-002` は挙動を保つ内部整理に新しい承認を必須としていないが、未合意のプロダクト判断を許可するものではない。
