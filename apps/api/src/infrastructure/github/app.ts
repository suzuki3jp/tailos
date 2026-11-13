import { NotificationError } from "@/application/notifications/issue-comment.ts";
import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import {
  gitSha,
  type CheckedPublication,
  type RepositoryTarget,
} from "@tailos/core/runner";
import * as v from "valibot";

const repoSchema = v.object({ id: v.number(), default_branch: v.string() });
const issueSchema = v.object({
  title: v.optional(v.string()),
  body: v.optional(v.nullable(v.string())),
  state: v.string(),
  pull_request: v.optional(v.unknown()),
  labels: v.array(v.object({ name: v.string() })),
});
const grantSchema = v.object({ token: v.string(), expires_at: v.string() });
const refSchema = v.object({ object: v.object({ sha: gitSha }) });
const commitSchema = v.object({
  sha: gitSha,
  tree: v.object({ sha: gitSha }),
  parents: v.array(v.object({ sha: gitSha })),
  message: v.string(),
  verification: v.object({ verified: v.literal(true) }),
});
const commitMutationSchema = v.object({
  data: v.object({
    createCommitOnBranch: v.object({ commit: v.object({ oid: gitSha }) }),
  }),
  errors: v.optional(v.tuple([])),
});
const pullSchema = v.object({
  html_url: v.pipe(
    v.string(),
    v.regex(
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/,
    ),
  ),
  base: v.object({ ref: v.string(), repo: repoSchema }),
  head: v.object({
    ref: v.string(),
    sha: gitSha,
    repo: v.nullable(repoSchema),
  }),
});

type GitHubConfig = { appId: string; privateKey: string };
export class GitHubRequestError extends Error {
  constructor(
    public status: number,
    public rateLimited: boolean,
    public retryAt?: number,
  ) {
    super(`GitHub request failed (${status})`);
  }
}

async function requestError(response: Response) {
  const details = v.safeParse(
    v.object({ message: v.optional(v.string()) }),
    await response.json().catch(() => null),
  );
  const secondary =
    details.success &&
    /secondary rate limit|abuse detection/i.test(details.output.message ?? "");
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  const retryAfter = response.headers.get("retry-after");
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (retryAfter !== null || exhausted || secondary));
  const now = Date.now();
  const deadline =
    retryAfter !== null
      ? now + Number(retryAfter) * 1000
      : exhausted
        ? Number(response.headers.get("x-ratelimit-reset")) * 1000
        : NaN;
  return new GitHubRequestError(
    response.status,
    rateLimited,
    rateLimited
      ? Number.isFinite(deadline) && deadline > now
        ? deadline
        : undefined
      : undefined,
  );
}

export type GitHubCheckout = {
  token: string;
  expiresAt: number;
  baseSha: string;
  branch: string;
  issueSnapshot?: { title: string; body: string };
};

export const workBranchFor = (target: RepositoryTarget, runId: string) =>
  `tailos/issue-${target.issueNumber}/${runId}`;

export class GitHubApp {
  private readonly config: GitHubConfig;
  private readonly http: typeof fetch;

  constructor(
    config: GitHubConfig,
    http: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.config = config;
    this.http = http;
  }

