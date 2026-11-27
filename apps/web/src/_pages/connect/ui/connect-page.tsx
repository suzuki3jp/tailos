"use client";

import { Button } from "@/shared/ui/design-systems";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequestState } from "@/widgets/request-state";
import { connectionQueryOptions, connectionKey } from "../api/queries";
import { updateConnection } from "../api/update-connection";
import { ClaudeConnection } from "./claude-connection";

const messages = {
  disconnected: "ChatGPT アカウントを接続できます。",
  connected: "ChatGPT に接続済みです。",
  expired: "コードの有効期限が切れました。もう一度接続してください。",
  failed: "接続できませんでした。もう一度お試しください。",
};

export function ConnectPage() {
  const client = useQueryClient();
  const connection = useQuery(connectionQueryOptions());
  const update = useMutation({
    mutationFn: updateConnection,
    onSuccess: () => client.invalidateQueries({ queryKey: connectionKey }),
  });
  const status = connection.data;
  function renderChatGptConnection() {
    if (connection.isPending)
      return (
        <p role="status" className="text-muted-foreground">
          接続状態を確認しています。
        </p>
      );
    if (!status || "error" in status)
      return (
        <RequestState
          status={status?.error}
          missing="ChatGPT 接続は現在利用できません。"
          retry={() => void connection.refetch()}
        />
      );
    if (status.state === "pending")
      return (
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
          <p role="status" className="text-sm text-muted-foreground">
            接続が完了すると自動で更新します。
          </p>
        </>
      );
    return (
      <>
        <p>{messages[status.state]}</p>
        <Button
          variant={status.state === "connected" ? "outline" : "default"}
          size="touch"
          type="button"
          isDisabled={update.isPending}
          onPress={() => {
            if (status.state !== "connected") update.mutate("start");
            else if (window.confirm("ChatGPT 接続を解除しますか？"))
              update.mutate("disconnect");
          }}
        >
          {status.state === "connected" ? "接続を解除" : "ChatGPT に接続"}
        </Button>
        {update.isError && (
          <p role="alert" className="text-danger">
            {update.error.message}
          </p>
        )}
      </>
    );
  }
  return (
    <section className="max-w-xl space-y-5">
      <h1 className="text-3xl font-medium">Agent 接続</h1>
      <div className="surface space-y-4">
        <h2 className="text-lg font-medium">ChatGPT</h2>
        {renderChatGptConnection()}
      </div>
      <ClaudeConnection />
    </section>
  );
}
