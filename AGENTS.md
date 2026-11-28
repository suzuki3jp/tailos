# Tailos

Tailos は GitHub Issue を起点に Codex を実行し、変更を PR として提出する pnpm ワークスペースです。

- 変更の検証には [CI](.github/workflows/ci.yml) と同じコマンドを使う。
- レビューには [review スキル](.agents/skills/review/SKILL.md) の観点を使う。
- lint ルールを作成・変更するときは [lint スキル](lint/SKILL.md) に従う。
- Web の配置・依存関係・データ取得・Loading・Server/Client 境界を設計、実装、レビューするときは [fsd スキル](.agents/skills/fsd/SKILL.md) に従う。
- 共有 D1 を使う PR Preview で新しいスキーマが必要なら、既存コードと互換性のある migration を先行 PR に分ける。必要な migration が本番と Preview 用の D1 に適用されたことを確認してから、機能 PR を Preview に出す。[migration を伴う機能の確認](docs/pr-previews.md#migration-を伴う機能の確認)

## Product Decision Records

- プロダクトの挙動を変える前に `pnpm pdr search "論点" --path 対象ファイル` で関連する判断を探す。PDR の一覧や全本文を最初から読み込まない。
- 判断に使う候補は `pnpm pdr show ID --section decision,scope,rationale` で範囲・例外・理由まで確認する。キーが分かれば `pnpm pdr resolve key` で現行の採択済み判断を確認する。
- `proposed` / `unverified` / `rejected` / `superseded` は現行方針として扱わない。検索ゼロ件も判断が存在しない証拠ではない。用語・識別子・別の関連パスでも探す。
- 新しい裁量あるプロダクト判断（既定値・上限・待機・失敗時の挙動を含む）は、[PDR の運用](docs/pdr/README.md) に従い、人間と合意してから依存する実装に進む。既に明確なユーザー指示がある場合は判断・理由・範囲を PDR 本文に記録し、同じ承認を取り直さない。チャット本文・抜粋・承認リンクは保存しない。影響しない調査・作業は続けられる。
- 既存 PDR と新しいユーザー指示が異なる場合は変更点を示し、その指示に沿って後継 PDR を用意する。過去の理由を推測で埋めず、コードの LGTM と人間のプロダクト判断への承認を区別する。
- レビューでは `pnpm pdr context --diff BASE...HEAD` と依頼内容から検索し、参照した PDR と新しく生じた判断を確認する。レコード変更後は `pnpm pdr check` を実行する。
