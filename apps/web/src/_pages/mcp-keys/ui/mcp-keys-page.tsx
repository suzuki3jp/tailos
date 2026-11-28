"use client";

import {
  Button,
  Select,
  TextArea,
  TextField,
} from "@/shared/ui/design-systems";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequestState } from "@/widgets/request-state";
import { mcpKeysQueryOptions, mcpKeysKey } from "../api/queries";
import { createMcpKey, revokeMcpKey } from "../api/mutations";

export function McpKeysPage() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [lifetimeDays, setLifetimeDays] = useState(30);
  const [issued, setIssued] = useState<{
    id: string;
    token: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState("");
  const keys = useQuery(mcpKeysQueryOptions());
  const create = useMutation({
    mutationFn: async () => {
      const data = await createMcpKey(name, lifetimeDays);
      // Keep the plaintext only in component state, never in query/mutation
      // caches, browser storage, or the list response.
      setIssued({ id: data.key.id, token: data.token, name: data.key.name });
      setName("");
      setCopied("");
    },
    onSuccess: () => client.invalidateQueries({ queryKey: mcpKeysKey }),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await revokeMcpKey(id);
      if (issued?.id === id) setIssued(null);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: mcpKeysKey }),
  });
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label + "をコピーしました。");
    } catch {
      setCopied("コピーできませんでした。文字列を選択してコピーしてください。");
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!create.isPending && !issued) create.mutate();
  }
  const data = keys.data;
  function renderKeys() {
    if (keys.isPending)
      return (
        <p role="status" className="text-muted-foreground">
          キーを読み込んでいます。
        </p>
      );
    if (keys.isError || !data || "error" in data)
      return (
        <RequestState
          status={data && "error" in data ? data.error : undefined}
          missing="MCP 接続を利用できません。"
          retry={() => void keys.refetch()}
        />
      );
    return (
      <>
        <div className="surface space-y-3">
          <h2 className="text-lg font-medium">接続先</h2>
          <p className="text-sm text-muted-foreground">
            Agent の MCP 設定に接続先 URL を登録し、Streamable HTTP
            を選択します。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="break-all font-mono text-sm">{data.endpoint}</code>
            <Button
              type="button"
              variant="outline"
              size="touch"
              onPress={() => void copy(data.endpoint, "URL")}
            >
              URL をコピー
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            認証は Bearer token / API key
            を選び、発行したキーを設定してください。ヘッダーを指定する場合は{" "}
            <code>Authorization: Bearer &lt;キー&gt;</code> を使います。
          </p>
        </div>
        {issued && (
          <div className="surface space-y-3 border-signal">
            <h2 className="text-lg font-medium">
              「{issued.name}」のキーを発行しました
            </h2>
            <p className="text-sm">
              このキーはこの画面を閉じると再表示できません。Agent
              の設定にコピーしてください。
            </p>
            <TextArea
              aria-label="発行した API key"
              isReadOnly
              spellCheck="false"
              rows={2}
              value={issued.token}
              textAreaClassName="resize-none font-mono"
            />
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="default"
                size="touch"
                onPress={() => void copy(issued.token, "キー")}
              >
                キーをコピー
              </Button>
              <Button
                type="button"
                variant="outline"
                size="touch"
                onPress={() => {
                  setIssued(null);
                  setCopied("");
                }}
              >
                保存しました
              </Button>
            </div>
          </div>
        )}
        <form className="surface space-y-4" onSubmit={submit}>
          <h2 className="text-lg font-medium">キーを発行</h2>
          <p className="text-sm text-muted-foreground">
            権限は Session・会話・実行記録の読み取り専用です。
          </p>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <TextField
              label="キー名"
              isRequired
              maxLength={80}
              value={name}
              onChange={setName}
              placeholder="例: 手元の AI Agent"
            />
            <Select
              label="有効期間"
              size="lg"
              options={[7, 30, 90].map((days) => ({
                id: String(days),
                label: `${days}日`,
              }))}
              value={String(lifetimeDays)}
              onValueChange={(id) => {
                if (id !== null) setLifetimeDays(Number(id));
              }}
            />
          </div>
          <Button
            type="submit"
            variant="default"
            size="touch"
            isDisabled={create.isPending || !name.trim() || Boolean(issued)}
          >
            {create.isPending ? "発行しています…" : "キーを発行"}
          </Button>
          {issued && (
            <p className="text-sm text-muted-foreground">
              発行したキーを保存してから、次のキーを発行できます。
            </p>
          )}
          {create.isError && (
            <p role="alert" className="text-danger">
              {create.error.message}
            </p>
          )}
        </form>
        <div className="space-y-3">
          <h2 className="text-lg font-medium">発行済みのキー</h2>
          {data.keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              キーはまだありません。
            </p>
          ) : (
            <ul className="divide-y divide-rule rounded-lg border border-rule bg-panel">
              {data.keys.map((key) => (
                <li
                  key={key.id}
                  className="flex flex-wrap items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="break-all font-medium">{key.name}</p>
                    <p className="text-sm text-muted-foreground">
                      <code>{key.prefix}…</code>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      発行 {new Date(key.createdAt).toLocaleDateString("ja-JP")}{" "}
                      ·{" "}
                      {key.expiresAt <= Date.now()
                        ? "期限切れ"
                        : "有効期限 " +
                          new Date(key.expiresAt).toLocaleDateString("ja-JP")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="touch"
                    isDisabled={revoke.isPending}
                    onPress={() => {
                      if (
                        window.confirm(
                          `「${key.name}」のキーを失効しますか？このキーでの接続はすぐに使えなくなります。`,
                        )
                      )
                        revoke.mutate(key.id);
                    }}
                  >
                    失効
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {revoke.isError && (
            <p role="alert" className="text-danger">
              {revoke.error.message}
            </p>
          )}
        </div>
        {copied && (
          <p role="status" className="text-sm text-signal">
            {copied}
          </p>
        )}
      </>
    );
  }
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-medium">MCP 接続</h1>
        <p className="text-muted-foreground">
          AI Agent から Session や実行記録を読み取るためのキーを管理します。
        </p>
      </div>
      {renderKeys()}
    </section>
  );
}
