import type { TimelineItem } from "@tailos/core/timeline";

export function timelineInput(body: string) {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object") {
      if ("command" in value && typeof value.command === "string")
        return `$ ${value.command}`;
      if ("query" in value && typeof value.query === "string")
        return value.query;
      if ("arguments" in value) return JSON.stringify(value.arguments, null, 2);
    }
  } catch {
    return body;
  }
  return timelineOutput(body);
}

export function mergeTimeline(items: TimelineItem[], updates: TimelineItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const update of updates) {
    const previous = byId.get(update.id);
    if (!previous || previous.revision <= update.revision)
      byId.set(update.id, update);
  }
  return [...byId.values()].sort(
    (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  );
}

export function timelineOutput(body: string | null) {
  if (body === null) return null;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object") {
      for (const key of [
        "output",
        "text",
        "result",
        "contentItems",
        "changes",
      ] as const) {
        if (key in value) {
          const output: unknown = Object.entries(value).find(
            ([name]) => name === key,
          )?.[1];
          if (output !== undefined && output !== null)
            return typeof output === "string"
              ? output
              : JSON.stringify(output, null, 2);
        }
      }
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return body;
  }
}
