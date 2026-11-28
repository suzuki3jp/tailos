export function routinesPath(projectId: string) {
  return `/${encodeURIComponent(projectId)}/routines`;
}

export function routinePath(projectId: string, routineId: string) {
  return `${routinesPath(projectId)}/${encodeURIComponent(routineId)}`;
}
