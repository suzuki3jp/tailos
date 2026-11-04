import { z } from 'zod';
import type { Project } from './contracts/index';

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  triggerLabel: z.string().min(1).max(100).default('meguri:run'),
  allowedActors: z.array(z.string().regex(/^[A-Za-z0-9-]+$/)).min(1),
  engine: z.literal('codex').default('codex'),
  connectionId: z.literal('default').default('default'),
  model: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  maxRunMinutes: z.number().int().min(1).max(60).default(30),
  setupCommands: z.array(z.string().min(1).max(2000)).max(20).default([]),
  testCommands: z.array(z.string().min(1).max(2000)).max(20).default([]),
});
export function parseProjects(raw: string): Project[] {
  const projects = z.array(projectSchema).max(50).parse(JSON.parse(raw));
  if (new Set(projects.map(p => p.id)).size !== projects.length ||
      new Set(projects.map(p => p.repository.toLowerCase())).size !== projects.length) {
    throw new Error('Project IDs and repositories must be unique');
  }
  return projects;
}
