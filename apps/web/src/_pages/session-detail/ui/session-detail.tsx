"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { agentEngineLabels } from "@tailos/core/models";
import { RequestState } from "@/widgets/request-state";
import { sessionQueryOptions } from "../api/queries";
import { runResult } from "../model/run-result";
import { runEngine } from "../model/agent-engine";
import { useSessionTimeline } from "../api/use-session-timeline";
import { ActivityItem } from "./activity-item";
import { MessageJobContext } from "./message-job-context";
import { MessageMarkdown } from "./message-markdown";

const authorLabel = { agent: "Agent", automation: "GitHub", user: "ユーザー" };
const runLabel = {
  queued: "待機中",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
};

/** Names an Agent's reply after the Model Provider of its Run. */
function agentLabel(run: { engine?: string | null } | undefined) {
  const engine = runEngine(run?.engine);
  return engine ? agentEngineLabels[engine] : authorLabel.agent;
}

export function SessionDetail({ id }: { id: string }) {
  const session = useQuery(sessionQueryOptions(id));
  const timeline = useSessionTimeline(undefined, id);
  const detail = session.data;
  function renderSession() {
    if (session.isPending)
      return (
        <p role="status" className="text-muted-foreground">
          Session を読み込んでいます。
        </p>
      );
    if (!detail || "error" in detail)
      return (
        <RequestState
          status={detail?.error}
          missing="Session が見つかりません。"
          retry={() => void session.refetch()}
        />
      );
    return (
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="surface">
          <h2 className="mb-4 text-lg font-medium">会話</h2>
          {detail.messages.length === 0 && (
            <p className="text-muted-foreground">会話はまだありません。</p>
          )}
          <ol className="divide-y divide-rule">
            {detail.messages.map((message) => (
              <li key={message.id} className="space-y-2 py-4">
                <p className="text-sm font-medium text-signal">
                  {message.authorKind === "agent"
                    ? agentLabel(
                        detail.runs.find((run) => run.id === message.runId),
                      )
                    : authorLabel[message.authorKind]}
                </p>
                <MessageMarkdown body={message.body} withinSection />
                <MessageJobContext context={message.jobContext} />
              </li>
            ))}
          </ol>
        </section>
        <section className="surface">
          <h2 className="mb-4 text-lg font-medium">Run</h2>
          {detail.runs.length === 0 && (
            <p className="text-muted-foreground">実行履歴はまだありません。</p>
          )}
          <ol className="divide-y divide-rule">
            {detail.runs.map((run) => {
              const { urls, plan } = runResult(run.result);
              return (
                <li key={run.id} className="space-y-2 py-4">
                  <p
                    className={
                      run.status === "failed" ? "text-danger" : "text-signal"
                    }
                  >
                    {runLabel[run.status]}
                  </p>
                  {plan && <p>{plan}</p>}
                  <div className="space-y-3">
                    {timeline.data?.items
                      .filter((item) => item.runId === run.id)
                      .map((item) => (
                        <ActivityItem
                          key={item.id}
                          item={item}
                          sessionId={id}
                          runActive={
                            run.status === "queued" || run.status === "running"
                          }
                        />
                      ))}
                  </div>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {run.id}
                  </p>
                  <Link
                    href={`/diagnostics?runId=${encodeURIComponent(run.id)}`}
                    className="action"
                  >
                    実行記録を調べる
                  </Link>
                  {run.errorCode && (
                    <p className="wrap-anywhere font-mono text-sm text-danger">
                      {run.errorCode}
                    </p>
                  )}
                  {urls?.map((url) => (
                    <Link key={url} href={url} className="action">
                      {urls.length > 1
                        ? `Pull Request #${url.split("/").pop()} を開く`
                        : "Pull Request を開く"}
                    </Link>
                  ))}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    );
  }
  return (
    <section className="space-y-7">
      <header className="space-y-2">
        <h1 className="text-3xl font-medium">Session</h1>
        <p className="break-all font-mono text-sm text-muted-foreground">
          {id}
        </p>
      </header>
      {renderSession()}
    </section>
  );
}
