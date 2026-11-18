import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ProjectSelect } from "./project-select";

test("server rendering includes the real Select without a hydration fallback", () => {
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(
      <ProjectSelect
        compact={compact}
        projects={[
          { id: "p1", name: "Project Alpha", repository: "owner/repo" },
        ]}
        value="p1"
        onValueChange={() => {}}
        disabled={false}
      />,
    );
    expect(html).toContain("Project Alpha");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-slot="select-trigger"');
    expect(html).not.toContain('aria-busy="true"');
  }
});

test("an empty project list renders a disabled control without a sample project", () => {
  const html = renderToStaticMarkup(
    <ProjectSelect
      projects={[]}
      value={null}
      onValueChange={() => {}}
      disabled
    />,
  );
  expect(html).toContain("No projects");
  expect(html).toContain("disabled");
  expect(html).not.toContain("suzuki3jp/tailos");
});
