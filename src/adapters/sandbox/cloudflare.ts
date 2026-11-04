import type { SandboxProvider } from '../../core/ports';
import type { JobStatus, RunnerJob } from '../../contracts/index';
import type { ExecutionSandbox } from '../../cloudflare/sandbox';

export class CloudflareSandboxProvider implements SandboxProvider {
  constructor(private readonly namespace: DurableObjectNamespace<ExecutionSandbox>) {}
  start(job: RunnerJob): Promise<void> { return this.namespace.getByName(job.runId).startJob(job); }
  poll(runId: string, after: number): Promise<JobStatus> { return this.namespace.getByName(runId).pollJob(after); }
  destroy(runId: string): Promise<void> { return this.namespace.getByName(runId).stop(); }
}
