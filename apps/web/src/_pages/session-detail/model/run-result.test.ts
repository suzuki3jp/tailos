import { expect, test } from "vitest";
import { runResult } from "./run-result";

const pull = (number: number) => `https://github.com/owner/repo/pull/${number}`;

test("shows the pull requests of the branches a Run pushed", () => {
  expect(
    runResult(
      JSON.stringify({
        version: 1,
        kind: "pull_requests",
        pullRequests: [
          { branch: "feature", url: pull(1) },
          { branch: "fix", url: pull(2) },
        ],
      }),
    ),
  ).toEqual({ urls: [pull(1), pull(2)] });
});

test("shows the one pull request an older Run published", () => {
  expect(
    runResult(
      JSON.stringify({ version: 1, kind: "pull_request", url: pull(3) }),
    ),
  ).toEqual({ urls: [pull(3)] });
});

test("leaves out links that are not GitHub pull requests", () => {
  expect(
    runResult(
      JSON.stringify({
        kind: "pull_requests",
        pullRequests: [
          { url: "https://example.com/owner/repo/pull/1" },
          { url: "not a url" },
          { url: pull(4) },
          null,
        ],
      }),
    ),
  ).toEqual({ urls: [pull(4)] });
  expect(
    runResult(JSON.stringify({ kind: "pull_requests", pullRequests: [] })),
  ).toEqual({});
  expect(runResult(JSON.stringify({ kind: "completed" }))).toEqual({});
  expect(runResult("not json")).toEqual({});
  expect(runResult(null)).toEqual({});
});
