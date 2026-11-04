import { createPrivateKey } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import type { RepositoryCredentialProvider, SourceRepository } from '../../core/ports';
import type { AgentResult, ExecutionRequest, IssueContext, Project, RepositoryAccess } from '../../contracts/index';

export class GitHubAppRepository implements SourceRepository, RepositoryCredentialProvider {
  // Workers requires the global receiver when invoking its native fetch.
  constructor(private readonly appId: string, private readonly privateKey: string, private readonly http: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  private async appJwt(): Promise<string> {
    const pem = createPrivateKey(this.privateKey).export({ format: 'pem', type: 'pkcs8' }).toString();
    const key = await importPKCS8(pem, 'RS256');
    return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(this.appId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30).setExpirationTime('5m').sign(key);
  }
  private async api<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.http(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Meguri', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path.split('?')[0]} failed (${response.status})`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  private mintToken(project: Project): Promise<{ token: string; expires_at: string }> {
    return this.appJwt().then(jwt => this.api<{ token: string; expires_at: string }>(jwt, `/app/installations/${project.installationId}/access_tokens`, 'POST', {
      repositories: [project.repository.split('/')[1]], permissions: { contents: 'write', issues: 'read', pull_requests: 'write' },
    }));
  }
  private async token(project: Project): Promise<string> { return (await this.mintToken(project)).token; }
  async acquire(project: Project, issue: IssueContext): Promise<RepositoryAccess> {
    const minted = await this.mintToken(project);
    try {
      const expiresAt = Date.parse(minted.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid repository token expiration');
      const prefix = `/repos/${project.repository}`;
      const repo = await this.api<{ default_branch: string }>(minted.token, prefix);
      for (const branch of new Set([repo.default_branch, issue.baseBranch])) {
        const rules = await this.api<{ type: string }[]>(minted.token, `${prefix}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
        if (!['creation', 'update', 'deletion'].every(type => rules.some(rule => rule.type === type))) {
          throw new Error(`Protect ${branch} with active creation, update, and deletion rules before granting sandbox write access. Keep the GitHub App out of the bypass list.`);
        }
      }
      // Reading bypass actors requires ruleset administration. Operators configure
      // administrator-only bypass; the App has no administration permission.
      const app = await this.api<{ slug: string }>(await this.appJwt(), '/app');
      const botName = `${app.slug}[bot]`;
      const bot = await this.api<{ id: number }>(minted.token, `/users/${encodeURIComponent(botName)}`);
      return { cloneUrl: `https://github.com/${project.repository}.git`, username: 'x-access-token', token: minted.token,
        expiresAt, author: { name: botName, email: `${bot.id}+${botName}@users.noreply.github.com` } };
    } catch (error) {
      await this.revokeToken(minted.token).catch(() => {});
      throw error;
    }
  }
  private async revokeToken(token: string): Promise<void> {
    const response = await this.http('https://api.github.com/installation/token', { method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Meguri', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) });
    if (![204, 401].includes(response.status)) throw new Error(`Could not revoke repository token (${response.status})`);
  }
  async revoke(access: RepositoryAccess): Promise<void> {
    if (access.expiresAt > Date.now()) await this.revokeToken(access.token);
  }
  async loadIssue(project: Project, request: ExecutionRequest): Promise<IssueContext> {
    const token = await this.token(project);
    const prefix = `/repos/${project.repository}`;
    const [repo, issue] = await Promise.all([
      this.api<{ default_branch: string; private: boolean }>(token, prefix),
      this.api<{ title: string; body: string | null; html_url: string; state: string; pull_request?: unknown; labels: { name: string }[] }>(token, `${prefix}/issues/${request.issueNumber}`),
    ]);
    if (issue.pull_request || issue.state !== 'open') throw new Error('Target must be an open Issue');
    if (!issue.labels.some(l => l.name === project.triggerLabel)) throw new Error('Trigger label was removed before execution');
    const baseBranch = project.baseBranch ?? repo.default_branch;
    const commit = await this.api<{ sha: string; commit: { tree: { sha: string } } }>(token, `${prefix}/commits/${encodeURIComponent(baseBranch)}`);
    return { title: issue.title, body: issue.body ?? '', url: issue.html_url, baseBranch, baseSha: commit.sha, baseTree: commit.commit.tree.sha };
  }
  async publish(project: Project, request: ExecutionRequest, issue: IssueContext, runId: string, result: AgentResult): Promise<string> {
    const token = await this.token(project);
    const prefix = `/repos/${project.repository}`;
    const branch = `meguri/issue-${request.issueNumber}/${runId}`;
    const owner = project.repository.split('/')[0];
    const existing = await this.api<{ html_url: string }[]>(token, `${prefix}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    if (existing[0]) return existing[0].html_url;
    if (!result.changes.length || result.changes.length > 100) throw new Error('Expected 1–100 changed files');
    let total = 0;
    const paths = new Set<string>();
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const change of result.changes) {
      if (!change.path || change.path.startsWith('/') || change.path.split('/').some(p => p === '..' || p === '.git') || paths.has(change.path)) throw new Error('Invalid changed file path');
      paths.add(change.path);
      if (!['100644', '100755', '120000'].includes(change.mode)) throw new Error('Unsupported file mode');
      const size = change.contentBase64?.length ?? 0;
      total += size;
      if (size > 1_500_000 || total > 10_000_000) throw new Error('Change set exceeds prototype size limit');
      const blob = change.contentBase64 === null ? null : await this.api<{ sha: string }>(token, `${prefix}/git/blobs`, 'POST', { content: change.contentBase64, encoding: 'base64' });
      tree.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob?.sha ?? null });
    }
    const newTree = await this.api<{ sha: string }>(token, `${prefix}/git/trees`, 'POST', { base_tree: issue.baseTree, tree });
    const commit = await this.api<{ sha: string }>(token, `${prefix}/git/commits`, 'POST', {
      message: `Implement #${request.issueNumber}: ${issue.title}`, tree: newTree.sha, parents: [issue.baseSha],
    });
    // A retry after branch creation reuses the existing branch. Never force-update a ref.
    const refs = await this.api<{ ref: string; object: { sha: string } }[]>(token, `${prefix}/git/matching-refs/heads/${branch}`);
    if (!refs.some(r => r.ref === `refs/heads/${branch}`)) {
      await this.api(token, `${prefix}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    }
    const pull = await this.api<{ html_url: string }>(token, `${prefix}/pulls`, 'POST', {
      title: issue.title, head: branch, base: issue.baseBranch,
      body: `Closes #${request.issueNumber}\n\n${result.summary.slice(0, 20_000)}\n\n---\nMeguri run: \`${runId}\`\nEngine: \`${project.engine}\``,
    });
    return pull.html_url;
  }
}
