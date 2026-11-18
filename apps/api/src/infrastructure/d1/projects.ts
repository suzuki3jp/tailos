import {
  implementationPrompt,
  routineSettings,
} from "@/application/routines/routines.ts";
import type { D1Database } from "@cloudflare/workers-types";
import * as v from "valibot";
import {
  projectSchema,
  projectSettings,
  projectsSchema,
  type Project,
} from "@/application/triggers/projects.ts";
import {
  ProjectConflict,
  projectSummary,
  type ProjectRecord,
  type ProjectStore,
  type ProjectChange,
  type ProjectSummary,
  type ProjectSnapshot,
} from "@/application/projects/store.ts";

type Row = {
  owner_id: string;
  id: string;
  repository_id: number;
  config: string;
  name: string;
  revision: number;
  updated_at: number;
};
function readProject(value: string, name?: string): Project {
  const {
    name: storedName,
    triggerLabel: _legacyLabel,
    ...config
  } = v.parse(
    v.looseObject({
      name: v.optional(v.string()),
      triggerLabel: v.optional(v.string()),
    }),
    JSON.parse(value),
  );
  return v.parse(projectSchema, {
    ...config,
    name: name || storedName || config.repository,
  });
}
function readSnapshot(value: string): ProjectSnapshot {
  const legacy = v.parse(
    v.object({ triggerLabel: v.optional(v.string()) }),
    JSON.parse(value),
  );
  return {
    ...readProject(value),
    ...(legacy.triggerLabel === undefined
      ? {}
      : { triggerLabel: legacy.triggerLabel }),
  };
}
function record(row: Row): ProjectRecord {
  const project = readProject(row.config, row.name);
  if (project.id !== row.id || project.repositoryId !== row.repository_id)
    throw new Error("Invalid stored project");
  return {
    project,
    ownerId: row.owner_id,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
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
      .prepare(`INSERT INTO projects (id, name, owner_id, repository_id, config, legacy_id, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        project.id,
        project.name,
        actorId,
        project.repositoryId,
        JSON.stringify(configuration(project)),
        legacyId,
        now,
        now,
        actorId,
      );
  function configuration(project: ProjectSnapshot) {
    const { name: _name, triggerLabel: _legacyLabel, ...config } = project;
    return config;
  }
  return {
    async settings(ownerId) {
      const { results } = await db
        .prepare(
          "SELECT * FROM projects WHERE owner_id = ? AND deleted_at IS NULL ORDER BY name COLLATE BINARY, id",
        )
        .bind(ownerId)
        .all<Row>();
      return results.map(record);
    },
    async page(ownerId, limit, after) {
      const { results } = await db
        .prepare(`SELECT id, name, json_extract(config, '$.repository') AS repository FROM projects
        WHERE owner_id = ? AND deleted_at IS NULL AND (? IS NULL OR (name COLLATE BINARY, id) > (?, ?))
        ORDER BY name COLLATE BINARY, id LIMIT ?`)
        .bind(
          ownerId,
          after?.name ?? null,
          after?.name ?? null,
          after?.id ?? null,
          limit + 1,
        )
        .all<ProjectSummary>();
      const items = v.parse(v.array(projectSummary), results.slice(0, limit));
      const last = items.at(-1);
      return {
        items,
        nextPosition:
          results.length > limit && last
            ? { name: last.name, id: last.id }
            : null,
      };
    },
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
      const project = {
        ...v.parse(projectSettings, settings),
        id: crypto.randomUUID(),
      };
      const now = Date.now();
      try {
        await insert(project, actorId, now).run();
      } catch (error) {
        mutationError(error);
      }
      return { project, ownerId: actorId, revision: 1, updatedAt: now };
    },
    async update(id, revision, settings, actorId) {
      const project = { ...v.parse(projectSettings, settings), id };
      const now = Date.now();
      try {
        const result = await db
          .prepare(`UPDATE projects SET name = ?, repository_id = ?, config = ?, revision = revision + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND revision = ? AND owner_id = ? AND deleted_at IS NULL RETURNING id`)
          .bind(
            project.name,
            project.repositoryId,
            JSON.stringify(configuration(project)),
            now,
            actorId,
            id,
            revision,
            actorId,
          )
          .first<string>("id");
        return result !== null
          ? {
              project,
              ownerId: actorId,
              revision: revision + 1,
              updatedAt: now,
            }
          : null;
      } catch (error) {
        mutationError(error);
      }
    },
    async remove(id, revision, actorId) {
      const result = await db
        .prepare(`UPDATE projects SET deleted_at = ?, updated_at = ?, updated_by = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND owner_id = ? AND deleted_at IS NULL RETURNING id`)
        .bind(Date.now(), Date.now(), actorId, id, revision, actorId)
        .first<string>("id");
      return result !== null;
    },
    async import(projects, legacyIds, actorId) {
      v.parse(
        projectsSchema,
        projects.map((project) => {
          const { triggerLabel: _label, ...settings } = project;
          return settings;
        }),
      );
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
        db.prepare("PRAGMA defer_foreign_keys = ON"),
      ];
      for (const [index, project] of projects.entries()) {
        statements.push(
          db
            .prepare(`INSERT INTO projects (id, name, owner_id, repository_id, config, legacy_id, created_at, updated_at, updated_by)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
            .bind(
              project.id,
              project.name,
              actorId,
              project.repositoryId,
              JSON.stringify(configuration(project)),
              legacyIds[index],
              now,
              now,
              actorId,
              changeId,
            ),
        );
        const legacyLabel = project.triggerLabel;
        if (legacyLabel) {
          const settings = v.parse(routineSettings, {
            name: "Issue implementation",
            enabled: true,
            trigger: {
              version: 1,
              type: "github.issue-label",
              label: legacyLabel,
            },
            allowedActors: project.allowedActors,
            prompt: implementationPrompt,
            engine: "codex",
          });
          statements.push(
            db
              .prepare(`INSERT INTO routines (id, project_id, config, created_at, updated_at, updated_by)
            SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
              .bind(
                project.id,
                project.id,
                JSON.stringify(settings),
                now,
                now,
                actorId,
                changeId,
              ),
          );
        }
        statements.push(
          db
            .prepare(`UPDATE sessions SET project_id = ? WHERE project_id = ?
          AND EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
            .bind(project.id, legacyIds[index], changeId),
        );
        // Planning scope is a JSON tuple containing the Project ID. Defer
        // its inbox foreign key only within this atomic migration transaction.
        for (const table of ["planning_inbox", "planning_issues"]) {
          statements.push(
            db
              .prepare(`UPDATE ${table} SET scope = json_set(scope, '$[1]', ?)
            WHERE json_extract(scope, '$[1]') = ?
            AND EXISTS (SELECT 1 FROM project_imports WHERE change_id = ?)`)
              .bind(project.id, legacyIds[index], changeId),
          );
        }
      }
      try {
        const results = await db.batch(statements);
        if (results[0].meta.changes !== 1)
          throw new ProjectConflict("Projects have already been configured");
      } catch (error) {
        mutationError(error);
      }
    },
    async history(ownerId, before) {
      const { results } = await db
        .prepare(
          `SELECT c.* FROM project_changes c JOIN projects p ON p.id = c.project_id WHERE p.owner_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT 51`,
        )
        .bind(ownerId, before ?? Number.MAX_SAFE_INTEGER)
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
        before: r.before_config === null ? null : readSnapshot(r.before_config),
        after: r.after_config === null ? null : readSnapshot(r.after_config),
      }));
      return {
        changes,
        nextCursor: results.length > 50 ? (changes.at(-1)?.id ?? null) : null,
      };
    },
  };
}
