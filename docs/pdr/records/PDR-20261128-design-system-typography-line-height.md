---
schema: 1
id: PDR-20261128-design-system-typography-line-height
key: web.design-system.typography-line-height
status: accepted
date: "2026-11-28"
areas: [web, design-system]
keywords: [タイポグラフィ, 行間, 行の高さ, line-height, Heading 2, Paragraph regular, Paragraph small, text-body, text-caption, text-page-title]
paths:
  - apps/web/src/shared/styles/tokens.css
  - apps/web/src/widgets/page-shell/ui/sidebar-account.tsx
symbols: [--text-page-title--line-height, --text-body--line-height, --text-caption--line-height]
supersedes: []
decided_by: suzuki3jp
---

# 見出しと本文の行の高さを Figma の Typography に揃える

## 決定

Figma の Typography に合わせ、次の行の高さを変える。

- Heading 2（26px、`text-page-title`）: 32px。
- Paragraph regular（16px、`text-body`）: 20px。
- Paragraph small（14px、`text-caption`）: 20px。

Paragraph small medium（14px・Medium）は 14px の行の高さのままとし、サイドバーのアカウント名に個別に指定する。Heading 1 と Heading 3 は変更しない。

## 理由

これらのトークンは文字の大きさと同じ行の高さで、本文が折り返すと行が詰まって読みにくかった。Figma の Typography はこの画面群の見た目の基準であり、そこで調整した行の高さをトークンに反映して、トークンを使う全画面で同じ値にする。

## 範囲と例外

`text-page-title`、`text-body`、`text-caption` を使うホーム、Session の行、サイドバーなどの全画面に適用する。[ホームと Session の現行デザインを保つ判断](PDR-20261128-web-design-compatibility.md)は共通部品への移行で見た目を変えないためのもので、基準となる Figma の変更は反映する。Heading 4（18px）と Paragraph extra small（12px）に対応するトークンはないため、この判断では扱わない。

## 選択肢と影響

TextArea など個別の部品だけ行の高さを変える案は、同じスタイル名でも画面ごとに見た目がずれるため採らない。トークンを使う要素は 1 行でも高さが増え、ホームとサイドバーの縦の間隔が少し広がる。
