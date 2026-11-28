import type { D1Database } from "@cloudflare/workers-types";
import type { ExecutionContext } from "@tailos/core/runner";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { RoutineSettings } from "../../application/routines/routines.ts";
import type { Project } from "../../application/triggers/projects.ts";
import {
  authAccounts,
  projects,
  routines,
  runs,
  sessionMessages,
  sessions,
  users,
} from "./schema.ts";

export const seedGithubId = "9007199254740991";
const ownerId = "c67e6625-eb4a-4aeb-806f-4ed1e05650bb";
const email = "seed-operator@example.test";

const sampleProject = {
  id: "54441f02-f21a-4461-a6dd-dc2fc14c91d7",
  name: "Sample project",
  repository: "tailos-fixtures/sample",
  repositoryId: 9007199254740990,
  installationId: 9007199254740991,
  maxRunMinutes: 30,
} satisfies Project;

const emptyProject = {
  ...sampleProject,
  id: "c2f142f5-d8f2-4766-9c76-4fcb2f6e3ab7",
  name: "Empty project",
  repository: "tailos-fixtures/empty",
  repositoryId: 9007199254740989,
} satisfies Project;

const routineConfig = {
  name: "Review a sample issue",
  enabled: false,
  trigger: { version: 1, type: "github.issue-label", label: "seed-review" },
  allowedActors: ["seed-operator"],
  prompt: "Review the sample issue and summarize the next steps.",
  engine: "codex",
} satisfies RoutineSettings;

const executionContext = JSON.stringify({
  version: 1,
  engine: "fake",
} satisfies ExecutionContext);

const conversations = [
  {
    id: "0cbeeff2-5375-4bab-9b37-ac309d264de8",
    runId: "05d5e1a6-d113-4b4b-9fa2-fa33d38485a2",
    messageId: "601a8dda-1294-46bf-9224-efc20ecca196",
    title: "Release checklist",
    prompt: "What should we check before publishing the next release?",
    status: "succeeded",
  },
  {
    id: "c9a4799a-9b8e-40e0-ac91-f2cc9c8ee72b",
    runId: "b1b9f910-591c-448e-a830-c8aeb6592d1b",
    messageId: "6329acda-e4b5-48d3-89d1-a57320e7c690",
    title: "Investigate a failed build",
    prompt: "Can you find out why the sample build failed?",
    status: "failed",
  },
] as const;

export async function seedLocalDatabase(database: D1Database) {
  const db = drizzle(database);
  const [operator] = await db
    .select({ id: users.id, email: users.email })
    .from(authAccounts)
    .innerJoin(users, eq(users.id, authAccounts.userId))
    .where(
      and(
        eq(authAccounts.providerId, "github"),
        eq(authAccounts.accountId, seedGithubId),
      ),
    );
  if (operator) {
    if (operator.id !== ownerId || operator.email !== email)
      throw new Error(
        "The seed operator ID is already assigned to another user.",
      );
    // The account and all its sample data are created in a single D1 batch.
    return ownerId;
  }

  const now = Date.now();
  const createdAt = new Date(now);
  const completed = conversations[0];
  await db.batch([
    db.insert(users).values({
      id: ownerId,
      name: "Seed Operator",
      email,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    }),
    db.insert(authAccounts).values({
      id: "68cd8d8b-573c-4583-8f0a-358402fb95f7",
      providerId: "github",
      accountId: seedGithubId,
      userId: ownerId,
      createdAt,
      updatedAt: createdAt,
    }),
    db.insert(projects).values(
      [sampleProject, emptyProject].map(({ name, ...config }) => ({
        id: config.id,
        name,
        ownerId,
        repositoryId: config.repositoryId,
        config: JSON.stringify(config),
        createdAt: now,
        updatedAt: now,
        updatedBy: ownerId,
      })),
    ),
    db.insert(routines).values({
      id: "978fb167-ce30-4e51-b893-db0daaec45e9",
      projectId: sampleProject.id,
      config: JSON.stringify(routineConfig),
      createdAt: now,
      updatedAt: now,
      updatedBy: ownerId,
    }),
    db.insert(sessions).values(
      conversations.map(({ id, title }) => ({
        id,
        title,
        titleGenerated: true,
        ownerId,
        projectId: sampleProject.id,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    db.insert(sessionMessages).values(
      conversations.map(({ id, messageId, prompt }) => ({
        id: messageId,
        sessionId: id,
        seq: 1,
        authorKind: "user" as const,
        body: prompt,
        createdAt: now,
      })),
    ),
    db.insert(runs).values(
      conversations.map(({ id, runId, messageId, status }) => ({
        id: runId,
        sessionId: id,
        startMessageId: messageId,
        status,
        executionContext,
        errorCode: status === "failed" ? "agent_failed" : null,
        deadlineAt: now + 60_000,
        createdAt: now,
        finishedAt: now,
      })),
    ),
    db.insert(sessionMessages).values({
      id: "61f3ef9b-1729-44c3-9e23-0b1e4d1543bb",
      sessionId: completed.id,
      runId: completed.runId,
      seq: 2,
      authorKind: "agent",
      body: "## Release checklist\n\n1. Run the test suite.\n2. Review the changelog.\n3. Verify the package in a clean environment.",
      createdAt: now,
    }),
  ]);
  return ownerId;
}
