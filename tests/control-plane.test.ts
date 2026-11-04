import { describe, expect, it, vi } from 'vitest';
import { ControlPlane } from '../src/cloudflare/control-plane';
import { memoryState } from './helpers/cloudflare';
import { project, request } from './fixtures';
describe('durable trigger admission', () => {
  it('deduplicates delivery IDs and prevents simultaneous runs for the same Issue', async () => {
    const state = memoryState();
    const create = vi.fn(async () => {});
    const control = new ControlPlane(state as any, { RUNS: { getByName: () => ({ create }) } } as any);
    const results = await Promise.all([control.admit(project, request), control.admit(project, request)]);
    expect(results[0]!.id).toBe(results[1]!.id); expect(results[1]!.duplicate).toBe(true);
    expect((await control.admit(project, { ...request, deliveryId: 'other-delivery' })).id).toBe(results[0]!.id);
    await control.alarm(); expect(create).toHaveBeenCalledTimes(1);
    await control.update(results[0]!.id, 'succeeded');
    expect((await control.admit(project, { ...request, deliveryId: 'other-delivery' })).id).toBe(results[0]!.id);
    expect((await control.admit(project, { ...request, deliveryId: 'third-delivery' })).duplicate).toBe(false);
    // A late redelivery never restarts a completed run.
    expect((await control.admit(project, request)).duplicate).toBe(true);
  });
});
