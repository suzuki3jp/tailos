import { api } from "@/shared/api";

export async function createMcpKey(name: string, lifetimeDays: number) {
  const response = await api["mcp-keys"].$post({
    json: { name, lifetimeDays },
  });
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? "キーは20件まで発行できます。不要なキーを失効してください。"
        : "キーを発行できませんでした。もう一度お試しください。",
    );
  return response.json();
}

export async function revokeMcpKey(id: string) {
  const response = await api["mcp-keys"][":id"].revoke.$post({ param: { id } });
  if (!response.ok)
    throw new Error("キーを失効できませんでした。もう一度お試しください。");
}
