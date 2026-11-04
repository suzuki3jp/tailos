import { z } from 'zod';
import type { TriggerAdapter } from '../../core/ports';
import type { ExecutionRequest, Project } from '../../contracts/index';
import { readLimitedText } from '../../security';

const payloadSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
  label: z.object({ name: z.string() }),
  sender: z.object({ login: z.string() }),
  installation: z.object({ id: z.number().int().positive() }),
});
export class GitHubLabelTrigger implements TriggerAdapter<Request> {
  constructor(private readonly secret: string, private readonly projects: Project[]) {}
  async normalize(request: Request): Promise<ExecutionRequest | null> {
    const body = await readLimitedText(request, 1_000_000);
    const signature = request.headers.get('x-hub-signature-256') ?? '';
    if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid webhook signature');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, h => parseInt(h, 16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(body))) throw new Error('Invalid webhook signature');
    if (request.headers.get('x-github-event') !== 'issues') return null;
    const raw = JSON.parse(body);
    if (raw.action !== 'labeled') return null;
    const data = payloadSchema.parse(raw);
    if (data.issue.pull_request) return null;
    const project = this.projects.find(p => p.repository.toLowerCase() === data.repository.full_name.toLowerCase());
    if (!project || project.triggerLabel !== data.label.name) return null;
    if (project.installationId !== data.installation.id) throw new Error('Installation does not match the project');
    const deliveryId = request.headers.get('x-github-delivery');
    if (!deliveryId || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId)) throw new Error('Missing webhook delivery ID');
    return { source: 'github.issue-label', deliveryId, repository: data.repository.full_name,
      issueNumber: data.issue.number, actor: data.sender.login };
  }
}
