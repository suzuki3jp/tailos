import { describe, expect, it } from 'vitest';
import { GitHubLabelTrigger } from '../src/adapters/triggers/github-label';
import { selectProject } from '../src/core/admission';
import { project, request } from './fixtures';

async function webhook(payload: unknown, event = 'issues', tamper = false) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-webhook-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex');
  return new Request('https://meguri.test/webhooks/github', { method: 'POST', body: body + (tamper ? ' ' : ''), headers: { 'x-hub-signature-256': `sha256=${signature}`, 'x-github-event': event, 'x-github-delivery': 'delivery-1' } });
}
const payload = { action: 'labeled', repository: { full_name: 'owner/repo' }, issue: { number: 3 }, label: { name: 'meguri:run' }, sender: { login: 'owner' }, installation: { id: 12 } };
describe('GitHub label adapter and admission policy', () => {
  const adapter = new GitHubLabelTrigger('test-webhook-secret', [project]);
  it('normalizes a signed label event without leaking webhook details into Core', async () => {
    expect(await adapter.normalize(await webhook(payload))).toEqual(request);
  });
  it('rejects tampered payloads', async () => { await expect(adapter.normalize(await webhook(payload, 'issues', true))).rejects.toThrow('signature'); });
  it('ignores other labels, actions, event types, and PRs', async () => {
    for (const data of [{ ...payload, label: { name: 'unrelated' } }, { ...payload, action: 'unlabeled' }, { ...payload, issue: { number: 3, pull_request: {} } }]) expect(await adapter.normalize(await webhook(data))).toBeNull();
    expect(await adapter.normalize(await webhook(payload, 'pull_request'))).toBeNull();
  });
  it('rejects an installation mismatch and an unauthorized initiating actor', async () => {
    await expect(adapter.normalize(await webhook({ ...payload, installation: { id: 99 } }))).rejects.toThrow('Installation');
    expect(() => selectProject([project], { ...request, actor: 'stranger' })).toThrow('Actor');
    expect(selectProject([project], { ...request, source: 'future.manual-trigger' })).toEqual(project);
  });
});
