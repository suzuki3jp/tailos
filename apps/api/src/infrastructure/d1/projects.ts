import type { D1Database } from "@cloudflare/workers-types";
import * as v from "valibot";
import {
  projectSchema,
  projectsSchema,
  type Project,
} from "@/application/triggers/projects.ts";
import {
  ProjectConflict,
  type ProjectRecord,
  type ProjectStore,
  type ProjectChange,
} from "@/application/projects/store.ts";

type Row = {
  id: string;
  repository_id: number;
  config: string;
  revision: number;
  updated_at: number;
};
function record(row: Row): ProjectRecord {
  const project = v.parse(projectSchema, JSON.parse(row.config));
  if (project.id !== row.id || project.repositoryId !== row.repository_id)
    throw new Error("Invalid stored project");
  return { project, revision: row.revision, updatedAt: row.updated_at };
}
function mutationError(error: unknown): never {
  if (
    error instanceof Error &&
    /project_limit|projects.repository_id|project_active_repository|project_imports.id/.test(
      error.message,
    )
  )
    throw new ProjectConflict(
      "Project limit, repository conflict, or import already completed",
    );
  throw error;
}

export function d1Projects(db: D1Database): ProjectStore {
  const insert = (
    project: Project,
    actorId: string,
    now: number,
    legacyId: string | null = null,
  ) =>
    db
      .prepare(`INSERT INTO projects (id, repository_id, config, legacy_id, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        project.id,
        project.repositoryId,
        JSON.stringify(project),
        legacyId,
        now,
        now,
        actorId,
      );
  return {
    async list() {
      const { results } = await db
        .prepare(
          "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at, id",
        )
        .all<Row>();
      const records = results.map(record);
      v.parse(
        projectsSchema,
        records.map((r) => r.project),
      );
      return records;
    },
    async create(settings, actorId) {
      const project = v.parse(projectSchema, {
        ...settings,
        id: crypto.randomUUID(),
      });
      const now = Date.now();
      try {
        await insert(project, actorId, now).run();
      } catch (error) {
        mutationError(error);
      }
      return { project, revision: 1, updatedAt: now };
    },
    async update(id, revision, settings, actorId) {
      const project = v.parse(projectSchema, { ...settings, id });
      const now = Date.now();
      try {
        const result = await db
          .prepare(`UPDATE projects SET repository_id = ?, config = ?, revision = revision + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING id`)
          .bind(
            project.repositoryId,
            JSON.stringify(project),
            now,
            actorId,
            id,
            revision,
          )
          .first<string>("id");
        return result !== null
          ? { project, revision: revision + 1, updatedAt: now }
          : null;
      } catch (error) {
        mutationError(error);
      }
    },
    async remove(id, revision, actorId) {
      const result = await db
        .prepare(`UPDATE projects SET deleted_at = ?, updated_at = ?, updated_by = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING id`)
        .bind(Date.now(), Date.now(), actorId, id, revision)
        .first<string>("id");
      return result !== null;
    },
    async import(projects, legacyIds, actorId) {
      v.parse(projectsSchema, projects);
      if (legacyIds.length !== projects.length)
        throw new Error("Invalid project mapping");
      const now = Date.now();
      const changeId = crypto.randomUUID();
      // The marker also records an empty import and prevents replay. A batch is
      // a D1 transaction: any validation/unique/audit failure rolls back all rows.
      const statements = [
        db
          .prepare(`INSERT INTO project_imports (id, change_id, actor_id, created_at)
        SELECT 'initial', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM projects)`)
          .bind(changeId, actorId, now),
      ];
      for (const [index, project] of projects.entries()) {
        statements.push(
          db
            .prepare(`INSERT INTO projects (id, repository_id, config, legacy_id, created_at, updated_at, updated_by)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
            .bind(
              project.id,
              project.repositoryId,
              JSON.stringify(project),
              legacyIds[index],
              now,
              now,
              actorId,
              changeId,
            ),
        );
        statements.push(
          db
            .prepare(`UPDATE sessions SET project_id = ? WHERE project_id = ?
          AND EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
            .bind(project.id, legacyIds[index], changeId),
        );
      }
      try {
        const results = await db.batch(statements);
        if (results[0].meta.changes !== 1)
          throw new ProjectConflict("Projects have already been configured");
      } catch (error) {
        mutationError(error);
      }
    },
    async history(before) {
      const { results } = await db
        .prepare(
          `SELECT * FROM project_changes WHERE id < ? ORDER BY id DESC LIMIT 51`,
        )
        .bind(before ?? Number.MAX_SAFE_INTEGER)
        .all<{
          id: number;
          project_id: string;
          operation: ProjectChange["operation"];
          actor_id: string;
          created_at: number;
          before_config: string | null;
          after_config: string | null;
        }>();
      const changes = results.slice(0, 50).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        operation: r.operation,
        actorId: r.actor_id,
        createdAt: r.created_at,
        before:
          r.before_config === null
            ? null
            : v.parse(projectSchema, JSON.parse(r.before_config)),
        after:
          r.after_config === null
            ? null
            : v.parse(projectSchema, JSON.parse(r.after_config)),
      }));
      return {
        changes,
        nextCursor: results.length > 50 ? (changes.at(-1)?.id ?? null) : null,
      };
    },
  };
}
