import { DurableObject } from 'cloudflare:workers';
import type { JobStatus, RunnerJob } from '../contracts/index';
import type { Env } from './env';

// Platform-only boundary. No Codex protocol, OAuth refresh token, or GitHub key here.
export class ExecutionSandbox extends DurableObject<Env> {
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Sandbox stopped; the task will not be replayed automatically');
    return container.getTcpPort(8080).fetch(`http://runner${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  }
  async startJob(job: RunnerJob): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('Sandbox container binding is missing');
    // Persist the startup intent before boot. A lost instance must never silently replay a job.
    const started = await this.ctx.storage.get<boolean>('started');
    if (started && !container.running) throw new Error('Previous sandbox instance was lost');
    if (!container.running) {
      await this.ctx.storage.put('started', true);
      container.start({ image: container.images.agent!, instance: 'standard-2', enableInternet: true });
    }
    await container.setInactivityTimeout(120_000);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if ((await this.request('/health')).ok) { ready = true; break; } } catch { /* wait for Node */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Sandbox did not become ready');
    const response = await this.request('/job', { method: 'POST', body: JSON.stringify(job), headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`Sandbox rejected the job (${response.status})`);
  }
  async pollJob(after: number): Promise<JobStatus> {
    if (this.ctx.container?.running) await this.ctx.container.setInactivityTimeout(120_000);
    const response = await this.request(`/job?after=${after}`);
    if (!response.ok) throw new Error(`Sandbox job is unavailable (${response.status})`);
    return response.json();
  }
  async stop(): Promise<void> { if (this.ctx.container?.running) await this.ctx.container.destroy(); }
}
