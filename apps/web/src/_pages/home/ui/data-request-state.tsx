import { RequestState } from "@/widgets/request-state";
import { requestErrorStatus } from "@/shared/api";

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
        status={requestErrorStatus(error)}
        missing="データが見つかりません。"
        retry={retry}
      />
    </div>
  );
}
