import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepositoryAccess } from '../contracts/index';

// The helper is local to one job and returns credentials only for its repository.
// Tokens never appear in clone URLs, Git configuration, or process arguments.
export async function prepareRepositoryAccess(root: string, repository: string, access: RepositoryAccess): Promise<{ helper: string; cloneOptions: string[] }> {
  const url = new URL(access.cloneUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase() !== repository.toLowerCase()) throw new Error('Invalid repository credential scope');
  if (!access.token || !access.username || [access.token, access.username, access.author.name, access.author.email].some(value => /[\r\n\0]/.test(value)) ||
      !Number.isFinite(access.expiresAt) || access.expiresAt <= Date.now()) throw new Error('Invalid or expired repository credentials');
  const credentials = join(root, 'repository-credentials.json');
  const executable = join(root, 'git-credential-run.mjs');
  await writeFile(credentials, JSON.stringify(access), { mode: 0o600 });
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
if (process.argv[2] === 'get') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const fields = Object.fromEntries(input.split('\\n').filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  const access = JSON.parse(readFileSync(${JSON.stringify(credentials)}, 'utf8'));
  const url = new URL(access.cloneUrl);
  const normalize = value => String(value ?? '').replace(/^\\//, '').replace(/\\.git$/, '').toLowerCase();
  if (fields.protocol === 'https' && fields.host === url.host && normalize(fields.path) === normalize(url.pathname) && access.expiresAt > Date.now()) {
    process.stdout.write('username=' + access.username + '\\npassword=' + access.token + '\\n\\n');
  }
}
`, { mode: 0o700 });
  const helper = `!'${executable.replaceAll("'", "'\\''")}'`;
  return { helper, cloneOptions: ['-c', `credential.helper=${helper}`, '-c', 'credential.useHttpPath=true'] };
}
