import { api } from "@/shared/api";

export async function updateConnection(action: "start" | "disconnect") {
  const response = await api.connect[action].$post();
  if (!response.ok) throw new Error("接続状態を変更できませんでした。");
}

export async function saveClaudeToken(token: string) {
  const response = await api.connect.claude.$post({ json: { token } });
  if (!response.ok) {
    const messages: Partial<Record<number, string>> = {
      400: "トークンの形式が正しくありません。claude setup-token が表示した値をそのまま貼り付けてください。",
      409: "すでに接続済みです。画面を更新してください。",
    };
    throw new Error(
      messages[response.status] ??
        "トークンを保存できませんでした。もう一度お試しください。",
    );
  }
}

export async function disconnectClaude() {
  const response = await api.connect.claude.disconnect.$post();
  if (!response.ok) throw new Error("接続状態を変更できませんでした。");
}
