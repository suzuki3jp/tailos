---
schema: 1
id: PDR-20261128-design-system-text-field
key: web.design-system.text-field
status: accepted
date: "2026-11-28"
areas: [web, design-system]
keywords: [TextField, TextArea, Input, Textarea, 入力欄, テキスト入力, フォーカス, 枠線, FieldError]
paths:
  - apps/web/src/shared/ui/design-systems/text-field.tsx
  - apps/web/src/shared/styles/tokens.css
symbols: [TextField, TextArea, --input-focus]
supersedes: []
decided_by: suzuki3jp
---

# 1 行と複数行の入力欄を Figma の TextField と TextArea に揃える

## 決定

Design Systems の 1 行入力を `TextField`、複数行入力を `TextArea` とし、Figma の Design Systems にある TextField / TextArea の見た目に揃える。ラベル、入力欄、検証メッセージを一つの部品にまとめ、旧 `Input` / `Textarea` は廃止する。

- 共通: 背景 `#fffcf5`、1px の枠線 `#ded4c3`、角丸 6px、入力値は `#271e18`、プレースホルダーは `#63584a`。
- フォーカス中は枠線を `#bdb4a6`（トークン `--input-focus`）にし、リングは表示しない。
- 不正な値の間は枠線を `#a42b2b` にし、フォーカス中も赤を優先する。
- TextField: 高さ 32px、左右 12px・上下 6px の余白、16px の文字。
- TextArea: 最小の高さ 64px、上 4px・左右と下 6px の余白、14px の文字と 20px の行の高さ。内容に合わせて高さが伸びる。
- 検証で不正になった場合は、入力欄の下にブラウザの検証メッセージを 14px の赤い文字で表示する。

## 理由

入力欄ごとに高さ・余白・状態の表示が画面ごとにずれていたため、デザインで定義した一つの見た目に揃える。React Aria の TextField はブラウザ標準の検証の吹き出しを止めるため、必須や上限などの検証メッセージが利用者に見えなくなる。従来どおりメッセージを見せ続けるために、入力欄の下に表示する。

## 範囲と例外

設定、接続、MCP キー、Diagnostics などの管理画面の入力欄に適用する。ホームと Session の入力（Prompt Input）は別のデザインで、`InputGroup` の現在の見た目を保つ。Disabled の見た目は Figma に定義がないため、半透明にしてカーソルを禁止表示にする。入力制約・送信・保存の意味は各機能の判断に従う。

## 選択肢と影響

フォーカス時にリングを出す案もあるが、デザインは枠線の色の変化だけで表す。キーボード操作では現在地が分かりにくくなる可能性があり、問題があれば見直す。同じフォームにある `Select`（36px）とは高さが揃わない。
