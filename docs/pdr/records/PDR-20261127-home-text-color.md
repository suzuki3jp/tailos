---
schema: 1
id: PDR-20261127-home-text-color
key: web.home.text-color
status: accepted
date: "2026-11-27"
decided_by: suzuki3jp
areas: [web, design-system]
keywords: [ホーム, 文字色, 見出し, セッション名, Recent Sessions, foreground]
paths:
  - apps/web/src/_pages/home/ui/home-page.tsx
  - apps/web/src/_pages/home/ui/recent-sessions.tsx
  - apps/web/src/_pages/home/ui/session-row.tsx
---

# ホームの見出しとセッション名に基本文字色を使う

## 決定

ホームの挨拶見出し、本文の Recent Sessions 見出し、一覧のセッション名には、デザインシステムの基本文字色 `#271E18` を使う。

## 理由

Figma のホームで使う基本文字色に揃え、サイドバーのラベルなどと同じ色で表示する。

## 範囲と例外

対象はホーム本文の見出しとセッション名。更新日時などの補助情報には補助文字色を、一覧のセッションアイコンにはアイコンの既存色を使う。
