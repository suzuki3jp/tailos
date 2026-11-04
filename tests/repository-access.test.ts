import { generateKeyPair, exportPKCS8 } from 'jose';
import { expect, it } from 'vitest';
import { GitHubAppRepository } from '../src/adapters/git/github-app';
import { issue, project, request } from './fixtures';

it('loads private issues and grants one repository with protected main and the App bot identity', async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const calls: { path: string; method?: string; body?: any }[] = [];
  const http: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'test-scoped-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/installation/token') return new Response(null, { status: 204 });
    if (path === '/app') return Response.json({ slug: 'meguri-test' });
    if (path.startsWith('/users/')) return Response.json({ id: 123 });
    if (path.includes('/rules/branches/')) return Response.json(['creation', 'update', 'deletion'].map(type => ({ type })));
    if (path.includes('/issues/')) return Response.json({ title: issue.title, body: issue.body, html_url: issue.url, state: 'open', labels: [{ name: project.triggerLabel }] });
    if (path.includes('/commits/')) return Response.json({ sha: issue.baseSha, commit: { tree: { sha: issue.baseTree } } });
    return Response.json({ default_branch: 'main', private: true });
  };
  const source = new GitHubAppRepository('123', await exportPKCS8(privateKey), http);
  const loaded = await source.loadIssue(project, request);
  expect(loaded.baseSha).toBe(issue.baseSha);
  const grant = await source.acquire(project, loaded);
  expect(grant).toMatchObject({ cloneUrl: 'https://github.com/owner/repo.git', username: 'x-access-token', token: 'test-scoped-token', author: { name: 'meguri-test[bot]', email: '123+meguri-test[bot]@users.noreply.github.com' } });
  expect(calls.filter(call => call.path.endsWith('/access_tokens')).every(call => JSON.stringify(call.body) === JSON.stringify({ repositories: ['repo'], permissions: { contents: 'write', issues: 'read', pull_requests: 'write' } }))).toBe(true);
  await source.revoke(grant);
  expect(calls.at(-1)).toMatchObject({ path: '/installation/token', method: 'DELETE' });
});

it('rejects an unprotected branch and revokes the token before it can reach a sandbox', async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  let revoked = false;
  const source = new GitHubAppRepository('123', await exportPKCS8(privateKey), async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/access_tokens')) return Response.json({ token: 'never-deliver-this-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (path === '/installation/token' && init?.method === 'DELETE') { revoked = true; return new Response(null, { status: 204 }); }
    if (path.includes('/rules/branches/')) return Response.json([{ type: 'pull_request' }]);
    return Response.json({ default_branch: 'main', private: true });
  });
  await expect(source.acquire(project, issue)).rejects.toThrow('Protect main');
  expect(revoked).toBe(true);
});
