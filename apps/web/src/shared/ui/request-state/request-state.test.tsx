import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RequestState } from "./request-state";

test("renders the missing message or retry state", () => {
  function render(status?: number) {
    return renderToStaticMarkup(
      <RequestState
        status={status}
        missing="Session が見つかりません。"
        retry={() => {}}
      />,
    );
  }
  expect(render(404)).toContain("Session が見つかりません。");
  for (const status of [500, undefined]) {
    expect(render(status)).toContain("データを取得できませんでした。");
    expect(render(status)).toContain("再試行");
  }
});
