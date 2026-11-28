import { routinesQueryOptions } from "@/entities/routine";

/**
 * The Project's Routines as the Routine pages read them. The server prefetches
 * them, so mounting does not read them again. Settings keeps refetching on
 * mount, as it edits them.
 */
export function pageRoutinesQueryOptions(projectId: string) {
  return {
    ...routinesQueryOptions(projectId),
    refetchOnMount: false,
    retryOnMount: false,
  } as const;
}
