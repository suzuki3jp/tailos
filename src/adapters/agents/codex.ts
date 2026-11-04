import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../../core/ports';
import type { RunnerJob } from '../../contracts/index';

export class CodexRpc {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  onNotification: (message: any) => void = () => {};
  onRequest: (message: any) => Promise<unknown> = async () => { throw new Error('Unsupported agent request'); };
  onExit: (error: Error) => void = () => {};
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid app-server JSON')); return; }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message).then(result => this.send({ id: message.id, result }),
          () => this.send({ id: message.id, error: { code: -32000, message: 'Request could not be completed' } }));
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'App-server request failed'));
        else pending.resolve(message.result);
      } else this.onNotification(message);
    });
    child.on('error', error => this.fail(error));
    child.on('exit', code => this.fail(new Error(`Codex app-server exited (${code})`)));
    child.stdin.on('error', () => this.fail(new Error('Codex app-server input closed')));
  }
  send(message: unknown): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  call<T = any>(method: string, params: unknown, timeout = 30_000): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App-server ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  close(): void {
    this.onExit = () => {};
    this.fail(new Error('App-server closed'));
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
    }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
}

export class CodexAgent implements AgentAdapter {
  readonly id = 'codex';
  async run(job: RunnerJob, context: Parameters<AgentAdapter['run']>[1]): Promise<{ sessionId: string; summary: string }> {
    const home = await mkdtemp(join(tmpdir(), 'meguri-codex-'));
    const child = spawn('codex', ['app-server', '--listen', 'stdio://',
      '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', '-c', 'features.plugins=false'], {
      cwd: context.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    });
    const rpc = new CodexRpc(child);
    let summary = '';
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    // Attach immediately: a startup failure can happen before the turn is submitted.
    void completed.catch(() => {});
    rpc.onExit = rejectTurn;
    rpc.onNotification = message => {
      if (message.method?.startsWith('account/')) return;
      context.emit(message.method ?? 'agent.event', message.params);
      const item = message.params?.item;
      if (message.method === 'item/completed' && item?.type === 'agentMessage') summary = item.text ?? summary;
      if (message.method === 'turn/completed') {
        if (message.params?.turn?.status === 'completed') resolveTurn();
        else rejectTurn(new Error(message.params?.turn?.error?.message ?? 'Codex turn did not complete'));
      }
    };
    rpc.onRequest = async message => {
      if (message.method === 'account/chatgptAuthTokens/refresh') {
        const access = await context.refresh();
        return { accessToken: access.accessToken, chatgptAccountId: access.accountId, chatgptPlanType: access.planType };
      }
      rejectTurn(new Error(`Agent requested interaction: ${message.method}`));
      throw new Error('Interactive requests are not enabled for unattended MVP runs');
    };
    createInterface({ input: child.stderr }).on('line', line => context.emit('agent.stderr', line));
    const abort = () => { rejectTurn(new Error('Agent execution cancelled')); rpc.close(); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      await rpc.call('initialize', { clientInfo: { name: 'meguri', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} });
      await rpc.call('account/login/start', { type: 'chatgptAuthTokens', accessToken: job.access.accessToken,
        chatgptAccountId: job.access.accountId, chatgptPlanType: job.access.planType });
      const thread = await rpc.call('thread/start', { cwd: context.cwd, model: job.model,
        approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: true });
      const sessionId = thread.thread?.id;
      if (typeof sessionId !== 'string') throw new Error('Codex did not return a thread ID');
      context.emit('agent.session', { engine: this.id, sessionId });
      const prompt = `Implement the following GitHub Issue in this repository.\n\n${job.issue.url}\n${job.issue.title}\n\n${job.issue.body}\n\n` +
        `Work only in this repository. Run appropriate validation. Do not push, open a PR, or merge. ` +
        `Meguri publishes the resulting files after you finish. End with a concise implementation and validation summary.`;
      await rpc.call('turn/start', { threadId: sessionId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      await completed;
      return { sessionId, summary: summary || 'Implemented the Issue. See the execution logs for validation details.' };
    } finally {
      context.signal.removeEventListener('abort', abort); rpc.close();
      await rm(home, { recursive: true, force: true });
    }
  }
}
