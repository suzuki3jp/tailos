import { api } from "@/shared/api";
import type { ProjectSettings } from "./queries";

async function check(response: { ok: boolean; status: number }) {
  if (!response.ok) {
    const messages: Partial<Record<number, string>> = {
      409: "設定が変更されたか、リポジトリの重複・件数上限・移行済みのため保存できません。一覧を更新して確認してください。",
      400: "入力内容を確認してください。",
      401: "ログインし直してください。",
    };
    throw new Error(
      messages[response.status] ??
        "処理できませんでした。GitHub App の接続を確認して、もう一度お試しください。",
    );
  }
}
export async function saveProject(
  settings: ProjectSettings,
  id?: string,
  revision?: number,
) {
  const response = id
    ? await api.projects[":id"].$post({
        param: { id },
        json: { ...settings, revision: revision ?? 0 },
      })
    : await api.projects.$post({ json: settings });
  await check(response);
}
export async function deleteProject(id: string, revision: number) {
  await check(
    await api.projects[":id"].delete.$post({
      param: { id },
      json: { revision },
    }),
  );
}
export async function importProjects(json: string) {
  let projects;
  try {
    projects = JSON.parse(json);
  } catch {
    throw new Error("JSON の形式を確認してください。");
  }
  await check(await api.projects.import.$post({ json: projects }));
}
