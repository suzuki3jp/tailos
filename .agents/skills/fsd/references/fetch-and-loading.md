# データ取得と Loading の設計

Tailos Web の初期表示は Server Component とサーバー側の取得・prefetch を基本にする。Loading UI の有無は、情報の重要度と利用者が実際に待つ時間から決める。取得処理があることだけを理由に、画面全体の `"use client"` や Skeleton を追加しない。

## 実装前の判断

次を短く整理してから、取得場所と表示の境界を決める。

- そのデータがなければページで何ができるか。ページの前提となる情報か、先に表示できる内容とは独立した情報か。
- 初期リクエストで取得に必要な条件が揃うか。ブラウザ固有 API や操作後の値を必要とするか。
- 取得にどの程度かかる見込みか。取得の依存関係、ネットワーク往復、ページング、キャッシュを含めて考える。
- どこまでを先に使える状態にし、どの範囲を待たせるか。Loading を出す場合も出さない場合も、この理由を説明できるようにする。

時間の見積もりと実測は区別する。既存の計測や API の特性を使い、疑わしい場合は計測する。見積もりの数字を実測値として説明しない。

## fetch と Client 境界

- ページや画面の大きなコンテナは Server Component を基本にする。state やイベントが一部に必要という理由で画面全体へ `"use client"` を付けない。
- `"use client"` は対話操作、ブラウザ固有 API、サーバーでは条件が揃わない取得など、必要な箇所に局所化する。Client モジュールが import する依存も Client 側に入るため、単に directive を別ファイルに移すだけで済ませない。
- 共有する対話 state は必要な範囲の Client Provider に置ける。サーバーで組み立てた表示を `children` などで渡し、Client モジュールから画面全体を import しない。Server Component から Client Component を使うことと、画面全体を Client Component にすることを区別する。
- 初期値をサーバーで用意できる場合は、後で client-side fetch や再取得が必要でも、初期表示をクライアントの取得待ちにしない。TanStack Query を使う場合はサーバーの prefetch と `dehydrate` / `HydrationBoundary` で初期データを引き継ぐ。
- サーバーの QueryClient はリクエスト単位で扱う。query key と取得条件を hydration 前後で揃え、鮮度の要件に応じて `staleTime` などを検討する。hydrate 直後の同じ初期データの再取得を無検討に発生させない。値を全画面共通の固定時間にはしない。
- SSR の認証情報の引き継ぎを確認する。ブラウザの `credentials: "include"` だけではサーバーの fetch に利用者の Cookie は付かない。既存の認証契約に沿って必要な情報だけを API に渡し、認証情報を dehydrated state に含めない。
- 独立した取得は並列に開始する。片方を待ってからもう片方を開始する不要な waterfall を作らない。初期ページに不要な後続ページは初期表示の待ち時間に加えず、追加読み込みと分けて設計する。
- prefetch の失敗を無視して空の状態を hydrate し、同じ取得をクライアントでやり直すだけにしない。未認証・取得失敗・空一覧を区別し、既存のエラー処理へ接続する。空配列やダミーデータで Loading を隠さない。

query key・取得処理はその画面や再利用責務を所有する slice に置く。ブラウザ用 Provider は App の責務とし、server 専用の認証処理を client 用の公開入口へ混ぜない。配置の詳細は [FSD スキル](../SKILL.md) と [Tailos 固有の構成](tailos.md) に従う。

## Loading を表示するか

| データと待ち時間 | 基本の判断 |
| --- | --- |
| データなしではページを使えず、取得は短時間の見込み | サーバーで取得してから有用なページを返す。操作できない殻と Loading を先に出す価値は小さい。 |
| ページに必須だが、取得に時間がかかる | 待っていることが分かる Loading を適切な範囲で表示する。重要な情報だからという理由だけで長時間無反応にしない。 |
| そのデータがなくても先に使える領域がある | 有用な領域を先に表示する。遅い領域を分離し、必要なら局所的な Loading とストリーミングを使う。 |
| 極端に短い取得 | Loading の表示がちらつきになり得る。表示しない選択を先に検討する。 |

100ms 以下は「表示してもちらつきになりやすい短時間」の例であり、全画面に適用する閾値ではない。Loading を見せるために待ち時間を足したり、一律の表示遅延・最低表示時間を導入したりしない。

独立した並列 fetch の待ち時間は、おおむね最も遅い取得で決まる。直列 fetch は依存する取得の合計で考える。並列と直列が混ざる場合は最長の依存経路を見る。各リクエストが短くても、カーソルによる連続取得などで全体が長くなる場合にはフィードバックが必要になる。

## Loading の実装方法

Loading が必要と判断した場合、初期表示ではサーバーで扱える境界を優先する。

- `loading.tsx`: ルート区画の待ち状態に使う。ページ全体を待たせる必要がある場合に検討する。
- `Suspense`: 独立して待たせられる領域に使う。サーバー側の非同期描画やストリーミングに対応し、使える領域を残して遅い内容を後から返せる。
- boolean による出し分け: クライアント操作後の送信中・追加読み込みなど、クライアント内の局所的な状態に使う。初期ページの取得を `isPending ? <Skeleton /> : ...` にする形は既定にしない。採用する場合はサーバー取得や Suspense を使わない理由を確認する。

`Suspense` で囲むだけでは通常の `useQuery` や `useEffect` の fetch は suspend しない。非同期 Server Component や、用途に合う TanStack Query の Suspense 対応 API と組み合わせる。待つ処理を境界の外で先に `await` すると、その境界の fallback では待ち状態を表示できない。Tailos の実装先は Vinext なので、使用する API・ルート規約の対応状況も確認する。

## 今回のホームへの適用例

Project は選択と入力の前提になる情報として扱う。Projects と Sessions の初期取得が独立していればサーバーで並列 prefetch し、短時間で返る想定なら取得済みのホームを表示する。Project の選択連動と入力、追加読み込みなどを小さな Client 境界に残す。一覧取得のためだけに `HomePage` 全体を Client Component にしたり、初期状態の Skeleton を置いたりしない。

取得が実際には遅いと分かった場合は、その待ち時間と依存関係を根拠に `loading.tsx` や `Suspense` の境界を検討する。最初から Loading 不要と固定するのではなく、判断を更新する。

## レビューと検証

初期データが最初のサーバー描画に含まれるか、独立した取得が並列に始まるか、Client 境界が必要な責務に限定されているかを確認する。Loading の有無を機械的に指摘せず、情報の重要度と見込み時間に理由を結び付ける。

検証は速い取得と遅い取得、未認証・失敗・空一覧、hydration 後の不要な初回再取得、追加読み込みや操作の継続を対象にする。Skeleton の存在や directive の文字列だけを確かめるテストで設計の妥当性を保証しない。

## 一次資料

- [React: use client](https://react.dev/reference/rsc/use-client)
- [TanStack Query: Advanced Server Rendering](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr)
- [Next.js: loading.tsx とストリーミング](https://nextjs.org/docs/app/api-reference/file-conventions/loading)
