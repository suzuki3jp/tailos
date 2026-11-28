"use client";

import { Button, TextField } from "@/shared/ui/design-systems";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequestState } from "@/widgets/request-state";
import {
  claudeConnectionKey,
  claudeConnectionQueryOptions,
} from "../api/queries";
import { disconnectClaude, saveClaudeToken } from "../api/update-connection";

const date = new Intl.DateTimeFormat("ja-JP", { dateStyle: "long" });

export function ClaudeConnection() {
  const client = useQueryClient();
  // The pasted token stays in this field until it is saved, never in a query
  // or mutation cache or browser storage.
  const [token, setToken] = useState("");
  const connection = useQuery(claudeConnectionQueryOptions());
  const refresh = () =>
    client.invalidateQueries({ queryKey: claudeConnectionKey });
  const save = useMutation({
    mutationFn: async () => {
      await saveClaudeToken(token.trim());
      setToken("");
    },
    onSettled: refresh,
  });
  const disconnect = useMutation({
    mutationFn: disconnectClaude,
    onSuccess: refresh,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!save.isPending && token.trim()) save.mutate();
  }
  const status = connection.data;
  function renderConnection() {
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
          missing="Claude 接続は現在利用できません。"
          retry={() => void connection.refetch()}
        />
      );
    if (status.state === "connected")
      return (
        <>
          <p>Claude のトークンを保存済みです。</p>
          <p className="text-sm text-muted-foreground">
            {date.format(status.savedAt)} に保存しました。有効期限の目安は{" "}
            {date.format(status.expiresAt)} です。
          </p>
          {status.expiry !== "valid" && (
            <p role="status" className="text-sm text-danger">
              {status.expiry === "soon"
                ? "まもなくトークンの有効期限が切れます。"
                : "トークンの有効期限が切れている可能性があります。"}
              接続を解除し、<code>claude setup-token</code>{" "}
              で発行し直したトークンを保存してください。
            </p>
          )}
          <Button
            variant="outline"
            size="touch"
            type="button"
            isDisabled={disconnect.isPending}
            onPress={() => {
              if (window.confirm("Claude 接続を解除しますか？"))
                disconnect.mutate();
            }}
          >
            接続を解除
          </Button>
          {disconnect.isError && (
            <p role="alert" className="text-danger">
              {disconnect.error.message}
            </p>
          )}
        </>
      );
    return (
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-muted-foreground">
          手元で <code>claude setup-token</code>{" "}
          を実行し、表示された長期トークンを貼り付けてください。保存したトークンは再表示できません。
        </p>
        <TextField
          label="トークン"
          isRequired
          type="password"
          autoComplete="off"
          spellCheck="false"
          value={token}
          onChange={setToken}
          placeholder="sk-ant-oat01-…"
          inputClassName="font-mono"
        />
        <Button
          type="submit"
          variant="default"
          size="touch"
          isDisabled={save.isPending || !token.trim()}
        >
          {save.isPending ? "保存しています…" : "トークンを保存"}
        </Button>
        {save.isError && (
          <p role="alert" className="text-danger">
            {save.error.message}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className="surface space-y-4">
      <h2 className="text-lg font-medium">Claude</h2>
      {renderConnection()}
    </div>
  );
}
