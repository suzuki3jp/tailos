import { describe, expect, it, vi } from 'vitest';
import { advanceRun, ExecutionFailed, type RunPorts } from '../src/core/run-controller';
import { access, issue, makeRun, repositoryAccess } from './fixtures';
import type { RunnerJob } from '../src/contracts/index';

function ports() {
  return {
    credentials: { acquire: vi.fn(async () => access) }, source: { loadIssue: vi.fn(async () => issue), publish: vi.fn(async () => 'https://github.com/owner/repo/pull/4') },
    repositoryCredentials: { acquire: vi.fn(async () => repositoryAccess), revoke: vi.fn(async () => {}) },
    sandboxes: { start: vi.fn(async (_job: RunnerJob) => {}), poll: vi.fn(async (): Promise<any> => ({ state: 'running', events: [], lastSeq: 0 })), destroy: vi.fn(async () => {}) },
    archive: { append: vi.fn(async () => {}), result: vi.fn(async () => {}) },
    save: vi.fn(async () => {}), refreshEndpoint: vi.fn(async () => ({ url: 'https://meguri.test/internal/credentials', bearer: 'test-lease' })), now: () => Date.now(),
  } satisfies RunPorts;
}
describe('provider-independent execution controller', () => {
  it('runs Issue → agent → PR with scoped access grants and no long-lived keys in the sandbox', async () => {
    const run = makeRun(), p = ports();
    await advanceRun(run, p);
    expect(run.phase).toBe('running');
    const job = p.sandboxes.start.mock.calls[0]![0] as any;
    expect(job.access).toEqual(access);
    expect(job.repositoryAccess).toEqual(repositoryAccess);
    expect(JSON.stringify(job)).not.toMatch(/refreshToken|privateKey|installationId/);
    p.sandboxes.poll.mockResolvedValue({ state: 'succeeded', events: [], lastSeq: 0, result: { summary: 'Done', changes: [{ path: 'a.txt', mode: '100644', contentBase64: 'YQ==' }] } });
    await advanceRun(run, p);
    expect(run.phase).toBe('succeeded'); expect(run.pullRequestUrl).toContain('/pull/4');
    expect(p.source.publish).toHaveBeenCalledTimes(1);
  });
  it('does not start a sandbox when repository write access is rejected', async () => {
    const run = makeRun(), p = ports();
    p.repositoryCredentials.acquire.mockRejectedValue(new Error('Protect main before granting sandbox write access'));
    await expect(advanceRun(run, p)).rejects.toThrow('Protect main');
    expect(p.sandboxes.start).not.toHaveBeenCalled();
  });
  it('archives every event page before publishing', async () => {
    const run = { ...makeRun(), phase: 'running' as const, issue }, p = ports();
    const result = { summary: 'Done', changes: [] };
    p.sandboxes.poll.mockResolvedValue({ state: 'succeeded', events: [{ seq: 1, time: 'now', type: 'output', data: 'one' }], lastSeq: 2, result });
    await advanceRun(run, p); expect(run.phase).toBe('running'); expect(run.lastSeq).toBe(1);
    p.sandboxes.poll.mockResolvedValue({ state: 'succeeded', events: [{ seq: 2, time: 'now', type: 'output', data: 'two' }], lastSeq: 2, result });
    await advanceRun(run, p); expect(run.phase).toBe('no_changes'); expect(p.source.publish).not.toHaveBeenCalled();
  });
  it('does not advance the event cursor when archive persistence fails', async () => {
    const run = { ...makeRun(), phase: 'running' as const, issue }, p = ports();
    p.sandboxes.poll.mockResolvedValue({ state: 'running', events: [{ seq: 1, time: 'now', type: 'output', data: 'one' }], lastSeq: 1 });
    p.archive.append.mockRejectedValue(new Error('R2 unavailable'));
    await expect(advanceRun(run, p)).rejects.toThrow('R2'); expect(run.lastSeq).toBe(0);
  });
  it('treats failed agents as terminal and never publishes partial changes', async () => {
    const run = { ...makeRun(), phase: 'running' as const, issue }, p = ports();
    p.sandboxes.poll.mockResolvedValue({ state: 'failed', events: [], lastSeq: 0, error: 'Tests failed' });
    await expect(advanceRun(run, p)).rejects.toBeInstanceOf(ExecutionFailed); expect(p.source.publish).not.toHaveBeenCalled();
  });
  it('does not execute expired runs or restart completed runs', async () => {
    const p = ports();
    await expect(advanceRun({ ...makeRun(), deadline: 0 }, p)).rejects.toThrow('deadline');
    await advanceRun({ ...makeRun(), phase: 'succeeded' }, p); expect(p.sandboxes.start).not.toHaveBeenCalled();
  });
});
