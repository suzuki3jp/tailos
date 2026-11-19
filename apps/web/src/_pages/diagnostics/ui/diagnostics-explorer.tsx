"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { RequestState } from "@/widgets/request-state";
import {
  diagnosticBodyQueryOptions,
  diagnosticEventsQueryOptions,
  diagnosticTracesQueryOptions,
} from "../api/queries";

function DiagnosticBody({
  artifactId,
  eventId,
}: {
  artifactId: string;
  eventId: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery(diagnosticBodyQueryOptions(artifactId, open));
  const body =
    query.data && "batch" in query.data
      ? query.data.batch?.records.find((record) => record.eventId === eventId)
          ?.body
      : undefined;
  function renderBody() {
    if (query.isPending) return <p role="status">本文を読み込んでいます。</p>;
    if (query.data && "error" in query.data && query.data.error === 410)
      return (
        <p className="text-muted-foreground">本文の保管期限が過ぎています。</p>
      );
    if (body !== undefined)
      return (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm">
          {body}
        </pre>
      );
    return (
      <RequestState
        missing="記録が見つかりません。"
        status={
          query.data && "error" in query.data ? query.data.error : undefined
        }
        retry={() => void query.refetch()}
      />
    );
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="action"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "本文を閉じる" : "本文を読む"}
      </button>
      {open && renderBody()}
    </div>
  );
}

const captureLabels: Record<string, string> = {
  collecting: "収集中",
  complete: "記録の送信完了",
  partial: "一部の記録が欠落",
  unknown: "保存範囲不明",
};

export function DiagnosticsExplorer() {
  const params = useSearchParams();
  const [runInput, setRunInput] = useState(params.get("runId") ?? "");
  const [deliveryInput, setDeliveryInput] = useState("");
  const [filter, setFilter] = useState({
    runId: params.get("runId") ?? "",
    deliveryId: "",
  });
  const [selected, setSelected] = useState<string | null>(null);
  const traces = useInfiniteQuery(diagnosticTracesQueryOptions(filter));
  const allTraces = traces.data?.pages.flatMap((page) => page.traces) ?? [];
  const traceId =
    selected ?? (filter.runId ? `run/${filter.runId}` : allTraces[0]?.id);
  const trace = allTraces.find((item) => item.id === traceId);
  const events = useInfiniteQuery(
    diagnosticEventsQueryOptions(
      traceId,
      trace?.runStatus === "queued" ||
        trace?.runStatus === "running" ||
        trace?.captureState === "collecting",
    ),
  );
  const allEvents = events.data?.pages.flatMap((page) => page.events) ?? [];
  const parents = new Map(
    allEvents.map((event) => [event.spanId, event.parentSpanId]),
  );
  const depth = (spanId: string) => {
    const seen = new Set<string>();
    let parent = parents.get(spanId);
    while (parent && !seen.has(parent) && seen.size < 5) {
      seen.add(parent);
      parent = parents.get(parent);
    }
    return seen.size;
  };
  function renderEvents() {
    if (events.isError)
      return (
        <RequestState
          missing="記録が見つかりません。"
          status={Number(events.error.message)}
          retry={() => void events.refetch()}
        />
      );
    if (events.isPending) return <p role="status">履歴を読み込んでいます。</p>;
    return (
      <ol className="divide-y divide-rule">
        {allEvents.map((event) => (
          <li
            key={event.eventId}
            className="space-y-2 py-4"
            style={{ paddingLeft: `${depth(event.spanId)}rem` }}
          >
            <div className="flex flex-wrap items-baseline gap-3">
              <time className="font-mono text-xs text-muted-foreground">
                {new Date(event.occurredAt).toISOString()}
              </time>
              <span className="font-medium">{event.name}</span>
              <span className="text-sm text-signal">
                {typeof event.attributes.operation === "string"
                  ? event.attributes.operation
                  : ""}{" "}
                {typeof event.attributes.outcome === "string"
                  ? event.attributes.outcome
                  : ""}
              </span>
            </div>
            {event.requestId && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                request: {event.requestId}
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                詳細
              </summary>
              <pre className="overflow-auto whitespace-pre-wrap wrap-anywhere text-xs">
                {JSON.stringify(event.attributes, null, 2)}
              </pre>
            </details>
            {event.artifactId && (
              <DiagnosticBody
                artifactId={event.artifactId}
                eventId={event.eventId}
              />
            )}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <section className="space-y-7">
      <header className="space-y-2">
        <h1 className="text-3xl font-medium">Diagnostics</h1>
        <p className="text-muted-foreground">
          起動元、実行の経過、保存された入出力を調べます。
        </p>
      </header>
      <form
        className="surface flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({
            runId: runInput.trim(),
            deliveryId: deliveryInput.trim(),
          });
          setSelected(null);
        }}
      >
        <label className="space-y-1">
          <span className="block text-sm">Run ID</span>
          <input
            className="rounded border border-rule px-3 py-2"
            value={runInput}
            onChange={(event) => setRunInput(event.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-sm">GitHub delivery ID</span>
          <input
            className="rounded border border-rule px-3 py-2"
            value={deliveryInput}
            onChange={(event) => setDeliveryInput(event.target.value)}
          />
        </label>
        <button type="submit" className="action">
          検索
        </button>
      </form>
      {traces.isError ? (
        <RequestState
          missing="記録が見つかりません。"
          status={Number(traces.error.message)}
          retry={() => void traces.refetch()}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
          <aside className="surface space-y-4">
            <h2 className="font-medium">関連する処理</h2>
            {traces.isPending && <p role="status">読み込んでいます。</p>}
            {!traces.isPending && allTraces.length === 0 && (
              <p className="text-muted-foreground">記録が見つかりません。</p>
            )}
            <ul className="space-y-3">
              {allTraces.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full text-left ${item.id === traceId ? "text-signal" : "text-muted-foreground"}`}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="block font-medium">{item.source}</span>
                    <span className="block break-all font-mono text-xs">
                      {item.requestId ?? item.runId ?? item.id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {traces.hasNextPage && (
              <button
                type="button"
                className="action"
                onClick={() => void traces.fetchNextPage()}
              >
                さらに表示
              </button>
            )}
          </aside>
          {traceId && (
            <section className="surface space-y-5">
              <header className="space-y-2">
                <h2 className="text-lg font-medium">実行履歴</h2>
                <p className="break-all font-mono text-xs">{traceId}</p>
                {trace?.runStatus && <p>Run: {trace.runStatus}</p>}
                {trace && (
                  <p className="text-muted-foreground">
                    {captureLabels[trace.captureState] ?? trace.captureState}
                    {trace.dropped > 0 && ` · 省略 ${trace.dropped} 件`}
                  </p>
                )}
              </header>
              {renderEvents()}
              {events.hasNextPage && (
                <button
                  type="button"
                  className="action"
                  onClick={() => void events.fetchNextPage()}
                >
                  続きの履歴を読む
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
