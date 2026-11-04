import { setTimeout } from 'node:timers/promises';

const origin = new URL(process.env.MEGURI_APP_ORIGIN ?? '');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Expected an HTTPS Meguri origin');
if (!process.env.ADMIN_PASSWORD) throw new Error('Missing ADMIN_PASSWORD');
const login = await fetch(new URL('/login', origin), {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
  headers: { Origin: origin.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD }),
});
const cookie = login.headers.get('Set-Cookie')?.split(';')[0];
if (login.status !== 303 || !cookie || login.headers.get('Location') !== '/') throw new Error('Meguri owner login failed');
async function read(path) {
  const response = await fetch(new URL(path, origin), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Meguri state API returned ${response.status}`);
  return response.json();
}
const runs = await read('/api/runs');
const id = process.env.MEGURI_RUN_ID || runs[0]?.id;
if (!id) { console.log('No executions found.'); process.exit(0); }
if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid execution ID');
const terminal = new Set(['succeeded', 'no_changes', 'failed', 'cancelled']);
const wait = process.env.MEGURI_WAIT === 'true';
const until = Date.now() + 65 * 60_000;
let previous;
for (;;) {
  const run = await read(`/api/runs/${id}`);
  if (!run) throw new Error('Execution not found');
  // Keep credentials, cookies, project configuration, and provider sessions out of output.
  const summary = JSON.stringify({ id: run.id, phase: run.phase, issue: run.request?.issueNumber, error: run.error, pullRequestUrl: run.pullRequestUrl });
  if (summary !== previous) { console.log(summary); previous = summary; }
  if (terminal.has(run.phase) || !wait) {
    if (run.phase === 'failed') {
      console.log(JSON.stringify({ recentEvents: run.recentEvents }));
      process.exitCode = 1;
    }
    break;
  }
  if (Date.now() >= until) throw new Error('Execution inspection timed out');
  await setTimeout(15_000);
}
