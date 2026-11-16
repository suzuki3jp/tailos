import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ProjectSelect } from "./project-select";

test("server rendering includes the real Select without a hydration fallback", () => {
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(<ProjectSelect compact={compact} />);
    expect(html).toContain("suzuki3jp/tailos");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-slot="select-trigger"');
    expect(html).not.toContain('aria-busy="true"');
  }
});
