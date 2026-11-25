import type { ProjectSession } from "../api/queries";

export function MessageJobContext({
  context,
}: {
  context: ProjectSession["messages"][number]["jobContext"];
}) {
  if (!context) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-rule pt-3 text-sm">
      <p className="text-muted-foreground">Structured Job Context</p>
      <pre className="whitespace-pre-wrap wrap-anywhere">
        {JSON.stringify(context, null, 2)}
      </pre>
    </div>
  );
}
