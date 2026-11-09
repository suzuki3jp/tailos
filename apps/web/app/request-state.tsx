export function RequestState({
  status,
  missing,
  retry,
}: {
  status?: number;
  missing: string;
  retry: () => void;
}) {
  if (status === 401)
    return (
      <a href="/login" className="action action-primary">
        GitHub でログイン
      </a>
    );
  if (status === 404) return <p className="text-muted">{missing}</p>;
  return (
    <div className="space-y-3">
      <p role="alert" className="text-danger">
        データを取得できませんでした。
      </p>
      <button type="button" className="action" onClick={retry}>
        再試行
      </button>
    </div>
  );
}
