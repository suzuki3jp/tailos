import { queryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";
import { RoutineRequestError, type Routine } from "@/entities/routine";
export {
  routinesQueryOptions,
  routinesKey,
  RoutineRequestError,
  type Routine,
} from "@/entities/routine";
const routes = api.projects[":projectId"].routines;
export type RoutineSettings = Omit<
  Routine,
  "id" | "projectId" | "revision" | "deletedAt"
>;
export const routineHistoryKey = (projectId: string) => [
  "routine-history",
  projectId,
];
export function routineHistoryQueryOptions(projectId: string, before?: number) {
  return queryOptions({
    queryKey: [...routineHistoryKey(projectId), before],
    queryFn: async ({ signal }) => {
      const response = await routes.history.$get(
        {
          param: { projectId },
          query: before === undefined ? {} : { before: String(before) },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new RoutineRequestError(response.status);
      return response.json();
    },
  });
}
async function check(response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}) {
  if (response.ok) return;
  const body = await response.json().catch(() => null);
  const error =
    body && typeof body === "object" && "error" in body
      ? body.error
      : undefined;
  if (error === "configuration_unverified")
    throw new Error(
      "Model Provider の接続、または既定モデルで effort を使えるかを確認できません。有効にするには接続を確認するか、モデルを指定してください。無効状態なら保存できます。",
    );
  if (error === "unsupported_model" || error === "unsupported_effort")
    throw new Error(
      "選択したモデルまたは effort は利用できません。対応する設定を確認してください。",
    );
  const messages: Partial<Record<number, string>> = {
    409: "設定が変更されています。一覧を更新してから保存してください。",
    401: "ログインし直してください。",
  };
  throw new Error(
    messages[response.status] ??
      "Routine を保存できませんでした。入力や接続を確認してください。",
  );
}
export async function saveRoutine(
  projectId: string,
  settings: RoutineSettings,
  current?: Routine,
) {
  const response = current
    ? await routes[":id"].$post({
        param: { projectId, id: current.id },
        json: { ...settings, revision: current.revision },
      })
    : await routes.$post({ param: { projectId }, json: settings });
  await check(response);
}
export async function deleteRoutine(projectId: string, current: Routine) {
  await check(
    await routes[":id"].delete.$post({
      param: { projectId, id: current.id },
      json: { revision: current.revision },
    }),
  );
}
