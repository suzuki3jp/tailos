import { DurableObject } from 'cloudflare:workers';
import type { ExecutionRequest, Project, RunPhase } from '../contracts/index';
import { isTerminal } from '../contracts/index';
import { issueKey } from '../core/admission';
import { sha256 } from '../security';
import type { Env } from './env';

interface Dispatch { id: string; project: Project; request: ExecutionRequest; phase: RunPhase; createdAt: number; dispatched: boolean }
export class ControlPlane extends DurableObject<Env> {
  async admit(project: Project, request: ExecutionRequest): Promise<{ id: string; duplicate: boolean }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const id = (await sha256(`${request.source}:${request.deliveryId}`)).slice(0, 32);
      const delivery = await this.ctx.storage.get<{ runId: string; createdAt: number }>(`delivery:${id}`);
      if (delivery) {
        const target = await this.ctx.storage.get<Dispatch>(`run:${delivery.runId}`);
        if (target && !target.dispatched) await this.ctx.storage.setAlarm(Date.now() + 100);
        return { id: delivery.runId, duplicate: true };
      }
      const existing = await this.ctx.storage.get<Dispatch>(`run:${id}`);
      if (existing) {
        if (!existing.dispatched) await this.ctx.storage.setAlarm(Date.now() + 100);
        return { id, duplicate: true };
      }
      const active = await this.ctx.storage.get<Record<string, string>>('active') ?? {};
      if (active[issueKey(request)]) {
        const runId = active[issueKey(request)]!;
        // Remember coalesced deliveries too: a late retry must not start a new run.
        await this.ctx.storage.put(`delivery:${id}`, { runId, createdAt: Date.now() });
        return { id: runId, duplicate: true };
      }
      if (Object.keys(active).length >= 4) throw new Error('At most four runs can be active');
      const run: Dispatch = { id, project, request, phase: 'queued', createdAt: Date.now(), dispatched: false };
      active[issueKey(request)] = id;
      await this.ctx.storage.put({ [`run:${id}`]: run, [`delivery:${id}`]: { runId: id, createdAt: Date.now() }, active });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return { id, duplicate: false };
    });
  }
  async update(id: string, phase: RunPhase): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const run = await this.ctx.storage.get<Dispatch>(`run:${id}`);
      if (!run) return;
      run.phase = phase;
      const active = await this.ctx.storage.get<Record<string, string>>('active') ?? {};
      if (isTerminal(phase) && active[issueKey(run.request)] === id) delete active[issueKey(run.request)];
      await this.ctx.storage.put({ [`run:${id}`]: run, active });
    });
  }
  async list(): Promise<Dispatch[]> {
    return [...(await this.ctx.storage.list<Dispatch>({ prefix: 'run:' })).values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  }
  async allowLogin(ip: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = `login:${await sha256(ip)}:${Math.floor(Date.now() / 60_000)}`;
      const count = await this.ctx.storage.get<number>(key) ?? 0;
      if (count >= 5) return false;
      await this.ctx.storage.put(key, count + 1);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return true;
    });
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 15_000);
    const runs = await this.ctx.storage.list<Dispatch>({ prefix: 'run:' });
    let pending = false;
    for (const [key, run] of runs) {
      if (!run.dispatched) {
        try {
          await this.env.RUNS.getByName(run.id).create(run.id, run.project, run.request, run.createdAt);
          await this.ctx.blockConcurrencyWhile(async () => {
            const latest = await this.ctx.storage.get<Dispatch>(key);
            if (latest) { latest.dispatched = true; await this.ctx.storage.put(key, latest); }
          });
        } catch { pending = true; }
      } else if (isTerminal(run.phase) && run.createdAt < Date.now() - 30 * 24 * 60 * 60_000) await this.ctx.storage.delete(key);
    }
    const logins = await this.ctx.storage.list({ prefix: 'login:' });
    for (const key of logins.keys()) if (Number(key.split(':').at(-1)) < Math.floor(Date.now() / 60_000) - 1) await this.ctx.storage.delete(key);
    const deliveries = await this.ctx.storage.list<{ createdAt: number }>({ prefix: 'delivery:' });
    for (const [key, delivery] of deliveries) if (delivery.createdAt < Date.now() - 30 * 24 * 60 * 60_000) await this.ctx.storage.delete(key);
    await this.ctx.blockConcurrencyWhile(async () => {
      if (pending || [...(await this.ctx.storage.list<Dispatch>({ prefix: 'run:' })).values()].some(r => !r.dispatched)) await this.ctx.storage.setAlarm(Date.now() + 10_000);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
