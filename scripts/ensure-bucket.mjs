import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile('wrangler.deploy.json', 'utf8'));
const path = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets`;
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };
const bucket = config.r2_buckets[0].bucket_name;
async function apiError(operation, response) {
  const body = await response.json().catch(() => null);
  const details = Array.isArray(body?.errors)
    ? body.errors.map(error => `${error.code ?? 'unknown'}: ${String(error.message ?? 'Unknown API error').slice(0, 500)}`).join('; ')
    : 'No Cloudflare error details returned';
  return new Error(`Could not ${operation} R2 bucket (${response.status}): ${details}`);
}
const current = await fetch(`${path}/${bucket}`, { headers });
if (current.status === 404) {
  const created = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ name: bucket }) });
  if (!created.ok) throw await apiError('create', created);
  console.log('Created artifact bucket.');
} else if (!current.ok) throw await apiError('inspect', current);
else console.log('Artifact bucket exists.');
