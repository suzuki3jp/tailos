import { createServer } from 'node:http';
import type { AccessGrant, AgentEvent, JobStatus, RunnerJob } from '../contracts/index';
import type { AgentAdapter } from '../core/ports';
import { CodexAgent } from '../adapters/agents/codex';
import { executeJob } from './job';
import { redact, safeError } from '../security';

const engines: Record<string, AgentAdapter> = { codex: new CodexAgent() };
let jobId: string | undefined;
let state: JobStatus['state'] = 'running';
let result: JobStatus['result'];
let failure: string | undefined;
const events: AgentEvent[] = [];
let eventBytes = 0;
let dropped = false;
let secrets: string[] = [];
function emit(type: string, data: unknown): void {
  const clean = JSON.stringify(redact(data, secrets)) ?? 'null';
  if (events.length >= 20_000 || eventBytes > 20_000_000) {
    if (dropped) return;
    dropped = true; type = 'log.limit'; data = 'Further output omitted: prototype log limit reached';
  } else { data = clean.length > 8_000 ? clean.slice(0, 8_000) : JSON.parse(clean); }
  eventBytes += clean.length;
  events.push({ seq: events.length + 1, time: new Date().toISOString(), type, data });
}
async function start(job: RunnerJob): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, job.deadline - Date.now()));
  secrets = [job.access.accessToken, job.refresh.bearer];
  try {
    const adapter = engines[job.engine];
    if (!adapter) throw new Error(`Unknown engine: ${job.engine}`);
    result = await executeJob(job, adapter, { cwd: '', signal: controller.signal, emit, refresh: async (): Promise<AccessGrant> => {
      const response = await fetch(job.refresh.url, { method: 'POST', headers: { Authorization: `Bearer ${job.refresh.bearer}` }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error('Could not renew run credentials');
      const grant = await response.json() as AccessGrant;
      if (grant.accountId !== job.access.accountId || grant.connectionVersion !== job.access.connectionVersion) throw new Error('Run connection changed');
      secrets.push(grant.accessToken); return grant;
    } });
    for (const change of result.changes) {
      if (change.contentBase64 && secrets.some(secret => Buffer.from(change.contentBase64!, 'base64').includes(Buffer.from(secret)))) {
        throw new Error('Credential material detected in changed files; publication was stopped');
      }
    }
    result.summary = String(redact(result.summary, secrets));
    state = 'succeeded'; emit('run.completed', { changedFiles: result.changes.length });
  } catch (error) { failure = String(redact(safeError(error), secrets)); state = 'failed'; emit('run.failed', { message: failure }); }
  finally { clearTimeout(timer); }
}

createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  try {
    const url = new URL(request.url!, 'http://sandbox');
    if (request.method === 'GET' && url.pathname === '/health') { response.end('{}'); return; }
    if (request.method === 'POST' && url.pathname === '/job') {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error('Job is too large'); chunks.push(chunk); }
      const job = JSON.parse(Buffer.concat(chunks).toString()) as RunnerJob;
      if (!job.runId || !engines[job.engine] || !Number.isFinite(job.deadline) || job.deadline <= Date.now() || job.deadline > Date.now() + 61 * 60_000) throw new Error('Invalid job');
      if (jobId && jobId !== job.runId) { response.statusCode = 409; response.end('{}'); return; }
      if (!jobId) { jobId = job.runId; void start(job); }
      response.statusCode = 202; response.end('{}'); return;
    }
    if (request.method === 'GET' && url.pathname === '/job' && jobId) {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      response.end(JSON.stringify({ state, events: events.filter(e => e.seq > after).slice(0, 100), lastSeq: events.length, result, error: failure } satisfies JobStatus)); return;
    }
    response.statusCode = 404; response.end('{}');
  } catch { response.statusCode = 400; response.end(JSON.stringify({ error: 'Invalid sandbox request' })); }
}).listen(8080, '0.0.0.0');
