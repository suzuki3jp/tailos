import { expect, test, vi } from "vitest";
import { forwardGitHubRequest } from "@/infrastructure/cloudflare/github-egress.ts";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

function capture() {
  const sent: Request[] = [];
  const upstream = vi.fn(async (input: RequestInfo | URL) => {
    sent.push(input as Request);
    return new Response("ok");
  });
  return { sent, upstream: upstream as unknown as typeof fetch };
}

test("adds the Run's token in place of the container's placeholder", async () => {
  const { sent, upstream } = capture();
  const api = await forwardGitHubRequest(
    new Request("https://api.github.com/repos/owner/repo/issues/1/comments", {
      headers: {
        Authorization: "token placeholder",
        Cookie: "session=1",
        "User-Agent": "GitHub CLI",
      },
    }),
    async () => "run-token",
    upstream,
  );
  expect(api.status).toBe(200);
  const git = await forwardGitHubRequest(
    new Request("https://github.com/owner/repo.git/git-upload-pack", {
      method: "POST",
      body: "0000",
      headers: { "Content-Type": "application/x-git-upload-pack-request" },
    }),
    async () => "run-token",
    upstream,
  );
  expect(git.status).toBe(200);

  expect(sent.map((request) => request.url)).toEqual([
    "https://api.github.com/repos/owner/repo/issues/1/comments",
    "https://github.com/owner/repo.git/git-upload-pack",
  ]);
  expect(sent[0]!.headers.get("Authorization")).toBe("Bearer run-token");
  expect(sent[0]!.headers.get("Cookie")).toBeNull();
  expect(sent[0]!.headers.get("User-Agent")).toBe("GitHub CLI");
  expect(sent[0]!.redirect).toBe("manual");
  expect(sent[1]!.headers.get("Authorization")).toBe(
    `Basic ${btoa("x-access-token:run-token")}`,
  );
  expect(sent[1]!.method).toBe("POST");
  expect(await sent[1]!.text()).toBe("0000");
});

test("never attaches the token to another host, scheme, port or a finished Run", async () => {
  const { upstream } = capture();
  const token = vi.fn(async () => "run-token");
  for (const url of [
    "https://example.com/",
    "https://uploads.github.com/",
    "https://api.github.com.example.com/",
    "http://api.github.com/",
    "https://api.github.com:8443/",
  ]) {
    const response = await forwardGitHubRequest(
      new Request(url),
      token,
      upstream,
    );
    expect(response.status).toBe(403);
  }
  expect(token).not.toHaveBeenCalled();
  for (const unavailable of [
    async () => null,
    async () => undefined,
    async () => {
      throw new Error("storage unavailable");
    },
  ]) {
    const response = await forwardGitHubRequest(
      new Request("https://api.github.com/"),
      unavailable,
      upstream,
    );
    expect(response.status).toBe(403);
  }
  expect(upstream).not.toHaveBeenCalled();
});
