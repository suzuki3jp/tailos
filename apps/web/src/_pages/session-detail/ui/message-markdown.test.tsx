import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { highlightMessageCode } from "./highlight-message-code";
import { MessageMarkdown } from "./message-markdown";

test("renders headings, nested lists and soft line breaks in the conversation", () => {
  const body = [
    "# Summary",
    "",
    "- **Updated** the page",
    "  - Run `pnpm test`",
    "",
    "1. First line",
    "   second line",
  ].join("\n");
  const html = renderToStaticMarkup(<MessageMarkdown body={body} />);

  expect(html).toContain("<h2>Summary</h2>");
  expect(html.match(/<ul role="list">/g)).toHaveLength(2);
  expect(html).toContain("<strong>Updated</strong>");
  expect(html).toContain("<code>pnpm test</code>");
  expect(html).toContain("First line<br/>\nsecond line");
  expect(
    renderToStaticMarkup(<MessageMarkdown body="# Summary" withinSection />),
  ).toContain("<h3>Summary</h3>");
});

test("renders message links, HTML and image descriptions without loading images", () => {
  const body = [
    "[GitHub](https://github.com) [relative](/sessions) [invalid](javascript:noop())",
    "",
    "![A diagram](https://example.com/diagram.png)",
    "",
    "<strong>Literal HTML</strong>",
  ].join("\n");
  const html = renderToStaticMarkup(<MessageMarkdown body={body} />);

  expect(html).toContain('<a href="https://github.com">GitHub</a>');
  expect(html).toContain("relative invalid");
  expect(html.match(/<a\b/g)).toHaveLength(1);
  expect(html).toContain("A diagram");
  expect(html).not.toContain("diagram.png");
  expect(html).toContain("&lt;strong&gt;Literal HTML&lt;/strong&gt;");
});

test("renders fenced code as readable text before loading a grammar", () => {
  const body = [
    "```ts",
    '  const value = "<markup>";',
    "```",
    "",
    "```",
    "  plain code",
    "```",
  ].join("\n");
  const html = renderToStaticMarkup(<MessageMarkdown body={body} />);

  expect(html).toContain(
    "<pre><code>  const value = &quot;&lt;markup&gt;&quot;;\n</code></pre>",
  );
  expect(html).toContain("<pre><code>  plain code\n</code></pre>");
});

test("Shiki colors a language alias while retaining the positions of code tokens", async () => {
  const source = 'const value = "日本語";\n\n  console.log(value);\n';
  const tokens = await highlightMessageCode(source, "ts");

  expect(tokens).toContainEqual(
    expect.objectContaining({ content: "const", offset: 0 }),
  );
  expect(
    tokens?.every((token) => source.startsWith(token.content, token.offset)),
  ).toBe(true);
  expect(new Set(tokens?.map((token) => token.color)).size).toBeGreaterThan(1);
  await expect(
    highlightMessageCode(source, "unknown-language"),
  ).resolves.toBeUndefined();
});
