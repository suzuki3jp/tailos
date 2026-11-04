import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { GitHubAppRepository } from '../src/adapters/git/github-app';
import { project, request, issue } from './fixtures';
afterEach(() => vi.restoreAllMocks());
it.each(['injected', 'global'] as const)('publishes with %s fetch and recovers after PR creation loses its response', async (transport) => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const calls: { path: string; body: any }[] = [];
  let created = false;
  const http: typeof fetch = async function (this: unknown, input, init) {
    if (transport === 'global' && this !== globalThis) throw new TypeError('Illegal invocation: incorrect fetch receiver');
    const url = new URL(String(input)); const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith('access_tokens')) return Response.json({ token: 'github-installation-token' });
    if (path.endsWith('/pulls') && init?.method === 'GET') return Response.json(created ? [{ html_url: 'https://github.com/owner/repo/pull/4' }] : []);
    if (path.includes('matching-refs')) return Response.json([]);
    if (path.endsWith('/pulls') && init?.method === 'POST') { created = true; throw new Error('Connection lost after PR creation'); }
    return Response.json({ sha: 'c'.repeat(40) });
  };
  if (transport === 'global') vi.spyOn(globalThis, 'fetch').mockImplementation(http);
  const pem = await exportPKCS8(privateKey);
  const source = transport === 'global' ? new GitHubAppRepository('123', pem) : new GitHubAppRepository('123', pem, http);
  const result = { summary: 'Changed and tested', changes: [{ path: 'a.txt', mode: '100644' as const, contentBase64: 'YQ==' }] };
  await expect(source.publish(project, request, issue, 'run-1', result)).rejects.toThrow('Connection lost');
  expect(await source.publish(project, request, issue, 'run-1', result)).toContain('/pull/4');
  expect(calls.filter(c => c.path.endsWith('/pulls') && c.body)).toHaveLength(1);
  expect(calls.find(c => c.path.endsWith('access_tokens'))!.body).toEqual({ repositories: ['repo'], permissions: { contents: 'write', issues: 'read', pull_requests: 'write' } });
  expect(calls.find(c => c.path.endsWith('/git/trees'))!.body.base_tree).toBe(issue.baseTree);
});
