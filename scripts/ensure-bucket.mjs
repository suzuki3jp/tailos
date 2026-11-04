import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile('wrangler.deploy.json', 'utf8'));
const path = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets`;
const headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };
const bucket = config.r2_buckets[0].bucket_name;
const current = await fetch(`${path}/${bucket}`, { headers });
if (current.status === 404) {
  const created = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ name: bucket }) });
  if (!created.ok) throw new Error(`Could not create R2 bucket (${created.status})`);
  console.log('Created artifact bucket.');
} else if (!current.ok) throw new Error(`Could not inspect R2 bucket (${current.status})`);
else console.log('Artifact bucket exists.');
