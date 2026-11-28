import { expect, test, vi } from "vitest";
import { createGitHubReader } from "@/github-tool.ts";
import { githubIssueDigest } from "@tailos/core/runner";

const checkout = {
  repository: "owner/repo",
  baseSha: "a".repeat(40),
  defaultBranch: "main",
  author: {
    name: "tailos-app[bot]",
    email: "1+tailos-app[bot]@users.noreply.github.com",
  },
};
const item = {
  number: 17,
  title: "Issue obtained from GitHub",
  body: "Full requirements",
  state: "open",
  html_url: "https://github.com/owner/repo/issues/17",
};
const contents = (
  result: Awaited<ReturnType<ReturnType<typeof createGitHubReader>["read"]>>,
) => {
  expect(result.success).toBe(true);
  return JSON.parse(result.contentItems[0]!.text);
};

test("reads every Unicode-safe body page from one immutable assigned issue", async () => {
  const body = "a".repeat(15_999) + "😀" + "長".repeat(20_000);
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ ...item, body }),
  );
  const reader = createGitHubReader(
    checkout,
    AbortSignal.timeout(5000),
    http,
    17,
  );
  expect(reader.isSourceRead()).toBe(false);
  const invalidOffset = await reader.read({
    kind: "issue",
    number: 17,
    bodyOffset: 16_000,
  });
  expect(invalidOffset.success).toBe(false);
  expect(invalidOffset.contentItems[0]!.text).toContain(
    "splits a surrogate pair",
  );
  let offset: number | null = 0;
  let reconstructed = "";
  while (offset !== null) {
    const page = contents(
      await reader.read({ kind: "issue", number: 17, bodyOffset: offset }),
    );
    expect(page.body.length).toBeLessThanOrEqual(16_000);
    expect(page.bodyOffset).toBe(offset);
    expect(page.bodyLength).toBe(body.length);
    reconstructed += page.body;
    offset = page.nextBodyOffset;
    if (offset !== null) expect(reader.isSourceRead()).toBe(false);
  }
  expect(reconstructed).toBe(body);
  expect(reader.isSourceRead()).toBe(true);
  expect(http).toHaveBeenCalledOnce();
  const [url, init] = http.mock.calls[0]!;
  expect(String(url)).toBe("https://api.github.com/repos/owner/repo/issues/17");
  expect(init).toMatchObject({ method: "GET", redirect: "error" });
  // The Run's token is added to GitHub requests outside the container.
  expect(new Headers(init?.headers).get("Authorization")).toBeNull();
});

test("cannot satisfy assigned-issue coverage with unrelated reads, gaps or invalid offsets", async () => {
  const reader = createGitHubReader(
    checkout,
    AbortSignal.timeout(5000),
    async (url) => {
      const number = Number(String(url).split("/").at(-1));
      return Response.json({ ...item, number, body: "a".repeat(32_001) });
    },
    17,
  );
  await reader.read({ kind: "issue", number: 18 });
  expect(reader.isSourceRead()).toBe(false);
  expect(
    (await reader.read({ kind: "issue", number: 17, bodyOffset: 99_999 }))
      .success,
  ).toBe(false);
  expect(reader.isSourceRead()).toBe(false);
  await reader.read({ kind: "issue", number: 17, bodyOffset: 16_001 });
  await reader.read({ kind: "issue", number: 17 });
  expect(reader.isSourceRead()).toBe(false);
  await reader.read({ kind: "issue", number: 17, bodyOffset: 16_000 });
  expect(reader.isSourceRead()).toBe(true);
});

test("concurrent source reads share one lookup and immutable body", async () => {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const http = vi.fn<typeof fetch>(() => pending);
  const reader = createGitHubReader(
    checkout,
    AbortSignal.timeout(5000),
    http,
    17,
  );
  const first = reader.read({ kind: "issue", number: 17 });
  const second = reader.read({ kind: "issue", number: 17, bodyOffset: 16_000 });
  expect(http).toHaveBeenCalledOnce();
  const body = "a".repeat(32_000);
  release(Response.json({ ...item, body }));
  const pages = (await Promise.all([first, second])).map(contents);
  expect(pages.map((page) => page.body).join("")).toBe(body);
  expect(reader.isSourceRead()).toBe(true);
});

test.for([null, ""])(
  "an empty issue body is still a completed lookup (%s)",
  async (body) => {
    const reader = createGitHubReader(
      checkout,
      AbortSignal.timeout(5000),
      async () => Response.json({ ...item, body }),
      17,
    );
    const page = contents(await reader.read({ kind: "issue", number: 17 }));
    expect(page.body).toBe(body);
    expect(page.nextBodyOffset).toBeNull();
    expect(reader.isSourceRead()).toBe(true);
  },
);

test("failed and malformed lookups do not satisfy source reading and can be retried", async () => {
  let calls = 0;
  const http = vi.fn(async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 403 });
    if (calls === 2) return Response.json({ ...item, number: 18 });
    if (calls === 3) return Response.json({ ...item, pull_request: {} });
    return Response.json(item);
  });
  const reader = createGitHubReader(
    checkout,
    AbortSignal.timeout(5000),
    http,
    17,
  );
  expect(
    (await reader.read({ kind: "issue", number: 17, repository: "other/repo" }))
      .success,
  ).toBe(false);
  expect(http).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i++) {
    expect((await reader.read({ kind: "issue", number: 17 })).success).toBe(
      false,
    );
    expect(reader.isSourceRead()).toBe(false);
  }
  expect((await reader.read({ kind: "issue", number: 17 })).success).toBe(true);
  expect(reader.isSourceRead()).toBe(true);
});

test.for(["title", "body"] as const)(
  "rejects a changed authorized issue %s without caching it",
  async (field) => {
    let changed = true;
    const http = vi.fn<typeof fetch>(async () =>
      Response.json(
        changed ? { ...item, [field]: "Unapproved replacement" } : item,
      ),
    );
    const reader = createGitHubReader(
      checkout,
      AbortSignal.timeout(5000),
      http,
      17,
      await githubIssueDigest(item),
    );
    const rejected = await reader.read({ kind: "issue", number: 17 });
    expect(rejected.success).toBe(false);
    expect(rejected.diagnosticReason).toBe("issue_changed");
    expect(JSON.stringify(rejected)).not.toContain("Unapproved replacement");
    expect(rejected.contentItems[0]!.text).toContain(
      "changed after authorization",
    );
    expect(reader.isSourceRead()).toBe(false);
    changed = false;
    const retried = await reader.read({ kind: "issue", number: 17 });
    expect(retried.success).toBe(true);
    expect(retried.diagnosticReason).toBeUndefined();
    expect(reader.isSourceRead()).toBe(true);
    expect(http).toHaveBeenCalledTimes(2);
  },
);
