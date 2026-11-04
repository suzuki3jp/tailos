import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('inspects an execution without printing the owner password, session cookie, or extra credential fields', () => {
  const id = 'a'.repeat(32);
  const preload = `globalThis.fetch = async (input, init) => {
    const path = new URL(input).pathname;
    if (path === '/login') {
      if (new URLSearchParams(init.body).get('password') !== 'fake-owner-password') throw new Error('Invalid login');
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'owner=fake-owner-session; HttpOnly' } });
    }
    if (init.headers.Cookie !== 'owner=fake-owner-session') throw new Error('Missing session');
    if (path === '/api/runs') return Response.json([{ id: '${id}' }]);
    return Response.json({ id: '${id}', phase: 'succeeded', request: { issueNumber: 1 }, pullRequestUrl: 'https://github.com/owner/repo/pull/4',
      credentials: { token: 'fake-hidden-repository-token' } });
  };`;
  const executed = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, resolve('scripts/inspect-run.mjs')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, MEGURI_APP_ORIGIN: 'https://meguri.test', ADMIN_PASSWORD: 'fake-owner-password' },
  });
  expect(executed.status, executed.stderr).toBe(0);
  expect(JSON.parse(executed.stdout)).toMatchObject({ id, phase: 'succeeded', issue: 1, pullRequestUrl: 'https://github.com/owner/repo/pull/4' });
  for (const secret of ['fake-owner-password', 'fake-owner-session', 'fake-hidden-repository-token']) expect(executed.stdout + executed.stderr).not.toContain(secret);
});
