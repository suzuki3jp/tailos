import type {
  Project,
  ProjectSettings,
} from "@/application/triggers/projects.ts";

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
  list(): Promise<ProjectRecord[]>;
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
    before?: number,
  ): Promise<{ changes: ProjectChange[]; nextCursor: number | null }>;
};
export type ProjectRepositories = {
  list(): Promise<RepositoryChoice[]>;
  verify(target: RepositoryChoice): Promise<void>;
};
