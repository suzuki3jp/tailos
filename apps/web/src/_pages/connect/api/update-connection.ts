import { api } from "@/shared/api";

export async function updateConnection(action: "start" | "disconnect") {
  const response = await api.connect[action].$post();
  if (!response.ok) throw new Error("接続状態を変更できませんでした。");
}
