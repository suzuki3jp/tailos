import { RequestState } from "@/widgets/request-state";
import { HomeRequestError } from "../api/queries";

export function DataRequestState({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => void;
}) {
  return (
    <div lang="ja">
      <RequestState
        status={error instanceof HomeRequestError ? error.status : undefined}
        missing="データが見つかりません。"
        retry={retry}
      />
    </div>
  );
}
