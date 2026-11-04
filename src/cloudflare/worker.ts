import { parseProjects } from '../config';
import { selectProject } from '../core/admission';
import { GitHubLabelTrigger } from '../adapters/triggers/github-label';
import { equalSecret, readLimitedText, safeError } from '../security';
import { checkOrigin, isOwner, issueSession, sessionCookie } from './session';
import { page, script, styles } from '../web/page';
import type { Env } from './env';
export { CredentialBroker } from './credential-broker';
export { ControlPlane } from './control-plane';
export { RunCoordinator } from './run-coordinator';
export { ExecutionSandbox } from './sandbox';

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json({ service: 'meguri', status: 'ok' });
  if (url.pathname === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
  if (url.pathname === '/app.js') return new Response(script, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  if (url.pathname === '/webhooks/github' && request.method === 'POST') {
    if (!env.MEGURI_GH_WEBHOOK_SECRET) return json({ error: 'Webhook is not configured' }, 503);
    let normalized;
    const projects = parseProjects(env.PROJECTS);
    try { normalized = await new GitHubLabelTrigger(env.MEGURI_GH_WEBHOOK_SECRET, projects).normalize(request); }
    catch { return json({ error: 'Invalid webhook' }, 401); }
    if (!normalized) return json({ ignored: true });
    let project;
    try { project = selectProject(projects, normalized); }
    catch { return json({ error: 'Trigger is not authorized' }, 403); }
    if (!project) return json({ ignored: true });
    return json(await env.CONTROL.getByName('global').admit(project, normalized), 202);
  }
  const credentialsMatch = url.pathname.match(/^\/internal\/runs\/([a-f0-9]{32})\/credentials$/);
  if (credentialsMatch && request.method === 'POST') {
    const bearer = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer) return json({ error: 'Unauthorized' }, 401);
    try { return json(await env.RUNS.getByName(credentialsMatch[1]!).acquireForRun(bearer)); }
    catch { return json({ error: 'Run credentials are unavailable' }, 401); }
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !checkOrigin(request, env.APP_ORIGIN)) return json({ error: 'Invalid request origin' }, 403);
  if (url.pathname === '/login' && request.method === 'POST') {
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ error: 'Owner authentication is not configured' }, 503);
    const allowed = await env.CONTROL.getByName('global').allowLogin(request.headers.get('CF-Connecting-IP') ?? 'local');
    const form = new URLSearchParams(await readLimitedText(request, 2048));
    const password = form.get('password');
    if (!allowed || typeof password !== 'string' || password.length > 256 || !await equalSecret(password, env.ADMIN_PASSWORD)) return new Response(null, { status: 303, headers: { Location: '/?login=failed' } });
    const cookie = await issueSession(env.SESSION_SECRET);
    return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${sessionCookie}=${cookie}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200${url.protocol === 'https:' ? '; Secure' : ''}` } });
  }
  const owner = await isOwner(request, env.SESSION_SECRET);
  if (url.pathname === '/' && request.method === 'GET') return new Response(page(owner, url.searchParams.has('login')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (!owner) return json({ error: 'Unauthorized' }, 401);
  if (url.pathname === '/logout' && request.method === 'POST') return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${sessionCookie}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}` } });
  const broker = env.CREDENTIALS.getByName('codex:default');
  if (url.pathname === '/api/connection') {
    if (request.method === 'POST') { await broker.begin(); return json({ ok: true }); }
    if (request.method === 'DELETE') { await broker.disconnect(); return json({ ok: true }); }
    if (request.method === 'GET') return json(await broker.status());
  }
  if (url.pathname === '/api/runs' && request.method === 'GET') return json(await env.CONTROL.getByName('global').list());
  const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9]{32})(\/logs|\/cancel)?$/);
  if (runMatch) {
    const id = runMatch[1]!;
    if (runMatch[2] === '/cancel' && request.method === 'POST') { await env.RUNS.getByName(id).cancel(); return json({ ok: true }); }
    if (runMatch[2] === '/logs' && request.method === 'GET') {
      const part = url.searchParams.get('part');
      if (part && /^\d{8}$/.test(part)) {
        const object = await env.ARTIFACTS.get(`runs/${id}/logs/${part}.ndjson`);
        return object ? new Response(object.body, { headers: { 'Content-Type': 'application/x-ndjson' } }) : json({ error: 'Not found' }, 404);
      }
      const list = await env.ARTIFACTS.list({ prefix: `runs/${id}/logs/`, limit: 1000 });
      return json({ parts: list.objects.map(o => `${url.pathname}?part=${o.key.split('/').at(-1)!.replace('.ndjson', '')}`) });
    }
    if (!runMatch[2] && request.method === 'GET') return json(await env.RUNS.getByName(id).detail());
  }
  return json({ error: 'Not found' }, 404);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      console.error(JSON.stringify({ event: 'request.failed', path: new URL(request.url).pathname, message: safeError(error) }));
      response = json({ error: safeError(error) }, 503);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // no-referrer makes Chromium send Origin: null on HTML form POSTs.
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return response;
  },
} satisfies ExportedHandler<Env>;