  private async request(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) {
    return this.http("https://api.github.com" + path, {
      method,
      // Workers supports manual redirects. Callers reject the non-2xx response.
      redirect: "manual",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Tailos",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async json(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.request(path, token, method, body);
    if (!response.ok) throw await requestError(response);
    return response.json();
  }

  private async token(
    target: RepositoryTarget,
    permissions: Record<string, "read" | "write">,
  ) {
    const pem = createPrivateKey(this.config.privateKey)
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const key = await importPKCS8(pem, "RS256");
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.config.appId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime("5m")
      .sign(key);
    const grant = v.parse(
      grantSchema,
      await this.json(
        `/app/installations/${target.installationId}/access_tokens`,
        jwt,
        "POST",
        { repository_ids: [target.repositoryId], permissions },
      ),
    );
    const expiresAt = Date.parse(grant.expires_at);
    if (!(expiresAt > Date.now()))
      throw new Error("Expired GitHub installation grant");
    return { token: grant.token, expiresAt };
  }

  async issueComment(
    target: RepositoryTarget,
    marker: string,
    body: string,
    commentId: number | null,
  ) {
    try {
      return await this.writeIssueComment(target, marker, body, commentId);
    } catch (error) {
      if (error instanceof GitHubRequestError)
        throw new NotificationError(
          error.rateLimited
            ? "rate_limit"
            : [401, 403, 404].includes(error.status)
              ? "permission"
              : error.status >= 400 &&
                  error.status < 500 &&
                  ![408, 409, 422].includes(error.status)
                ? "permanent"
                : "transient",
          error.retryAt,
        );
      throw error;
    }
  }

  private async writeIssueComment(
    target: RepositoryTarget,
    marker: string,
    body: string,
    commentId: number | null,
  ): Promise<number> {
    const { token } = await this.token(target, { issues: "write" });
    const repo = "/repos/" + target.repository;
    const schema = v.object({
      id: v.number(),
      body: v.string(),
      user: v.object({ type: v.string() }),
      performed_via_github_app: v.nullable(v.object({ id: v.number() })),
    });
    try {
      if (commentId !== null) {
        try {
          const result = v.parse(
            v.object({ id: v.number() }),
            await this.json(
              `${repo}/issues/comments/${commentId}`,
              token,
              "PATCH",
              {
                body,
              },
            ),
          );
          return result.id;
        } catch (error) {
          if (!(error instanceof GitHubRequestError) || error.status !== 404)
            throw error;
          // A deleted comment can be recreated. Still reconcile first in case
          // an earlier attempt already replaced it and lost its response.
          commentId = null;
        }
      }
      if (commentId === null) {
        for (let page = 1; ; page++) {
          const comments = v.parse(
            v.array(schema),
            await this.json(
              `${repo}/issues/${target.issueNumber}/comments?per_page=100&page=${page}`,
              token,
            ),
          );
          const existing = comments.find(
            (c) =>
              c.user.type === "Bot" &&
              String(c.performed_via_github_app?.id) === this.config.appId &&
              c.body.includes(marker),
          );
          if (existing) {
            commentId = existing.id;
            break;
          }
          if (comments.length < 100) break;
        }
      }
      const result = v.parse(
        v.object({ id: v.number() }),
        await this.json(
          commentId === null
            ? `${repo}/issues/${target.issueNumber}/comments`
            : `${repo}/issues/comments/${commentId}`,
          token,
          commentId === null ? "POST" : "PATCH",
          { body },
        ),
      );
      return result.id;
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }

  async checkout(
    target: RepositoryTarget,
    runId: string,
    mode?: "plan" | "implement",
  ): Promise<GitHubCheckout> {
    const { token } = await this.token(target, {
      contents: "read",
      issues: "read",
    });
    const repo = "/repos/" + target.repository;
    try {
      const metadata = v.parse(repoSchema, await this.json(repo, token));
      if (
        metadata.id !== target.repositoryId ||
        metadata.default_branch !== target.defaultBranch
      )
        throw new Error("GitHub repository target changed");

      const issue = v.parse(
        issueSchema,
        await this.json(`${repo}/issues/${target.issueNumber}`, token),
      );
      if (
        issue.state !== "open" ||
        issue.pull_request ||
        (mode !== "plan" &&
          !issue.labels.some((label) => label.name === target.triggerLabel))
      )
        throw new Error("GitHub issue no longer matches the trigger");
      if (workBranchFor(target, runId) === target.defaultBranch)
        throw new Error("The work branch cannot be the default branch");
      const branch = encodeURIComponent(target.defaultBranch);
      if (mode !== "plan") {
        const rules = v.parse(
          v.array(v.object({ type: v.string() })),
          await this.json(
            `${repo}/rules/branches/${branch}?per_page=100`,
            token,
          ),
        );
        if (
          !["creation", "update", "deletion"].every((required) =>
            rules.some((rule) => rule.type === required),
          )
        )
          throw new Error(
            "The default branch must have active creation, update and deletion restrictions",
          );
      }
      const issueSnapshot =
        mode === "plan"
          ? v.parse(
              v.object({ title: v.string(), body: v.nullable(v.string()) }),
              issue,
            )
          : undefined;
      const base = v.parse(
        refSchema,
        await this.json(`${repo}/git/ref/heads/${branch}`, token),
      );
      return {
        ...(await this.token(target, {
          contents: "read",
          issues: "read",
          pull_requests: "read",
        })),
        ...(issueSnapshot && {
          issueSnapshot: {
            title: issueSnapshot.title,
            body: issueSnapshot.body ?? "",
          },
        }),
        baseSha: base.object.sha,
        branch: workBranchFor(target, runId),
      };
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }

  async revoke(token: string) {
    const response = await this.request("/installation/token", token, "DELETE");
    if (!response.ok && response.status !== 401)
      throw new Error("GitHub token revocation failed");
  }

  async hasCommit(
    target: RepositoryTarget,
    runId: string,
    work: { branch: string; sha: string },
  ) {
    if (work.branch !== workBranchFor(target, runId))
      throw new Error("Unexpected work branch");
    const { token } = await this.token(target, { contents: "read" });
    try {
      const response = await this.request(
        `/repos/${target.repository}/git/ref/heads/${encodeURIComponent(work.branch)}`,
        token,
      );
      if (response.status === 404) return false;
      if (!response.ok) throw new Error("GitHub ref verification unavailable");
      return v.parse(refSchema, await response.json()).object.sha === work.sha;
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }

  async commitCheckedWork(
    target: RepositoryTarget,
    runId: string,
    work: Pick<
      CheckedPublication,
      "branch" | "baseSha" | "tree" | "headline" | "changes"
    >,
    deadlineAt: number,
  ): Promise<string | null> {
    const branch = workBranchFor(target, runId);
    if (work.branch !== branch || branch === target.defaultBranch)
      throw new Error("Unexpected work branch");
    const repo = "/repos/" + target.repository;
    const { token } = await this.token(target, { contents: "write" });
    const ref = "refs/heads/" + branch;
    const refPath = `${repo}/git/ref/heads/${encodeURIComponent(branch)}`;
    const readHead = async () => {
      const response = await this.request(refPath, token);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("GitHub ref verification unavailable");
      return v.parse(refSchema, await response.json()).object.sha;
    };
    const body = `Tailos run: ${runId}`;
    try {
      let sha = await readHead();
      if (sha === null) {
        if (Date.now() >= deadlineAt) return null;
        const created = await this.request(`${repo}/git/refs`, token, "POST", {
          ref,
          sha: work.baseSha,
        });
        if (created.ok) {
          sha = v.parse(refSchema, await created.json()).object.sha;
          if (sha !== work.baseSha)
            throw new Error("Unexpected work branch head");
        } else if (created.status === 422) {
          await created.body?.cancel();
          sha = await readHead();
        } else {
          await created.body?.cancel();
        }
        if (sha === null)
          throw new Error("GitHub work branch creation unavailable");
      }
      if (sha === work.baseSha) {
        if (Date.now() >= deadlineAt) return null;
        const created = v.parse(
          commitMutationSchema,
          await this.json("/graphql", token, "POST", {
            query: `mutation TailosCommit($input: CreateCommitOnBranchInput!) {
              createCommitOnBranch(input: $input) { commit { oid } }
            }`,
            variables: {
              input: {
                branch: {
                  repositoryNameWithOwner: target.repository,
                  branchName: branch,
                },
                expectedHeadOid: work.baseSha,
                message: { headline: work.headline, body },
                fileChanges: work.changes,
              },
            },
          }),
        );
        sha = created.data.createCommitOnBranch.commit.oid;
      }

      // A timed-out mutation can already have advanced the ref. Only adopt the
      // exact signed commit for this run and verified snapshot.
      const commit = v.parse(
        commitSchema,
        await this.json(`${repo}/git/commits/${sha}`, token),
      );
      if (
        commit.sha !== sha ||
        commit.tree.sha !== work.tree ||
        commit.parents.length !== 1 ||
        commit.parents[0]?.sha !== work.baseSha ||
        commit.message.trimEnd() !== `${work.headline}\n\n${body}`
      )
        throw new Error("GitHub commit does not match checked work");
      return sha;
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }

  async publish(
    target: RepositoryTarget,
    runId: string,
    publication: { branch: string; sha: string; headline?: string },
    deadlineAt = Infinity,
  ) {
    const branch = workBranchFor(target, runId);
    if (publication.branch !== branch)
      throw new Error("Unexpected work branch");

    const repo = "/repos/" + target.repository;
    const owner = target.repository.split("/")[0];
    const { token } = await this.token(target, {
      contents: "read",
      pull_requests: "write",
    });
    try {
      const existing = v.parse(
        v.array(pullSchema),
        await this.json(
          `${repo}/pulls?state=all&head=${encodeURIComponent(owner + ":" + branch)}`,
          token,
        ),
      );
      const previous = existing.find(
        (pull) =>
          pull.base.repo.id === target.repositoryId &&
          pull.head.repo?.id === target.repositoryId &&
          pull.base.ref === target.defaultBranch &&
          pull.head.ref === branch &&
          pull.head.sha === publication.sha,
      );
      if (previous) return previous.html_url;
      if (Date.now() >= deadlineAt) return null;
      if (existing.length)
        throw new Error(
          "Work branch is already associated with another pull request",
        );

      const head = v.parse(
        refSchema,
        await this.json(
          `${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
          token,
        ),
      );
      if (head.object.sha !== publication.sha)
        throw new Error("Work branch changed before publication");
      if (Date.now() >= deadlineAt) return null;
      const pull = v.parse(
        pullSchema,
        await this.json(`${repo}/pulls`, token, "POST", {
          title:
            publication.headline ?? `Implement issue #${target.issueNumber}`,
          head: branch,
          base: target.defaultBranch,
          body: `Closes #${target.issueNumber}\n\nCreated by Tailos run \`${runId}\`.`,
        }),
      );
      if (
        pull.base.repo.id !== target.repositoryId ||
        pull.head.repo?.id !== target.repositoryId ||
        pull.base.ref !== target.defaultBranch ||
        pull.head.ref !== branch ||
        pull.head.sha !== publication.sha
      )
        throw new Error("Published pull request does not match the run");
      return pull.html_url;
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }
}
