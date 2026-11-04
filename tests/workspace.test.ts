import { mkdtemp, writeFile, rename, symlink, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectChanges, command } from '../src/runtime/job';
it('extracts renames, binary content, executable modes, symlinks, deletions, and changes committed by the agent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'meguri-git-test-'));
  const signal = AbortSignal.timeout(10_000);
  const git = (args: string[]) => command(['git', ...args], cwd, signal);
  try {
    await git(['init']); await git(['config', 'user.email', 'test@example.test']); await git(['config', 'user.name', 'Test']);
    await writeFile(join(cwd, 'old.txt'), 'existing contents\n'); await writeFile(join(cwd, 'deleted.txt'), 'delete me');
    await git(['add', '.']); await git(['commit', '-m', 'initial']);
    const base = (await git(['rev-parse', 'HEAD'])).toString().trim();
    await rename(join(cwd, 'old.txt'), join(cwd, 'renamed.txt')); await rm(join(cwd, 'deleted.txt'));
    await writeFile(join(cwd, 'image.bin'), Buffer.from([0, 255, 128, 1]));
    await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\necho hi\n'); await chmod(join(cwd, 'run.sh'), 0o755);
    await symlink('renamed.txt', join(cwd, 'link'));
    await git(['add', '.']); await git(['commit', '-m', 'agent commit']);
    const changes = await collectChanges(cwd, base, signal);
    expect(changes.find(c => c.path === 'old.txt')?.contentBase64).toBeNull();
    expect(changes.find(c => c.path === 'deleted.txt')?.contentBase64).toBeNull();
    expect(changes.find(c => c.path === 'renamed.txt')?.contentBase64).toBe(Buffer.from('existing contents\n').toString('base64'));
    expect(changes.find(c => c.path === 'image.bin')?.contentBase64).toBe((await readFile(join(cwd, 'image.bin'))).toString('base64'));
    expect(changes.find(c => c.path === 'run.sh')?.mode).toBe('100755');
    expect(changes.find(c => c.path === 'link')?.mode).toBe('120000');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
