"use client";

import { useQuery } from "@tanstack/react-query";
import { api, apiOrigin } from "../api";
import { RequestState } from "../request-state";

export function Account() {
  const account = useQuery({
    queryKey: ["account"],
    queryFn: async ({ signal }) => {
      const response = await api.account.$get(undefined, {
        init: { signal },
      });
      if (response.status === 401) return null;
      return response.ok ? await response.json() : { error: response.status };
    },
  });

  if (account.isPending)
    return (
      <p role="status" className="text-muted">
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
      <form method="post" action={apiOrigin + "/api/auth/login"}>
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
        {data.connectEnabled && (
          <a href="/connect" className="action action-primary">
            ChatGPT 接続を開く
          </a>
        )}
        <form method="post" action={apiOrigin + "/api/auth/logout"}>
          <button className="action" type="submit">
            ログアウト
          </button>
        </form>
      </div>
    </div>
  );
}
