import {
  NotificationError,
  type IssueTarget,
} from "@/application/notifications/issue-comment.ts";
import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import {
  gitSha,
  triggerIssue,
  type RepositoryTarget,
  type RunTrigger,
} from "@tailos/core/runner";
import * as v from "valibot";
import type {
  ProjectRepositories,
  RepositoryChoice,
} from "@/application/projects/store.ts";

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
  state: v.optional(v.string()),
  merged_at: v.optional(v.nullable(v.string())),
});
const appSchema = v.object({
  slug: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]{1,100}$/)),
});
const userSchema = v.object({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

/** Who the Agent's commits are by: the GitHub App's bot account. */
export type GitAuthor = { name: string; email: string };
// The App's bot never changes: look it up once per Worker.
const authors = new Map<string, GitAuthor>();

type GitHubConfig = { appId: string; privateKey: string };
export class GitHubRequestError extends Error {
  constructor(
    public status: number,
    public rateLimited: boolean,
    public retryAt?: number,
  ) {
    super(`GitHub request failed (${status})`);
    this.name = "GitHubRequestError";
  }
}

function rateLimitDeadline(headers: Headers, now: number) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) return now + Number(retryAfter) * 1000;
  if (headers.get("x-ratelimit-remaining") === "0")
    return Number(headers.get("x-ratelimit-reset")) * 1000;
  return NaN;
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
  const deadline = rateLimitDeadline(response.headers, now);
  return new GitHubRequestError(
    response.status,
    rateLimited,
    rateLimited && Number.isFinite(deadline) && deadline > now
      ? deadline
      : undefined,
  );
}

