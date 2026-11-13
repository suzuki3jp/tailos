import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";
import { api } from "@/shared/api";
import { parseDiagnosticBatch } from "@tailos/core/diagnostics";

export function diagnosticBodyQueryOptions(artifactId: string, open: boolean) {
  return queryOptions({
    queryKey: ["diagnostics", "body", artifactId],
    enabled: open,
    queryFn: async ({ signal }) => {
      const response = await api.diagnostics.artifacts[":id"].$get(
        { param: { id: artifactId } },
        { init: { signal } },
      );
      return response.ok
        ? { batch: parseDiagnosticBatch(await response.json()) }
        : { error: response.status };
    },
  });
}
export function diagnosticTracesQueryOptions(filter: {
  runId: string;
  deliveryId: string;
}) {
  return infiniteQueryOptions({
    queryKey: ["diagnostics", "traces", filter],
    initialPageParam: "",
    queryFn: async ({ signal, pageParam }) => {
      const response = await api.diagnostics.traces.$get(
        {
          query: {
            runId: filter.runId || undefined,
            source: filter.deliveryId ? "github.issue-label" : undefined,
            deliveryId: filter.deliveryId || undefined,
            before: pageParam || undefined,
          },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      if (!("traces" in result)) throw new Error("Invalid traces response");
      return result;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
}
export function diagnosticEventsQueryOptions(
  traceId: string | undefined,
  polling: boolean,
) {
  return infiniteQueryOptions({
    queryKey: ["diagnostics", "events", traceId],
    initialPageParam: 0,
    enabled: Boolean(traceId),
    queryFn: async ({ signal, pageParam }) => {
      const response = await api.diagnostics.traces[":id"].events.$get(
        {
          param: { id: encodeURIComponent(traceId ?? "") },
          query: { after: String(pageParam) },
        },
        { init: { signal } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const result = await response.json();
      if (!("events" in result)) throw new Error("Invalid events response");
      return result;
    },
    getNextPageParam: (last) =>
      last.events.length === 100 ? last.nextCursor : undefined,
    refetchInterval: polling ? 3000 : false,
  });
}
