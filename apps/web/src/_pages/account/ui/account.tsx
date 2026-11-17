"use client";

import { useQuery } from "@tanstack/react-query";
import { apiOrigin } from "@/shared/config";
import { RequestState } from "@/shared/ui/request-state";
import { accountQueryOptions } from "../api/queries";

export function Account() {
  const account = useQuery(accountQueryOptions());

  if (account.isPending)
    return (
      <p role="status" className="text-muted-foreground">
        ログイン状態を確認しています。
      </p>
    );
  const data = account.data;
  if (account.isError || (data && "error" in data)) {
    return (
      <RequestState
        status={data && "error" in data ? data.error : undefined}
        missing="GitHub ログインが設定されていません。"
        retry={() => void account.refetch()}
      />
    );
  }
  if (!data) {
    return (
      <form method="post" action={apiOrigin + "/v1/auth/login"}>
        <button className="action action-primary" type="submit">
          GitHub でログイン
        </button>
      </form>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-signal">GitHub でログイン済みです。</p>
      <div className="flex flex-wrap gap-3">
        <a href="/projects" className="action">
          Project 設定を管理
        </a>
        <a href="/mcp" className="action">
          MCP キーを管理
        </a>
        {data.connectEnabled && (
          <a href="/connect" className="action action-primary">
            Agent 接続を開く
          </a>
        )}
        <form method="post" action={apiOrigin + "/v1/auth/logout"}>
          <button className="action" type="submit">
            ログアウト
          </button>
        </form>
      </div>
    </div>
  );
}
