import { DurableObject } from 'cloudflare:workers';
import { isTerminal, type AgentResult, type ExecutionRequest, type Project, type RepositoryAccess, type Run } from '../contracts/index';
import { advanceRun, ExecutionFailed } from '../core/run-controller';
import { GitHubAppRepository } from '../adapters/git/github-app';
import { CloudflareSandboxProvider } from '../adapters/sandbox/cloudflare';
import { equalSecret, safeError, sha256 } from '../security';
import type { Env } from './env';
import { seal, unseal, type Sealed } from './sealed-store';

export class RunCoordinator extends DurableObject<Env> {
  // Git publication can exceed blockConcurrencyWhile's 30-second limit.
  // Serialize events without holding Cloudflare's initialization lock across network I/O.
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private async load(): Promise<Run | undefined> {
    const run = await this.ctx.storage.get<Run>('run');
    if (!run) return;
    run.issue = await this.ctx.storage.get('issue');
    run.result = await this.ctx.storage.get('result');
    run.recentEvents = await this.ctx.storage.get('recentEvents') ?? [];
    return run;
  }
  private async save(run: Run): Promise<void> {
    const { issue, result, recentEvents, ...record } = run;
    const entries: Record<string, unknown> = { run: { ...record, recentEvents: [] }, recentEvents: recentEvents.slice(-8) };
    if (issue) entries.issue = issue;
    if (result) entries.result = { ...result, summary: result.summary.slice(0, 20_000), changes: [] };
    await this.ctx.storage.put(entries);
    console.log(JSON.stringify({ event: 'run.state', runId: run.id, projectId: run.project.id, phase: run.phase }));
  }
  async create(id: string, project: Project, request: ExecutionRequest, createdAt: number): Promise<void> {
    await this.serial(async () => {
      const existing = await this.load();
      if (existing) {
        if (!await this.ctx.storage.get('cleaned')) await this.ctx.storage.setAlarm(Date.now() + 100);
        return;
      }
      const run: Run = { id, project, request, createdAt, deadline: createdAt + project.maxRunMinutes * 60_000,
        phase: 'queued', lastSeq: 0, recentEvents: [] };
      await this.save(run);
      await this.ctx.storage.setAlarm(Date.now() + 100);
    });
  }
  async detail(): Promise<Run | null> { return await this.load() ?? null; }
  async acquireForRun(bearer: string): Promise<unknown> {
    const run = await this.load();
    const hash = await this.ctx.storage.get<string>('leaseHash');
    if (!run || !['starting', 'running'].includes(run.phase) || run.deadline <= Date.now() || !hash || !await equalSecret(await sha256(bearer), hash)) throw new Error('Run credential lease is invalid');
    return this.env.CREDENTIALS.getByName('codex:default').acquire(run.project.connectionId, run.connectionVersion, true);
  }
  async cancel(): Promise<void> {
    await this.serial(async () => {
      const run = await this.load();
      if (!run || isTerminal(run.phase)) return;
      run.phase = 'cancelled'; await this.save(run); await this.cleanup(run);
    });
  }
  private async cleanup(run: Run): Promise<void> {
    // Invalidate the lease before stopping the workload or releasing its Issue lock.
    await this.ctx.storage.delete(['leaseHash', 'lease']);
    let revokeFailure: unknown;
    const sealed = await this.ctx.storage.get<Sealed>('repositoryAccess');
    if (sealed) {
      try {
        const access = await unseal<RepositoryAccess>(sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, `run:${run.id}:repository`);
        await new GitHubAppRepository(this.env.MEGURI_GH_APP_ID, this.env.MEGURI_GH_APP_PRIVATE_KEY).revoke(access);
        await this.ctx.storage.delete('repositoryAccess');
      } catch (error) { revokeFailure = error; }
    }
    // Destroy the workload and release the Issue even if GitHub is unavailable.
    // Keep the encrypted token and alarm until revocation can be retried.
    await this.env.SANDBOXES.getByName(run.id).stop();
    await this.env.CONTROL.getByName('global').update(run.id, run.phase);
    if (revokeFailure) throw revokeFailure;
    await this.ctx.storage.put('cleaned', true);
    await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const run = await this.load();
      if (!run) return;
      // Re-arm before work: a restart at any await cannot strand a run indefinitely.
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
      if (isTerminal(run.phase)) { await this.cleanup(run); return; }
      const archive = {
        append: async (id: string, events: Run['recentEvents']) => {
          const part = events[0]!.seq.toString().padStart(8, '0');
          await this.env.ARTIFACTS.put(`runs/${id}/logs/${part}.ndjson`, events.map(e => JSON.stringify(e)).join('\n') + '\n', { httpMetadata: { contentType: 'application/x-ndjson' } });
        },
        result: async (id: string, result: AgentResult) => {
          await this.env.ARTIFACTS.put(`runs/${id}/result.json`, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
        },
      };
      try {
        if (run.phase === 'publishing') {
          const artifact = await this.env.ARTIFACTS.get(`runs/${run.id}/result.json`);
          if (!artifact) throw new Error('Run result artifact is missing');
          run.result = await artifact.json<AgentResult>();
        }
        const source = new GitHubAppRepository(this.env.MEGURI_GH_APP_ID, this.env.MEGURI_GH_APP_PRIVATE_KEY);
        await advanceRun(run, {
          source,
          repositoryCredentials: {
            acquire: async (project, issue) => {
              const sealed = await this.ctx.storage.get<Sealed>('repositoryAccess');
              if (sealed) return unseal<RepositoryAccess>(sealed, this.env.CREDENTIAL_ENCRYPTION_KEY, `run:${run.id}:repository`);
              const access = await source.acquire(project, issue);
              await this.ctx.storage.put('repositoryAccess', await seal(access, this.env.CREDENTIAL_ENCRYPTION_KEY, `run:${run.id}:repository`));
              return access;
            },
            revoke: access => source.revoke(access),
          },
          credentials: { acquire: (id, version) => this.env.CREDENTIALS.getByName('codex:default').acquire(id, version) },
          sandboxes: new CloudflareSandboxProvider(this.env.SANDBOXES), archive, save: r => this.save(r), now: () => Date.now(),
          refreshEndpoint: async r => {
            const stored = await this.ctx.storage.get<Sealed>('lease');
            const bearer = stored ? await unseal<string>(stored, this.env.CREDENTIAL_ENCRYPTION_KEY, `run:${r.id}`) : crypto.randomUUID() + crypto.randomUUID();
            await this.ctx.storage.put({ leaseHash: await sha256(bearer), lease: await seal(bearer, this.env.CREDENTIAL_ENCRYPTION_KEY, `run:${r.id}`) });
            return { url: `${this.env.APP_ORIGIN}/internal/runs/${r.id}/credentials`, bearer };
          },
        });
        await this.ctx.storage.put('failures', 0);
        await this.env.CONTROL.getByName('global').update(run.id, run.phase);
      } catch (error) {
        const failures = (await this.ctx.storage.get<number>('failures') ?? 0) + 1;
        await this.ctx.storage.put('failures', failures);
        const message = safeError(error);
        console.error(JSON.stringify({ event: 'run.step_failed', runId: run.id, phase: run.phase, attempt: failures, message }));
        // Only control-plane calls retry. A reported agent/test failure is terminal.
        if (!(error instanceof ExecutionFailed) && failures < 3 && Date.now() < run.deadline && ['running', 'publishing'].includes(run.phase)) {
          await this.ctx.storage.setAlarm(Date.now() + 10_000); return;
        }
        run.phase = 'failed'; run.error = message;
        await this.save(run);
        await this.env.ARTIFACTS.put(`runs/${run.id}/failure.json`, JSON.stringify({ runId: run.id, time: new Date().toISOString(), message }));
      }
      if (isTerminal(run.phase)) await this.cleanup(run);
      else await this.ctx.storage.setAlarm(Date.now() + 5_000);
    });
  }
}
