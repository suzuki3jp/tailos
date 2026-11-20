export function sessionPath(id: string, projectId?: string | null) {
  const path = `/sessions/${encodeURIComponent(id)}`;
  return projectId ? `/${encodeURIComponent(projectId)}${path}` : path;
}
