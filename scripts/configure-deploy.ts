import { readFile, writeFile } from 'node:fs/promises';
import { parseProjects } from '../src/config.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const origin = new URL(required('MEGURI_APP_ORIGIN'));
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('MEGURI_APP_ORIGIN must be an HTTPS origin');
const customDomains = (config.routes ?? []).filter((route: { custom_domain?: boolean }) => route.custom_domain);
if (customDomains.length && !customDomains.some((route: { pattern: string }) => route.pattern === origin.host)) {
  throw new Error('MEGURI_APP_ORIGIN must match a Custom Domain in wrangler.jsonc');
}
const projects = parseProjects(process.env.MEGURI_PROJECTS || await readFile('config/projects.json', 'utf8'));
if (!projects.length) throw new Error('Configure at least one target project');
config.name = process.env.MEGURI_WORKER_NAME || 'meguri';
config.account_id = required('CLOUDFLARE_ACCOUNT_ID');
config.vars = { APP_ORIGIN: origin.origin, PROJECTS: JSON.stringify(projects) };
config.r2_buckets[0].bucket_name = process.env.MEGURI_BUCKET_NAME || 'meguri-artifacts';
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.r2_buckets[0].bucket_name)) throw new Error('Invalid R2 bucket name');
if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.name)) throw new Error('Invalid Worker name');
const secrets = Object.fromEntries(['ADMIN_PASSWORD', 'SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'MEGURI_GH_APP_ID', 'MEGURI_GH_APP_PRIVATE_KEY', 'MEGURI_GH_WEBHOOK_SECRET'].map(name => [name, required(name)]));
if (secrets.ADMIN_PASSWORD!.length < 16 || secrets.SESSION_SECRET!.length < 32) throw new Error('Admin password/session secret are too short');
if (Buffer.from(secrets.CREDENTIAL_ENCRYPTION_KEY!, 'base64').length !== 32) throw new Error('Credential key must decode to 32 bytes');
await writeFile('wrangler.deploy.json', JSON.stringify(config, null, 2) + '\n');
await writeFile(required('MEGURI_SECRETS_FILE'), JSON.stringify(secrets), { mode: 0o600 });
console.log('Validated deployment configuration and wrote the secrets file.');
