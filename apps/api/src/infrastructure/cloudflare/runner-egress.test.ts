import { expect, test, vi } from "vitest";
import {
  runnerEgressAllowed,
  DependencyEgress,
} from "@/infrastructure/cloudflare/runner-egress.ts";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected env = {};
  },
}));

const tarball = "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz";

test("only HTTPS package metadata and tarball reads are allowed for dependencies", () => {
  expect(runnerEgressAllowed(new Request(tarball), undefined, true)).toBe(true);
  expect(
    runnerEgressAllowed(
      new Request("https://registry.npmjs.org/@scope%2fpkg"),
      undefined,
      true,
    ),
  ).toBe(true);
  expect(runnerEgressAllowed(new Request(tarball))).toBe(false);
  for (const path of [
    "/JSONStream",
    "/JSONStream/-/JSONStream-1.3.5.tgz",
    "/@scope%2fLegacyPackage",
    "/@scope/LegacyPackage/-/LegacyPackage-1.0.0.tgz",
  ])
    expect(
      runnerEgressAllowed(
        new Request("https://registry.npmjs.org" + path),
        undefined,
        true,
      ),
    ).toBe(true);
  for (const url of [
    "http://registry.npmjs.org/pkg/-/pkg-1.tgz",
    "https://registry.npmjs.org:444/pkg/-/pkg-1.tgz",
    "https://registry.npmjs.org.evil.example/pkg/-/pkg-1.tgz",
    "https://127.0.0.1/pkg/-/pkg-1.tgz",
    "https://[::1]/pkg/-/pkg-1.tgz",
    "https://example.com/pkg/-/pkg-1.tgz",
    "https://registry.npmjs.org/-/v1/search",
    tarball + "?data=secret",
  ])
    expect(runnerEgressAllowed(new Request(url), undefined, true)).toBe(false);
  for (const method of ["POST", "PUT", "DELETE", "CONNECT", "OPTIONS"]) {
    if (method === "CONNECT") continue; // Request itself rejects CONNECT.
    expect(
      runnerEgressAllowed(new Request(tarball, { method }), undefined, true),
    ).toBe(false);
  }
});

test("control routes are explicit and missing policy never permits arbitrary traffic", () => {
  expect(
    runnerEgressAllowed(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
      }),
    ),
  ).toBe(true);
  expect(
    runnerEgressAllowed(
      new Request("https://api.github.com/repos/o/r/issues/46"),
    ),
  ).toBe(true);
  expect(
    runnerEgressAllowed(
      new Request(
        "https://github.com/o/r.git/info/refs?service=git-upload-pack",
      ),
    ),
  ).toBe(true);
  expect(
    runnerEgressAllowed(
      new Request("https://github.com/o/r.git/git-receive-pack", {
        method: "POST",
      }),
    ),
  ).toBe(false);
  const callback = new Request(
    "https://tailos.example/_runner/runs/abc-123/credentials",
    { method: "POST" },
  );
  expect(runnerEgressAllowed(callback)).toBe(false);
  expect(runnerEgressAllowed(callback, "invalid")).toBe(false);
  expect(runnerEgressAllowed(callback, "https://tailos.example")).toBe(true);
});

test("tarball forwarding drops headers and never follows redirects", async () => {
  const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example" },
    }),
  );
  try {
    const handler = new DependencyEgress({} as never, {} as never);
    const response = await handler.fetch(
      new Request(tarball, {
        headers: {
          Authorization: "secret",
          Cookie: "secret",
          "X-Data": "secret",
        },
      }),
    );
    expect(response.status).toBe(302);
    expect(http).toHaveBeenCalledExactlyOnceWith(new URL(tarball), {
      method: "GET",
      redirect: "manual",
    });
    expect(
      (await handler.fetch(new Request("https://evil.example"))).status,
    ).toBe(403);
    expect(http).toHaveBeenCalledTimes(1);
  } finally {
    http.mockRestore();
  }
});
