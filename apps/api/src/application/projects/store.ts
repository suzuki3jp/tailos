import * as v from "valibot";
import { projectSchema } from "@/application/triggers/projects.ts";
import type {
  Project,
  ProjectSettings,
} from "@/application/triggers/projects.ts";

export type ProjectPosition = { name: string; id: string };
export const projectSummary = v.strictObject({
  id: projectSchema.entries.id,
  name: projectSchema.entries.name,
  repository: projectSchema.entries.repository,
});
export type ProjectSummary = v.InferOutput<typeof projectSummary>;
export type ProjectRecord = {
  project: Project;
  revision: number;
  updatedAt: number;
};
export type RepositoryChoice = Pick<
  Project,
  "repository" | "repositoryId" | "installationId"
>;
export type ProjectChange = {
  id: number;
  projectId: string;
  operation: "create" | "update" | "delete" | "import";
  actorId: string;
  createdAt: number;
  before: Project | null;
  after: Project | null;
};
export class ProjectConflict extends Error {}
export type ProjectStore = {
  // Internal Webhook configuration read; HTTP access must use owned methods.
  list(): Promise<ProjectRecord[]>;
  settings(ownerId: string): Promise<ProjectRecord[]>;
  page(
    ownerId: string,
    limit: number,
    after?: ProjectPosition,
  ): Promise<{ items: ProjectSummary[]; nextPosition: ProjectPosition | null }>;
  create(settings: ProjectSettings, actorId: string): Promise<ProjectRecord>;
  update(
    id: string,
    revision: number,
    settings: ProjectSettings,
    actorId: string,
  ): Promise<ProjectRecord | null>;
  remove(id: string, revision: number, actorId: string): Promise<boolean>;
  import(
    projects: Project[],
    legacyIds: string[],
    actorId: string,
  ): Promise<void>;
  history(
    ownerId: string,
    before?: number,
  ): Promise<{ changes: ProjectChange[]; nextCursor: number | null }>;
};
export type ProjectRepositories = {
  list(): Promise<RepositoryChoice[]>;
  verify(target: RepositoryChoice): Promise<void>;
};
