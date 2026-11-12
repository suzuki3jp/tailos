"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/app/api";
import { RequestState } from "@/app/request-state";

const authorLabel = { agent: "Codex", automation: "GitHub", user: "ユーザー" };
const runLabel = {
  queued: "待機中",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
};

function pullRequestUrl(result: string | null) {
  if (!result) return null;
  try {
    const data: unknown = JSON.parse(result);
    if (
      !data ||
      typeof data !== "object" ||
      !("kind" in data) ||
      data.kind !== "pull_request" ||
      !("url" in data) ||
      typeof data.url !== "string"
    )
      return null;
    const url = new URL(data.url);
    return url.origin === "https://github.com" &&
      /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function SessionDetail({ id }: { id: string }) {
  const session = useQuery({
    queryKey: ["sessions", id],
    queryFn: async ({ signal }) => {
      const response = await api.sessions[":id"].$get(
        { param: { id } },
        { init: { signal } },
      );
      return response.ok ? await response.json() : { error: response.status };
    },
    refetchInterval: (query) => {
      const detail = query.state.data;
      return detail &&
        "runs" in detail &&
        detail.runs.some(
          (run) => run.status === "queued" || run.status === "running",
        )
        ? 5000
        : false;
    },
  });
  const detail = session.data;
  return (
    <section className="space-y-7">
      <header className="space-y-2">
        <h1 className="text-3xl font-medium">Session</h1>
        <p className="break-all font-mono text-sm text-muted">{id}</p>
      </header>
      {session.isPending ? (
        <p role="status" className="text-muted">
          Session を読み込んでいます。
        </p>
      ) : !detail || "error" in detail ? (
        <RequestState
          status={detail?.error}
          missing="Session が見つかりません。"
          retry={() => void session.refetch()}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="surface">
            <h2 className="mb-4 text-lg font-medium">会話</h2>
            {detail.messages.length === 0 && (
              <p className="text-muted">会話はまだありません。</p>
            )}
            <ol className="divide-y divide-rule">
              {detail.messages.map((message) => (
                <li key={message.id} className="space-y-2 py-4">
                  <p className="text-sm font-medium text-signal">
                    {authorLabel[message.authorKind]}
                  </p>
                  <p className="whitespace-pre-wrap wrap-anywhere">
                    {message.body}
                  </p>
                </li>
              ))}
            </ol>
          </section>
          <section className="surface">
            <h2 className="mb-4 text-lg font-medium">Run</h2>
            {detail.runs.length === 0 && (
              <p className="text-muted">実行履歴はまだありません。</p>
            )}
            <ol className="divide-y divide-rule">
              {detail.runs.map((run) => {
                const url = pullRequestUrl(run.result);
                return (
                  <li key={run.id} className="space-y-2 py-4">
                    <p
                      className={
                        run.status === "failed" ? "text-danger" : "text-signal"
                      }
                    >
                      {runLabel[run.status]}
                    </p>
                    <p className="break-all font-mono text-xs text-muted">
                      {run.id}
                    </p>
                    <a
                      href={`/diagnostics?runId=${encodeURIComponent(run.id)}`}
                      className="action"
                    >
                      実行記録を調べる
                    </a>
                    {run.errorCode && (
                      <p className="wrap-anywhere font-mono text-sm text-danger">
                        {run.errorCode}
                      </p>
                    )}
                    {url && (
                      <a href={url} className="action">
                        Pull Request を開く
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      )}
    </section>
  );
}
