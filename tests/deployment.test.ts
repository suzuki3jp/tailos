import { mkdtemp, copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parseProjects } from '../src/config';
it('validates the project example and writes deployment secrets without shell interpolation', async () => {
  const projects = await readFile('config/projects.example.json', 'utf8');
  expect(parseProjects(projects)).toHaveLength(1);
  const cwd = await mkdtemp(join(tmpdir(), 'meguri-deploy-test-'));
  try {
    await copyFile('wrangler.jsonc', join(cwd, 'wrangler.jsonc'));
    const privateKey = '-----BEGIN RSA PRIVATE KEY-----\ncontains-$dollar-and-`backticks`\n-----END RSA PRIVATE KEY-----';
    const secretPath = join(cwd, 'secrets.json');
    const deployEnv = { PATH: process.env.PATH,
        MEGURI_APP_ORIGIN: 'https://meguri.suzuki3.jp', MEGURI_PROJECTS: projects,
        CLOUDFLARE_ACCOUNT_ID: 'fake-account-id', MEGURI_SECRETS_FILE: secretPath,
        ADMIN_PASSWORD: 'test-password-with-16-characters', SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), MEGURI_GH_APP_ID: '123',
        MEGURI_GH_APP_PRIVATE_KEY: privateKey, MEGURI_GH_WEBHOOK_SECRET: 'fake-webhook-secret',
      };
    const executed = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/configure-deploy.ts')], {
      cwd, encoding: 'utf8', env: deployEnv,
    });
    expect(executed.status, executed.stderr).toBe(0);
    const config = JSON.parse(await readFile(join(cwd, 'wrangler.deploy.json'), 'utf8'));
    expect(config.vars.APP_ORIGIN).toBe('https://meguri.suzuki3.jp');
    expect(config.routes).toEqual([{ pattern: 'meguri.suzuki3.jp', custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
    expect(config.containers[0].images.agent.dockerfile).toBe('./Dockerfile');
    const secrets = JSON.parse(await readFile(secretPath, 'utf8'));
    expect(secrets.MEGURI_GH_APP_PRIVATE_KEY).toBe(privateKey);
    expect(executed.stdout).not.toContain('fake-webhook-secret');
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    const mismatched = spawnSync(process.execPath, ['--experimental-strip-types', resolve('scripts/configure-deploy.ts')], {
      cwd, encoding: 'utf8', env: { ...deployEnv, MEGURI_APP_ORIGIN: 'https://other.example.test' },
    });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain('must match a Custom Domain');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
it('uses Actions configuration names accepted by GitHub', async () => {
  const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
  const names = [...workflow.matchAll(/\b(?:secrets|vars)(?:\.([A-Za-z_][A-Za-z_0-9]*)|\[['"]([^'"]+)['"]\])/g)].map(match => match[1] ?? match[2]!);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name).toMatch(/^[A-Za-z_][A-Za-z_0-9]*$/);
    expect(name.toUpperCase()).not.toMatch(/^GITHUB_/);
  }
  expect(names).toContain('MEGURI_GH_APP_PRIVATE_KEY');
  expect(names).toContain('MEGURI_GH_APP_ID');
  expect(names).toContain('MEGURI_GH_WEBHOOK_SECRET');
});
it('reports Cloudflare R2 error details without exposing the API token or attempting bucket creation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'meguri-bucket-test-'));
  try {
    await writeFile(join(cwd, 'wrangler.deploy.json'), JSON.stringify({ account_id: 'fake-account', r2_buckets: [{ bucket_name: 'test-artifacts' }] }));
    const mock = `globalThis.fetch = async (_url, options) => {
      if (options.method === 'POST') throw new Error('Unexpected bucket creation after a forbidden response');
      return new Response(JSON.stringify({ errors: [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }] }), { status: 403 });
    };`;
    const executed = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, resolve('scripts/ensure-bucket.mjs')], {
      cwd, encoding: 'utf8', env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: 'fake-api-token-do-not-print' },
    });
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toContain('Could not inspect R2 bucket (403): 10042: Please enable R2 through the Cloudflare Dashboard.');
    expect(executed.stderr).not.toContain('Unexpected bucket creation');
    expect(executed.stdout + executed.stderr).not.toContain('fake-api-token-do-not-print');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
