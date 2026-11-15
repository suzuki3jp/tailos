---
schema: 1
id: PDR-20261116-project-name-validation
key: project.name.validation
status: accepted
date: "2026-11-16"
areas: [projects, api]
keywords: [Project名, name, 必須, 空白, trim, 100文字, 同名]
paths:
  - apps/api/src/application/triggers/projects.ts
  - apps/api/src/application/projects/**
  - apps/api/src/presentation/http/handlers/projects/**
  - apps/api/src/infrastructure/d1/projects.ts
symbols: [projectSettings, projectSchema]
supersedes: []
decided_by: suzuki3jp
---

# Project 名は前後の空白を除いて1〜100文字とし同名を許可する

## 決定

自由に入力する Project 名 `name` は必須とする。入力の前後の空白を除去し、除去後の名前を 1〜100 文字に制限する。空文字と空白のみの名前は受け付けない。

同名の Project を許可する。Project の識別は名前ではなく、既存の UUID で行う。

## 理由

ホームの選択欄で Project を識別できる表示が必要なので、名前を必須とし、実質的に表示のない入力を防ぐ。長さを制限することで表示用の名前が過度に長くなることを抑える。

名前は利用者が自由に付ける表示用の値であり、一意な識別子にはしない。UUID で Project を区別できるため、同じ名前を使うために不要な命名変更を求めない。

## 範囲と例外

名前の追加と既存 Project の repository 値による補完は [設定項目の判断](PDR-20261116-project-editable-fields.md) に従う。この記録は新しく入力される名前の検証規則を決めるものであり、API や migration の実装・適用はまだ行っていない。

現在の repository の検証には長さ制限がないため、[移行方針](PDR-20261116-project-owner-assignment.md) に従い、移行時の元の値がこの名前の長さ制限を超える場合も切り詰めず、そのまま保持する。
