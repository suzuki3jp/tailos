import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareRepositoryAccess } from '../src/runtime/repository';
import { repositoryAccess } from './fixtures';

it('uses a job-local Git helper limited to one HTTPS repository, with no token in Git arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), "meguri-git-credentials-'"));
  try {
    const prepared = await prepareRepositoryAccess(root, 'owner/repo', repositoryAccess);
    expect(prepared.cloneOptions.join(' ')).not.toContain(repositoryAccess.token);
    expect(await readFile(join(root, 'git-credential-run.mjs'), 'utf8')).not.toContain(repositoryAccess.token);
    expect((await stat(join(root, 'repository-credentials.json'))).mode & 0o777).toBe(0o600);
    const fill = (host: string, path: string, protocol = 'https') => spawnSync('git', [...prepared.cloneOptions, 'credential', 'fill'], {
      cwd: root, encoding: 'utf8', input: `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`,
      env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    const allowed = fill('github.com', 'owner/repo.git');
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain(`password=${repositoryAccess.token}`);
    for (const denied of [fill('github.com', 'other/repo.git'), fill('other.test', 'owner/repo.git'), fill('github.com', 'owner/repo.git', 'http')]) {
      expect(denied.status).not.toBe(0);
      expect(denied.stdout + denied.stderr).not.toContain(repositoryAccess.token);
    }
    await expect(prepareRepositoryAccess(root, 'other/repo', repositoryAccess)).rejects.toThrow('scope');
    await expect(prepareRepositoryAccess(root, 'owner/repo', { ...repositoryAccess, expiresAt: 0 })).rejects.toThrow('expired');
  } finally { await rm(root, { recursive: true, force: true }); }
});
