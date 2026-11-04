import { afterEach, expect, it, vi } from 'vitest';
import { RunCoordinator } from '../src/cloudflare/run-coordinator';
import { GitHubAppRepository } from '../src/adapters/git/github-app';
import { memoryState } from './helpers/cloudflare';
import { access, issue, project, request } from './fixtures';
import type { RunnerJob } from '../src/contracts/index';

afterEach(() => vi.restoreAllMocks());
it('recovers publication after a coordinator restart, keeps file contents in R2, and invalidates the run lease', async () => {
  const state = memoryState(), artifacts = new Map<string, string>();
  let job!: RunnerJob;
  const startJob = vi.fn(async (input: RunnerJob) => {
    job = input;
    // The agent can ask for renewal before the start RPC has returned.
    await coordinator.acquireForRun(job.refresh.bearer);
  });
  const stop = vi.fn(async () => {}), update = vi.fn(async () => {});
  const acquire = vi.fn(async () => access);
  const largeContent = Buffer.alloc(200_000, 'a').toString('base64');
  const env: any = {
    APP_ORIGIN: 'https://meguri.test', CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MEGURI_GH_APP_ID: '123', MEGURI_GH_APP_PRIVATE_KEY: 'not-used-in-this-test',
    CREDENTIALS: { getByName: () => ({ acquire }) }, CONTROL: { getByName: () => ({ update }) },
    SANDBOXES: { getByName: () => ({ startJob, stop, pollJob: async () => ({ state: 'succeeded', events: [], lastSeq: 0,
      result: { summary: 'Done', changes: [{ path: 'big.txt', mode: '100644', contentBase64: largeContent }] } }) }) },
    ARTIFACTS: { put: async (key: string, value: string) => artifacts.set(key, value), get: async (key: string) => artifacts.has(key) ? { json: async () => JSON.parse(artifacts.get(key)!) } : null },
  };
  vi.spyOn(GitHubAppRepository.prototype, 'loadIssue').mockResolvedValue(issue);
  const publish = vi.spyOn(GitHubAppRepository.prototype, 'publish').mockRejectedValueOnce(new Error('Temporary GitHub outage')).mockResolvedValue('https://github.com/owner/repo/pull/4');
  let coordinator = new RunCoordinator(state as any, env);
  const id = 'a'.repeat(32);
  await coordinator.create(id, project, request, Date.now()); await coordinator.alarm();
  expect(startJob).toHaveBeenCalledTimes(1);
  await coordinator.acquireForRun(job.refresh.bearer); expect(acquire).toHaveBeenLastCalledWith('default', access.connectionVersion, true);
  await coordinator.alarm(); expect((await coordinator.detail())!.phase).toBe('publishing');
  expect(JSON.stringify([...state.map.values()])).not.toContain(largeContent);
  coordinator = new RunCoordinator(state as any, env);
  await coordinator.alarm();
  expect((await coordinator.detail())!.phase).toBe('succeeded'); expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[1]![4].changes[0]!.contentBase64).toBe(largeContent);
  expect(startJob).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalled();
  await expect(coordinator.acquireForRun(job.refresh.bearer)).rejects.toThrow('invalid');
});
