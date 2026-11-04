import { isTerminal, type Run } from '../contracts/index';
import type { CredentialProvider, EventArchive, SandboxProvider, SourceRepository } from './ports';

export interface RunPorts {
  credentials: CredentialProvider;
  source: SourceRepository;
  sandboxes: SandboxProvider;
  archive: EventArchive;
  save(run: Run): Promise<void>;
  refreshEndpoint(run: Run): Promise<{ url: string; bearer: string }>;
  now(): number;
}
export class ExecutionFailed extends Error {}

// Durable scheduling/storage are supplied by the host. Provider objects never enter Core.
export async function advanceRun(run: Run, ports: RunPorts): Promise<Run> {
  if (isTerminal(run.phase)) return run;
  if (ports.now() >= run.deadline) throw new Error('Run deadline exceeded');
  if (run.phase === 'queued') {
    run.issue = await ports.source.loadIssue(run.project, run.request);
    run.phase = 'starting';
    await ports.save(run);
  }
  if (run.phase === 'starting') {
    const access = await ports.credentials.acquire(run.project.connectionId, run.connectionVersion);
    run.connectionVersion = access.connectionVersion;
    await ports.save(run);
    await ports.sandboxes.start({
      runId: run.id, engine: run.project.engine, repository: run.project.repository,
      issue: run.issue!, model: run.project.model, setupCommands: run.project.setupCommands,
      testCommands: run.project.testCommands, deadline: run.deadline, access,
      refresh: await ports.refreshEndpoint(run),
    });
    run.phase = 'running';
    await ports.save(run);
    return run;
  }
  if (run.phase === 'running') {
    const status = await ports.sandboxes.poll(run.id, run.lastSeq);
    // Save the cursor only after durable archival. Retries overwrite the same batch key.
    if (status.events.length) {
      await ports.archive.append(run.id, status.events);
      run.lastSeq = status.events.at(-1)!.seq;
      run.recentEvents = [...run.recentEvents, ...status.events].slice(-100);
      await ports.save(run);
    }
    // Drain all event pages before finalizing, even after the runner has exited.
    if (run.lastSeq < status.lastSeq) return run;
    if (status.state === 'failed') throw new ExecutionFailed(status.error ?? 'Agent execution failed');
    if (status.state === 'running') return run;
    if (!status.result) throw new Error('Runner completed without a result');
    await ports.archive.result(run.id, status.result);
    run.result = status.result;
    run.phase = run.result.changes.length ? 'publishing' : 'no_changes';
    await ports.save(run);
  }
  if (run.phase === 'publishing') {
    run.pullRequestUrl = await ports.source.publish(run.project, run.request, run.issue!, run.id, run.result!);
    run.phase = 'succeeded';
    // Large file contents live in the archive; the terminal state keeps only the summary.
    run.result = { ...run.result!, changes: [] };
    await ports.save(run);
  }
  return run;
}
