import type { ExecutionRequest, Project } from '../contracts/index';

export function selectProject(projects: Project[], request: ExecutionRequest): Project | null {
  const project = projects.find(p => p.repository.toLowerCase() === request.repository.toLowerCase());
  if (!project) return null;
  if (!project.allowedActors.some(a => a.toLowerCase() === request.actor.toLowerCase())) throw new Error('Actor is not allowed to start runs');
  return project;
}
export const issueKey = (request: ExecutionRequest) => `${request.repository.toLowerCase()}#${request.issueNumber}`;
