# ネストした三項演算子の置き換え

`tailos-style/no-nested-ternary` は、条件・真の分岐・偽の分岐に直接別の三項演算子がある式を禁止する。単独の三項演算子は使用できる。

修正では、判定の優先順位、選択した分岐だけを評価する挙動、型の絞り込みを保つ。ルールを回避するためだけに三項演算子を複数の一時変数へ分散させない。次の方法から、処理の意味に合うものを選ぶ。

## 名前付き関数と早期リターン

範囲判定や優先順位のある条件、選んだ分岐だけで実行する処理には、値を選ぶ関数を使う。名前で判定の目的を伝え、各分岐から直接返す。

```ts
function expiryLabel(now: number, expiresAt: number) {
  if (now >= expiresAt) return "期限切れ";
  if (now >= expiresAt - noticePeriod) return "まもなく期限切れ";
  return "有効";
}

const label = expiryLabel(now, expiresAt);
```

JSX の読み込み中・エラー・成功の分岐にも、早期リターンを使える。画面固有の判定は同じ画面内に置き、共有が必要になるまで汎用化しない。

## 有限のキーと静的な値のマッピング

状態や種別から固定値を引く場合は、対応表を名前付きの `const` として定義する。キーの型には既存のドメイン型を使い、`satisfies Record<ExpectedKeys, Value>` で定義漏れ・キーの誤りを検出する。

```ts
type State = "queued" | "running" | "succeeded" | "failed";

const stateLabels = {
  queued: "待機中",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
} satisfies Record<State, string>;

const label = stateLabels[state];
```

値が条件ごとの関数呼び出しなら、オブジェクトを作ると全分岐が評価されてしまう。副作用や不要な計算を伴う場合は早期リターンか `switch` を選ぶ。全状態を扱うべき対応表に `Partial` や広い `string` キーを使い、定義漏れをフォールバックで隠さない。外部の任意の HTTP ステータスなど、既知の一部だけを扱う表には明示したフォールバックを使える。

## ケースごとの処理と switch

同じ値を複数のケースと比較する場合や、複数のケースで処理を共有する場合は `switch` を使う。代入用の変数を用意せず各ケースから返す。未知の入力を受け取る場合は、従来のフォールバックも明示する。

```ts
function diagnosticOperation(itemType: string) {
  switch (itemType) {
    case "commandExecution":
      return "command";
    case "mcpToolCall":
    case "webSearch":
      return "tool";
    default:
      return undefined;
  }
}
```

判別可能な union のメンバー固有の値を使う場合も、ケース内で型を絞り込める `switch` や早期リターンを優先する。

## let と if/else は最後の選択肢

上記の方法が使えない、または関数への抽出などが処理に対して過剰になる場合に限り、`let` と `if/else` で値を代入する。変数のスコープを狭くし、全分岐で値が決まるようにする。型を通すためのアサーションや、後で必ず上書きするダミーの初期値は避ける。

```ts
let label: string;
if (isExpired) {
  label = "期限切れ";
} else if (isExpiringSoon) {
  label = "まもなく期限切れ";
} else {
  label = "有効";
}
```

この例のように意味のある値選択の関数にできる場合は、最初の早期リターンの形を優先する。
