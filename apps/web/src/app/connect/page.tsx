"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/app/api";
import { RequestState } from "@/app/request-state";

const queryKey = ["connection"];

const messages = {
  disconnected: "ChatGPT アカウントを接続できます。",
  connected: "ChatGPT に接続済みです。",
  expired: "コードの有効期限が切れました。もう一度接続してください。",
  failed: "接続できませんでした。もう一度お試しください。",
};

export default function ConnectPage() {
  const client = useQueryClient();
  const connection = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await api.connect.$get(undefined, {
        init: { signal },
      });
      return response.ok ? await response.json() : { error: response.status };
    },
    refetchInterval: (query) => {
      const status = query.state.data;
      return status && "state" in status && status.state === "pending"
        ? 5000
        : false;
    },
  });
  const update = useMutation({
    mutationFn: async (action: "start" | "disconnect") => {
      const response = await api.connect[action].$post();
      if (!response.ok) throw new Error("接続状態を変更できませんでした。");
    },
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const status = connection.data;
  return (
    <section className="max-w-xl space-y-5">
      <h1 className="text-3xl font-medium">ChatGPT 接続</h1>
      <div className="surface space-y-4">
        {connection.isPending ? (
          <p role="status" className="text-muted">
            接続状態を確認しています。
          </p>
        ) : !status || "error" in status ? (
          <RequestState
            status={status?.error}
            missing="ChatGPT 接続は現在利用できません。"
            retry={() => void connection.refetch()}
          />
        ) : status.state === "pending" ? (
          <>
            <p>ChatGPT で次のコードを入力してください。</p>
            <p>
              <code className="font-mono text-2xl text-signal">
                {status.userCode}
              </code>
            </p>
            <a
              className="action action-primary"
              href={status.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              ChatGPT を開く
            </a>
            <p role="status" className="text-sm text-muted">
              接続が完了すると自動で更新します。
            </p>
          </>
        ) : (
          <>
            <p>{messages[status.state]}</p>
            <button
              className={
                status.state === "connected"
                  ? "action"
                  : "action action-primary"
              }
              type="button"
              disabled={update.isPending}
              onClick={() => {
                if (status.state !== "connected") update.mutate("start");
                else if (window.confirm("ChatGPT 接続を解除しますか？"))
                  update.mutate("disconnect");
              }}
            >
              {status.state === "connected" ? "接続を解除" : "ChatGPT に接続"}
            </button>
            {update.isError && (
              <p role="alert" className="text-danger">
                {update.error.message}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
