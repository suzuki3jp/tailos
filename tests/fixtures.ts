import type { AccessGrant, ExecutionRequest, Project, Run } from '../src/contracts/index';
export const project: Project = { id: 'sample', repository: 'owner/repo', installationId: 12, triggerLabel: 'meguri:run', allowedActors: ['owner'], engine: 'codex', connectionId: 'default', maxRunMinutes: 30, setupCommands: [], testCommands: [] };
export const request: ExecutionRequest = { source: 'github.issue-label', deliveryId: 'delivery-1', repository: 'owner/repo', issueNumber: 3, actor: 'owner' };
export const access: AccessGrant = { accountId: 'account', accessToken: 'fake-short-lived-access', expiresAt: Date.now() + 3_600_000, connectionVersion: 'version' };
export const issue = { title: 'Implement feature', body: 'Details', url: 'https://github.com/owner/repo/issues/3', baseBranch: 'main', baseSha: 'a'.repeat(40), baseTree: 'b'.repeat(40) };
export const makeRun = (): Run => ({ id: 'a'.repeat(32), project, request, phase: 'queued', createdAt: Date.now(), deadline: Date.now() + 1_800_000, lastSeq: 0, recentEvents: [] });