export type GitHubCheckout = {
  token: string;
  expiresAt: number;
  baseSha: string;
  author: GitAuthor;
};

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

  /** Without `permissions`, the token has everything the App was granted. */
  private async token(
    target: RepositoryTarget,
    permissions?: Record<string, "read" | "write">,
  ) {
    const jwt = await this.appToken();
    return this.installationToken(target.installationId, jwt, {
      repository_ids: [target.repositoryId],
      permissions,
    });
  }

  private async appToken() {
    const pem = createPrivateKey(this.config.privateKey)
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const key = await importPKCS8(pem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.config.appId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime("5m")
      .sign(key);
  }

  private async installationToken(
    installationId: number,
    jwt: string,
    options: unknown,
  ) {
    const grant = v.parse(
      grantSchema,
      await this.json(
        `/app/installations/${installationId}/access_tokens`,
        jwt,
        "POST",
        options,
      ),
    );
    const expiresAt = Date.parse(grant.expires_at);
    if (!(expiresAt > Date.now()))
      throw new Error("Expired GitHub installation grant");
    return { token: grant.token, expiresAt };
  }

  projectRepositories(): ProjectRepositories {
    return {
      list: async () => {
        const jwt = await this.appToken();
        const choices: RepositoryChoice[] = [];
        const repository = v.object({
          id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
          full_name: v.string(),
        });
        for (let page = 1; ; page++) {
          const installations = v.parse(
            v.array(
              v.object({
                id: v.number(),
                suspended_at: v.nullable(v.string()),
              }),
            ),
            await this.json(
              `/app/installations?per_page=100&page=${page}`,
              jwt,
            ),
          );
          for (const installation of installations) {
            if (installation.suspended_at !== null) continue;
            const { token } = await this.installationToken(
              installation.id,
              jwt,
              { permissions: { metadata: "read" } },
            );
            try {
              for (let repoPage = 1; ; repoPage++) {
                const { repositories } = v.parse(
                  v.object({ repositories: v.array(repository) }),
                  await this.json(
                    `/installation/repositories?per_page=100&page=${repoPage}`,
                    token,
                  ),
                );
                choices.push(
                  ...repositories.map((repo) => ({
                    repository: repo.full_name,
                    repositoryId: repo.id,
                    installationId: installation.id,
                  })),
                );
                if (repositories.length < 100) break;
              }
            } finally {
              await this.revoke(token).catch(() => {});
            }
          }
          if (installations.length < 100) break;
        }
        return choices.sort((a, b) => a.repository.localeCompare(b.repository));
      },
      verify: async (target) => {
        const { token } = await this.installationToken(
          target.installationId,
          await this.appToken(),
          {
            repository_ids: [target.repositoryId],
            permissions: { metadata: "read" },
          },
        );
        try {
          const repo = v.parse(
            v.object({ id: v.number(), full_name: v.string() }),
            await this.json(`/repos/${target.repository}`, token),
          );
          if (
            repo.id !== target.repositoryId ||
            repo.full_name.toLowerCase() !== target.repository.toLowerCase()
          )
            throw new Error("GitHub repository target changed");
        } finally {
          await this.revoke(token).catch(() => {});
        }
      },
    };
  }

  /** Reads the current default branch of a configured repository. */
  async defaultBranch(target: RepositoryChoice) {
    const { token } = await this.installationToken(
      target.installationId,
      await this.appToken(),
      {
        repository_ids: [target.repositoryId],
        permissions: { metadata: "read" },
      },
    );
    try {
      const repo = v.parse(
        v.object({
          id: v.number(),
          full_name: v.string(),
          default_branch: v.pipe(v.string(), v.minLength(1)),
        }),
        await this.json(`/repos/${target.repository}`, token),
      );
      if (
        repo.id !== target.repositoryId ||
        repo.full_name.toLowerCase() !== target.repository.toLowerCase()
      )
        throw new Error("GitHub repository target changed");
      return repo.default_branch;
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }

  async issueComment(
    target: IssueTarget,
    marker: string,
    body: string,
    commentId: number | null,
  ) {
    try {
      return await this.writeIssueComment(target, marker, body, commentId);
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        const { status, retryAt } = error;
        if (error.rateLimited)
          throw new NotificationError("rate_limit", retryAt);
        if ([401, 403, 404].includes(status))
          throw new NotificationError("permission", retryAt);
        const permanent =
          status >= 400 && status < 500 && ![408, 409, 422].includes(status);
        throw new NotificationError(
          permanent ? "permanent" : "transient",
          retryAt,
        );
      }
      throw error;
    }
  }

  private async writeIssueComment(
    target: IssueTarget,
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
    trigger: RunTrigger,
    mode?: "plan" | "implement",
  ): Promise<GitHubCheckout> {
    const issueTrigger = triggerIssue(trigger);
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

      // Only issue triggers depend on the issue still matching at start.
      const issue = issueTrigger
        ? v.parse(
            issueSchema,
            await this.json(
              `${repo}/issues/${issueTrigger.issueNumber}`,
              token,
            ),
          )
        : undefined;
      if (
        issue &&
        (issue.state !== "open" ||
          issue.pull_request ||
          (trigger.kind === "github.issue-label" &&
            !issue.labels.some((label) => label.name === trigger.label)))
      )
        throw new Error("GitHub issue no longer matches the trigger");
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
      const base = v.parse(
        refSchema,
        await this.json(`${repo}/git/ref/heads/${branch}`, token),
      );
      const author = await this.author(token);
      return {
        // The Run's token, added to the Agent's GitHub requests outside the
        // container. It is limited to the target repository only.
        ...(await this.token(target)),
        baseSha: base.object.sha,
        author,
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

  /** The App's bot account, as git names an author. */
  private async author(token: string): Promise<GitAuthor> {
    const known = authors.get(this.config.appId);
    if (known) return known;
    const { slug } = v.parse(
      appSchema,
      await this.json("/app", await this.appToken()),
    );
    const name = `${slug}[bot]`;
    const { id } = v.parse(
      userSchema,
      await this.json(`/users/${encodeURIComponent(name)}`, token),
    );
    const author = { name, email: `${id}+${name}@users.noreply.github.com` };
    authors.set(this.config.appId, author);
    return author;
  }

  /**
   * The newest pull request whose head is each branch, in the target
   * repository. A branch whose pull requests cannot be read is left out.
   */
  async branchPullRequests(
    target: RepositoryTarget,
    branches: string[],
  ): Promise<{ branch: string; url: string }[]> {
    if (!branches.length) return [];
    const repo = "/repos/" + target.repository;
    const owner = target.repository.split("/")[0];
    const { token } = await this.token(target, { pull_requests: "read" });
    try {
      const found = await Promise.all(
        branches.map(async (branch) => {
          try {
            const pull = v
              .parse(
                v.array(pullSchema),
                await this.json(
                  `${repo}/pulls?state=all&sort=created&direction=desc&per_page=10&head=${encodeURIComponent(owner + ":" + branch)}`,
                  token,
                ),
              )
              .find(
                (pull) =>
                  pull.base.repo.id === target.repositoryId &&
                  pull.head.repo?.id === target.repositoryId &&
                  pull.head.ref === branch,
              );
            return pull ? [{ branch, url: pull.html_url }] : [];
          } catch {
            return [];
          }
        }),
      );
      return found.flat();
    } finally {
      await this.revoke(token).catch(() => {});
    }
  }
}
