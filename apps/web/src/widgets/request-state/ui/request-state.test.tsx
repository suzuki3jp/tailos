import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RequestState as SharedRequestState } from "@/shared/ui/request-state";
import { RequestState } from "./request-state";

test("offers the same login action to every protected screen on 401", () => {
  const html = renderToStaticMarkup(
    <RequestState status={401} missing="見つかりません。" retry={() => {}} />,
  );
  expect(html).toBe(
    '<a href="/login" class="action action-primary">GitHub でログイン</a>',
  );
});

test("preserves Shared's missing and retry displays for other failures", () => {
  for (const status of [404, 500, undefined]) {
    const props = { status, missing: "見つかりません。", retry: () => {} };
    expect(renderToStaticMarkup(<RequestState {...props} />)).toBe(
      renderToStaticMarkup(<SharedRequestState {...props} />),
    );
  }
});
