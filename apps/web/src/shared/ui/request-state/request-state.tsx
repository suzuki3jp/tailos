import { Button } from "../design-systems";

export function RequestState({
  status,
  missing,
  retry,
}: {
  status?: number;
  missing: string;
  retry: () => void;
}) {
  if (status === 404) return <p className="text-muted-foreground">{missing}</p>;
  return (
    <div className="space-y-3">
      <p role="alert" className="text-danger">
        データを取得できませんでした。
      </p>
      <Button unstyled type="button" className="action" onPress={retry}>
        再試行
      </Button>
    </div>
  );
}
