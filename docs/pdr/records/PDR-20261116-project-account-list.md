---
schema: 1
id: PDR-20261116-project-account-list
key: projects.account-list
status: accepted
date: "2026-11-16"
areas: [projects, api]
keywords: [Project一覧, アカウント, 所有者, ホーム, Project選択, ページング, 実装計画]
paths:
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/src/application/projects/**
  - apps/api/src/infrastructure/d1/projects.ts
  - apps/api/src/infrastructure/d1/schema.ts
  - apps/api/src/bootstrap/http.ts
symbols: [createProjectRoutes, ProjectStore, d1Projects]
supersedes: []
decided_by: suzuki3jp
---

# アカウントの Project 一覧を名前順にページングして取得する

## 決定

アカウントが所有する Project の一覧 API を次の契約にする。所有の方針は [採択済みの所有判断](PDR-20261116-project-account-ownership.md) に従う。

- パスは既存の `GET /api/projects` を使う。
- 取得対象はログイン中のユーザーが所有する、削除されていない Project とする。
- 一覧の各要素は `id`、`name`、`repository` を返す。
- 並び順は名前の昇順とし、同名の場合は ID の昇順で順序を固定する。
- カーソル方式でページングし、取得件数は既定 50 件、最大 100 件とする。
- レスポンスは `{ items, nextCursor }` とする。

今回は所有する Project に限定し、将来はメンバーとして参加している Project も返す構想とする。

所有者には Tailos 内部のユーザー ID を使い、取得するユーザーを認証結果から決める。保存と移行、今回の実装範囲は [所有者の割り当て方針](PDR-20261116-project-owner-assignment.md) に従う。メンバー参加は後続の実装とする。

最初の利用先はアカウントホームとすることが合意済みである。[対象ホームのデザイン](https://www.figma.com/design/8xCaWOhzVybu2PXiJ3Hrij/tailos?node-id=21-10905) には、左上の Project 切り替えと、新しい会話の入力欄内の Project 選択がある。デザインでは `suzuki3jp/tailos` と表示されているが、表示するのは自由に付けた Project 名であり、リポジトリ名への固定を意味しない。ドロップダウンを開いた状態や選択後の挙動は、この画面だけでは確定できない。

このホームでの選択には Project ID と自由な名前 `name` を使う。名前の追加と既存データの補完は [採択済みの設定項目の判断](PDR-20261116-project-editable-fields.md) に従う。同名の場合も対象リポジトリで見分けられるように `repository` も返す。別の利用場所でも使える共通の一覧 API とする。既定の選択や二つの選択欄の連動は未決とする。

名前の入力は [採択済みの入力規則](PDR-20261116-project-name-validation.md) に従い、必須・前後の空白を除去後に 1〜100 文字・同名を許可とする。

## 理由

既存の一覧は認証されているが、所有者に限定せずデプロイ全体の Project 設定を返している。アカウント単位の開発対象一覧には、所有情報の保存と認証結果に基づく絞り込みが必要になる。

利用可能な Project の一覧として API の意味を定めれば、将来のメンバー参加に合わせて取得対象を広げやすい。内部ユーザー ID を使う案は、GitHub の表示名と所有情報を分離できる。

ホームの Project 選択には、選択対象を一意に指定する ID と、人が識別するラベルが必要になる。現在の画面からは説明、アイコン、活動時刻、起動設定の表示要求は読み取れないため、これらを一覧に含めることは確定しない。

名前順は選択したい Project を表示名から探す用途に合い、同名でも ID によって順序を固定できる。名前の重複を許可しているため、リポジトリ情報も返して選択時の区別を補助する。

ページングは Project 数が増えても一度の取得量を制限できる。通常は既定の 50 件で選択候補を取得し、必要に応じて最大 100 件までまとめて取得できる契約とする。削除済み Project は新しく選択する開発対象から除く。

## 範囲と例外

この計画は API とデータモデルの検討である。Web 画面への接続、whitelist の導入、メンバー招待の実装には別途範囲の合意が必要である。

現在の実装は全体で有効 Project が最大 100 件で、一覧は作成日時・ID の昇順に全件を返す。保存する Project の 100 件の上限は設定項目の採択済み判断にも含まれ、この一覧 API の記録では変更を採択しない。保存数の上限と、一度の取得件数の上限は別のものとして扱う。

この契約は実装済みを示さない。既存のレスポンスは `{ projects: [{ project, revision, updatedAt }] }` であり、設定値を含む。現在の設定画面はこの形式を使っているため、新しい概要一覧への変更に合わせて、設定画面は認証済み所有者に限定した `GET /api/projects/settings` で設定値と revision を取得する。保存数の上限 100 件を維持する今回は、設定取得の全件形式を引き継ぐ。

カーソルは名前と ID の組を保持する、バージョン付き JSON の Base64URL 表現にする。名前の比較は SQLite の BINARY 順とし、言語別の自然順への変換は行わない。`limit` は 1〜100 の整数を受け付け、不正な件数やカーソルは既存の入力エラーと同じ 400 にする。未認証は既存の認証と同じ 401、取得失敗は既存の Project エラーと同じ 503 とする。空一覧は `items: []`、続きがない場合は `nextCursor: null` を返す。

ページ間のスナップショットは固定しない。取得途中の追加・削除・名前変更は後続ページに反映されるため、並び位置が変わった行は読み飛ばしや再出現があり得る。最新の一覧は先頭から取得し直す。カーソルの内容は認可情報として使わず、どのページも認証結果の所有者で絞り込む。

## 選択肢と影響

実装計画案は次のとおりとする。

1. 既存 Project の所有者割り当てと、所有情報の保存方法を決める。カーソルの具体的な形式と入力検証、エラー時の契約、既存設定画面の取得経路を詰める。名前の入力規則は採択済みのものを使い、移行元の repository 値が長さ制限を超える場合の扱いを確認する。
2. 所有情報の保存・移行、名前カラムの追加と repository 値による補完、Project 作成時の所有者割り当てと名前保存、所有者に限定した一覧取得を実装する。編集・削除・変更履歴・インポートの権限確認と名前への対応も調査し、複数ユーザーの許可前に揃える。
3. [採択済みの Webhook 配信方針](PDR-20261116-project-webhook-fanout.md) の未決事項を解決してから、リポジトリの一意制約と設定検証を変更し、受付・重複防止・同時実行制御を Project 単位へ揃える。配信側の対応前にリポジトリの重複だけを有効にしない。
4. 所有者間の一覧・変更の分離、名前順のページングと同名の境界、既存データの移行、複数 Project の独立起動、再送での重複防止、一部失敗後の回復を検証する。

今回の実装は計画の 1・2 とその検証を対象にする。Webhook の複数配信と重複制約の緩和は、所有者の割り当て方針に従い後続の実装にする。

実装後の検証は CI と同じ `pnpm run format:check`、`pnpm run lint`、`pnpm run test`、`pnpm run typecheck`、`pnpm --filter @tailos/web run build` を使う。PDR の変更後は `pnpm pdr catalog --write` と `pnpm pdr check` を実行する。

## 未決事項

- ホームの二つの Project 選択の連動と、初期選択の扱い。選択状態を一覧 API が返す必要があるか。
- Project の作成上限を維持・変更・撤廃するか。
