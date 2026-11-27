import { expect, test, vi } from "vitest";
import {
  forwardGitHubRequest,
  readPushedBranches,
} from "@/infrastructure/cloudflare/github-egress.ts";

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

const pkt = (line: string) =>
  (line.length + 4).toString(16).padStart(4, "0") + line;
const zero = "0".repeat(40);
const a = "a".repeat(40);
const b = "b".repeat(40);
/** The start of a git push: shallow lines, ref commands, then the pack. */
const push =
  pkt(`shallow ${a}\n`) +
  pkt(`${zero} ${a} refs/heads/feature\0report-status side-band-64k\n`) +
  pkt(`${a} ${b} refs/heads/fix/nested\n`) +
  pkt(`${a} ${zero} refs/heads/removed\n`) +
  pkt(`${zero} ${a} refs/tags/v1\n`) +
  pkt(`${zero} ${b} refs/heads/feature\n`) +
  "0000" +
  "PACK\u0000\u0000\u0000\u0002 binary pack data";

/** A body that arrives a few bytes at a time, as a network stream does. */
function chunked(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, (offset += size)));
    },
  });
}

test.for([1, 7, 4096])(
  "reads the branches a push creates or updates and forwards it unchanged (%i-byte chunks)",
  async (size) => {
    const { branches, body } = await readPushedBranches(chunked(push, size));
    // Deletions and tags are not branches the Run's result shows.
    expect(branches).toEqual(["feature", "fix/nested"]);
    expect(await new Response(body).text()).toBe(push);
  },
);

test("names no branches for a push whose commands cannot be read", async () => {
  for (const text of ["zzzz not a pkt-line", "0002", pkt("feature") + "0000"]) {
    const { branches, body } = await readPushedBranches(chunked(text, 3));
    expect(branches).toEqual([]);
    expect(await new Response(body).text()).toBe(text);
  }
});

test("records a push's branches before forwarding it, and nothing else", async () => {
  const { sent, upstream } = capture();
  const recorded: [string, string[]][] = [];
  const recordPush = vi.fn(async (repository: string, branches: string[]) => {
    recorded.push([repository, branches]);
  });
  const response = await forwardGitHubRequest(
    new Request("https://github.com/owner/repo.git/git-receive-pack", {
      method: "POST",
      body: push,
      headers: { "Content-Type": "application/x-git-receive-pack-request" },
    }),
    async () => "run-token",
    upstream,
    recordPush,
  );
  expect(response.status).toBe(200);
  expect(recorded).toEqual([["owner/repo", ["feature", "fix/nested"]]]);
  expect(await sent[0]!.text()).toBe(push);

  // A fetch is not a push; a failed record does not stop the push.
  await forwardGitHubRequest(
    new Request("https://github.com/owner/repo.git/git-upload-pack", {
      method: "POST",
      body: push,
    }),
    async () => "run-token",
    upstream,
    recordPush,
  );
  expect(recordPush).toHaveBeenCalledOnce();
  const failing = vi.fn(async () => {
    throw new Error("storage unavailable");
  });
  const pushed = await forwardGitHubRequest(
    new Request("https://github.com/owner/repo/git-receive-pack", {
      method: "POST",
      body: push,
    }),
    async () => "run-token",
    upstream,
    failing,
  );
  expect(pushed.status).toBe(200);
  expect(failing).toHaveBeenCalledExactlyOnceWith("owner/repo", [
    "feature",
    "fix/nested",
  ]);
  expect(await sent[2]!.text()).toBe(push);

  // Without the Run's token nothing is read or recorded.
  const denied = await forwardGitHubRequest(
    new Request("https://github.com/owner/repo.git/git-receive-pack", {
      method: "POST",
      body: push,
    }),
    async () => null,
    upstream,
    recordPush,
  );
  expect(denied.status).toBe(403);
  expect(recordPush).toHaveBeenCalledOnce();
});
