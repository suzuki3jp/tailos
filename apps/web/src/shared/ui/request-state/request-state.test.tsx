import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RequestState } from "./request-state";

test("renders the caller's unauthorized action, missing message or retry state", () => {
  function render(status?: number) {
    return renderToStaticMarkup(
      <RequestState
        status={status}
        unauthorized={<a href="/login">GitHub でログイン</a>}
        missing="Session が見つかりません。"
        retry={() => {}}
      />,
    );
  }
  expect(render(401)).toBe('<a href="/login">GitHub でログイン</a>');
  expect(render(404)).toContain("Session が見つかりません。");
  for (const status of [500, undefined]) {
    expect(render(status)).toContain("データを取得できませんでした。");
    expect(render(status)).toContain("再試行");
  }
});
