# 内部依存関係のベースライン

対象は `ac21639` の追跡済み TS・TSX・MJS・CJS のうち、テストとテスト専用の `testing.ts` を除いた 264 ファイル。Babel の構文木から import、再 export、リテラルの動的 import と require、型 import を抽出し、相対パス・TS alias・workspace exports を解決した。634 件の内部参照を 77 の論理モジュールに集約した。マイグレーション、CSS、外部パッケージ、シェルコマンド、ランタイムの Binding は別の境界として[全体図](README.md)で扱う。動的な `SHARP_PATH` は通知素材作成スクリプトの外部入力。

ファイル単位の実行時 import に循環は 0 件。型参照を合わせると、API の `bindings.ts`、`runner-container.ts`、`run-start.ts`、`github-egress.ts`、`model-egress.ts`、`session-stream.ts` が 1 つの強連結成分になった。表は階層を集約しているため、ファイル単位では循環していない双方向の参照も含む。

[Bindings の整理](progress.md#ラウンド-3-cloudflare-bindings-の依存方向)の後は、同じ方法で 265 ファイルと 639 件の内部参照を検査し、実行時・型参照ともに循環は 0 件だった。以下の表は着手前の参照点として残す。

矢印の向きはインポートする側から依存先へ。`(型)` は同じ辺に実行時の参照がないことを示す。各表の相対パスはそのセクションのルートから。

## 現在のグラフを確認する

依存関係の詳細はリポジトリルートで `node lint/internal-dependencies.mjs` を実行すると JSON で取得できる。ファイルごとに依存先と `runtime` または `type` を返す。依存解決の対象は相対パス、`@/`、`@tailos/*` のパッケージ公開入口。対象ファイルを解析できない場合や内部依存を解決できない場合は失敗する。外部パッケージとリテラルのない動的パスは対象範囲外。

`pnpm test` は同じ構文解析で循環を検出し、型だけの循環でも依存経路を出して失敗する。本番コードからテスト専用ファイルへの参照も検査エラーになる。アプリや共有パッケージから別の workspace パッケージへ依存するときは、呼び出し元の `package.json` に依存を宣言し、依存先の `exports` を使う。型専用の公開入口は型参照に限り、実行時は `import` または `require` に対応する公開入口を解決する。パッケージに属さない `tools` や `lint` は専用スクリプトの依存として集計する。`pnpm lint` は別途、API と Web のレイヤーや公開入口を検査する。

## API

ルートは `apps/api/`。

| モジュール | 依存先 |
| --- | --- |
| `drizzle.config.ts` | — |
| `scripts` | `src/application/auth`, `src/infrastructure/auth`, `src/infrastructure/d1` |
| `src/application/auth` | `packages/core/src/models.ts` (型), `packages/core/src/runner.ts` (型) |
| `src/application/diagnostics` | `packages/core/src/diagnostics.ts` (型) |
| `src/application/inspection` | `src/application/diagnostics` (型) |
| `src/application/notifications` | `packages/core/src/runner.ts` (型) |
| `src/application/projects` | `src/application/triggers` |
| `src/application/routines` | `src/application/auth`, `src/application/projects` (型), `src/application/triggers`, `packages/core/src/models.ts`, `packages/core/src/runner.ts` |
| `src/application/runs` | `packages/core/src/runner.ts` |
| `src/application/sessions` | `src/application/auth`, `src/application/projects` (型), `src/application/triggers`, `packages/core/src/diagnostics.ts` (型), `packages/core/src/models.ts`, `packages/core/src/runner.ts`, `packages/core/src/timeline.ts` |
| `src/application/triggers` | — |
| `src/bindings.ts` | `src/application/auth` (型), `src/infrastructure/cloudflare` (型), `src/infrastructure/r2` (型) |
| `src/bootstrap` | `src/application/auth`, `src/application/notifications`, `src/bindings.ts` (型), `src/infrastructure/auth`, `src/infrastructure/cloudflare`, `src/infrastructure/d1`, `src/infrastructure/diagnostics`, `src/infrastructure/github`, `src/infrastructure/inspection.ts`, `src/infrastructure/r2`, `src/presentation/http`, `packages/core/src/auth.ts` |
| `src/infrastructure/auth` | `src/application/auth`, `src/bindings.ts` (型), `src/infrastructure/d1`, `packages/core/src/auth.ts` |
| `src/infrastructure/cloudflare` | `src/application/auth`, `src/application/diagnostics`, `src/application/routines`, `src/application/runs` (型), `src/bindings.ts` (型), `src/infrastructure/auth`, `src/infrastructure/d1`, `src/infrastructure/diagnostics`, `src/infrastructure/github`, `packages/core/src/diagnostics.ts`, `packages/core/src/runner.ts`, `packages/core/src/timeline.ts` |
| `src/infrastructure/d1` | `src/application/auth` (型), `src/application/inspection` (型), `src/application/notifications` (型), `src/application/projects`, `src/application/routines`, `src/application/runs`, `src/application/sessions`, `src/application/triggers`, `src/infrastructure/diagnostics`, `src/infrastructure/r2`, `packages/core/src/diagnostics.ts`, `packages/core/src/runner.ts`, `packages/core/src/timeline.ts` |
| `src/infrastructure/diagnostics` | `src/application/diagnostics`, `src/application/runs` (型), `src/infrastructure/d1`, `src/infrastructure/r2` (型), `packages/core/src/diagnostics.ts`, `packages/diagnostics` |
| `src/infrastructure/github` | `src/application/notifications`, `src/application/projects` (型), `packages/core/src/runner.ts` |
| `src/infrastructure/inspection.ts` | `src/application/inspection` (型), `src/bindings.ts` (型), `src/infrastructure/d1`, `src/infrastructure/diagnostics`, `src/infrastructure/r2` |
| `src/infrastructure/r2` | `src/application/runs` (型), `packages/core/src/runner.ts` |
| `src/presentation/http` | `src/application/auth`, `src/application/diagnostics` (型), `src/application/inspection` (型), `src/application/projects`, `src/application/routines`, `src/application/runs` (型), `src/application/sessions`, `src/application/triggers`, `src/bindings.ts` (型), `src/presentation/mcp`, `packages/core/src/diagnostics.ts`, `packages/core/src/models.ts`, `packages/core/src/runner.ts` |
| `src/presentation/mcp` | `src/application/inspection` (型) |
| `src/worker.ts` | `src/application/runs`, `src/bindings.ts` (型), `src/bootstrap`, `src/infrastructure/cloudflare`, `src/infrastructure/d1`, `src/infrastructure/diagnostics` |
| `vitest.config.ts` | — |

## Runner

ルートは `apps/runner/`。

| モジュール | 依存先 |
| --- | --- |
| `scripts` | — |
| `src/agent-turns.ts` | `src/agent.ts` (型), `packages/core/src/runner.ts` |
| `src/agent.ts` | `src/continuity.ts` (型), `packages/core/src/diagnostics.ts` (型), `packages/core/src/runner.ts` (型) |
| `src/claude-agent.ts` | `src/agent-turns.ts`, `src/agent.ts`, `src/continuity-notice.ts`, `src/continuity.ts`, `src/diagnostic-operations.ts`, `src/egress.ts`, `src/github-tool.ts`, `packages/core/src/diagnostics.ts` (型), `packages/core/src/models.ts` |
| `src/codex-agent.ts` | `src/agent-turns.ts`, `src/agent.ts`, `src/codex-rpc.ts`, `src/continuity-notice.ts`, `src/continuity.ts`, `src/diagnostic-operations.ts`, `src/egress.ts`, `src/github-tool.ts`, `src/retired-tools.ts`, `packages/core/src/diagnostics.ts` (型), `packages/core/src/models.ts`, `packages/core/src/runner.ts` (型) |
| `src/codex-rpc.ts` | — |
| `src/continuity-notice.ts` | — |
| `src/continuity.ts` | `packages/core/src/runner.ts` |
| `src/diagnostic-operations.ts` | `packages/core/src/diagnostics.ts` (型) |
| `src/diagnostics.ts` | `packages/core/src/diagnostics.ts`, `packages/core/src/runner.ts` (型), `packages/core/src/timeline.ts`, `packages/diagnostics` |
| `src/egress.ts` | — |
| `src/git-workspace.ts` | `src/agent.ts` (型), `src/continuity.ts`, `src/diagnostic-operations.ts`, `src/egress.ts`, `packages/core/src/diagnostics.ts` (型), `packages/core/src/runner.ts` |
| `src/github-tool.ts` | `packages/core/src/runner.ts` |
| `src/index.ts` | `src/server.ts` |
| `src/retired-tools.ts` | — |
| `src/server.ts` | `src/agent.ts`, `src/claude-agent.ts`, `src/codex-agent.ts`, `src/diagnostic-operations.ts`, `src/diagnostics.ts`, `src/git-workspace.ts`, `packages/core/src/runner.ts` |
| `vitest.config.ts` | — |

## Web

ルートは `apps/web/`。

| モジュール | 依存先 |
| --- | --- |
| `scripts` | — |
| `src/_pages/account` | `src/shared/api`, `src/shared/config`, `src/shared/ui` |
| `src/_pages/connect` | `src/shared/api`, `src/shared/ui`, `src/widgets/request-state` |
| `src/_pages/diagnostics` | `src/shared/api`, `src/shared/ui`, `src/widgets/request-state`, `packages/core/src/diagnostics.ts` |
| `src/_pages/home` | `src/entities/account`, `src/entities/session`, `src/features/compose-loop`, `src/features/select-project`, `src/shared/api`, `src/shared/lib`, `src/shared/ui`, `src/widgets/page-shell`, `src/widgets/request-state`, `packages/core/src/models.ts` (型) |
| `src/_pages/mcp-keys` | `src/shared/api`, `src/shared/ui`, `src/widgets/request-state` |
| `src/_pages/projects` | `src/entities/routine`, `src/shared/api`, `src/shared/ui`, `src/widgets/request-state`, `packages/core/src/models.ts` |
| `src/_pages/routines` | `src/entities/account`, `src/entities/routine`, `src/entities/session`, `src/features/select-project`, `src/shared/api`, `src/shared/lib`, `src/widgets/page-shell`, `src/widgets/request-state`, `packages/core/src/models.ts` |
| `src/_pages/session-detail` | `src/entities/account`, `src/entities/session`, `src/features/compose-loop`, `src/shared/api`, `src/shared/config`, `src/shared/ui`, `src/widgets/page-shell`, `src/widgets/request-state`, `packages/core/src/models.ts`, `packages/core/src/timeline.ts` |
| `src/app` | `src/_pages/account`, `src/_pages/connect`, `src/_pages/diagnostics`, `src/_pages/home`, `src/_pages/mcp-keys`, `src/_pages/projects`, `src/_pages/routines`, `src/_pages/session-detail`, `src/entities/account`, `src/entities/session`, `src/features/select-project`, `src/shared/api`, `src/widgets/page-shell` |
| `src/entities/account` | `src/shared/api` |
| `src/entities/routine` | `src/shared/api` |
| `src/entities/session` | `src/shared/api`, `src/shared/lib` |
| `src/features/compose-loop` | `src/shared/ui`, `packages/core/src/models.ts` |
| `src/features/select-project` | `src/shared/api`, `src/shared/ui` |
| `src/shared/api` | `apps/api/src/bootstrap` (型), `src/shared/config`, `packages/core/src/auth.ts` |
| `src/shared/config` | `packages/core/src/auth.ts` |
| `src/shared/lib` | — |
| `src/shared/ui` | `src/shared/lib` |
| `src/widgets/page-shell` | `src/entities/account`, `src/entities/session`, `src/features/select-project`, `src/shared/lib`, `src/shared/ui` |
| `src/widgets/request-state` | `src/shared/ui` |
| `src/worker` | `src/shared/config`, `packages/core/src/auth.ts` |
| `steiger.config.ts` | — |
| `vite.config.ts` | `packages/core/src/auth.ts` |
| `vitest.config.ts` | — |

## 共有パッケージ

ルートは `packages/`。

| モジュール | 依存先 |
| --- | --- |
| `core/src/auth.ts` | — |
| `core/src/diagnostics.ts` | — |
| `core/src/models.ts` | — |
| `core/src/runner.ts` | `core/src/diagnostics.ts` |
| `core/src/timeline.ts` | — |
| `diagnostics` | — |

## ツールと検査

| モジュール | 依存先 |
| --- | --- |
| `lint/api-layers.mjs` | — |
| `lint/no-nested-ternary.mjs` | — |
| `lint/web-boundaries.mjs` | — |
| `tools/pdr` | — |
| `tools/preview` | `apps/api/scripts`, `packages/core/src/auth.ts` |
