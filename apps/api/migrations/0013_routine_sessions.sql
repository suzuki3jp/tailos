CREATE TABLE `issue_guidance` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`trigger` text NOT NULL,
	`body` text NOT NULL,
	`comment_id` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease` text,
	`lease_until` integer,
	`error_category` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_guidance_due` ON `issue_guidance` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `routine_sessions` (
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`routine_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`issue_number` integer NOT NULL,
	`session_id` text NOT NULL,
	`last_message_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `project_id`, `routine_id`, `repository_id`, `issue_number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_sessions_session_id_unique` ON `routine_sessions` (`session_id`);--> statement-breakpoint
CREATE INDEX `routine_session_issue` ON `routine_sessions` (`project_id`,`repository_id`,`issue_number`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `session_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`delivery_id` text,
	`routine_id` text,
	`routine_revision` integer,
	`author_kind` text NOT NULL,
	`body` text NOT NULL,
	`execution_context` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`received_at` integer NOT NULL,
	`run_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_inbox_run_id_unique` ON `session_inbox` (`run_id`);--> statement-breakpoint
CREATE INDEX `session_inbox_waiting` ON `session_inbox` (`session_id`,`id`) WHERE "session_inbox"."run_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `session_inbox_delivery` ON `session_inbox` (`source`,`idempotency_key`);--> statement-breakpoint
-- Planning replies are now posted by the Agent; the app keeps status comments.
DROP TRIGGER planning_terminal;
--> statement-breakpoint
-- Every Project keeps `@tailos plan` as an enabled plan Routine, with the
-- users who could already start it.
INSERT INTO routines (id, project_id, config, created_at, updated_at, updated_by)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
    || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  id, json_object('name', 'Issue planning', 'enabled', json('true'),
  'trigger', json_object('version', 1, 'type', 'github.issue-comment', 'command', 'plan'),
  'allowedActors', json_extract(config, '$.allowedActors'), 'engine', 'codex',
  'prompt', 'Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get. Do not implement or publish changes. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.'),
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER),
  'migration:plan-routines' FROM projects
WHERE deleted_at IS NULL AND json_type(config, '$.allowedActors') = 'array'
  AND json_array_length(config, '$.allowedActors') > 0;
--> statement-breakpoint
-- A planning conversation that started continues in the same Session.
INSERT INTO routine_sessions (owner_id, project_id, routine_id, repository_id, issue_number, session_id, last_message_at)
SELECT json_extract(p.scope, '$[0]'), json_extract(p.scope, '$[1]'), r.id,
  json_extract(p.scope, '$[2]'), json_extract(p.scope, '$[3]'), p.session_id,
  coalesce((SELECT max(received_at) FROM planning_inbox WHERE scope = p.scope), 0)
FROM planning_issues p JOIN routines r ON r.project_id = json_extract(p.scope, '$[1]')
  AND r.updated_by = 'migration:plan-routines'
WHERE p.started = 1;
--> statement-breakpoint
-- Structural migration preserves the existing human-authored Project history.
DROP TRIGGER project_updated;
--> statement-breakpoint
UPDATE projects SET config = json_remove(config, '$.allowedActors') WHERE json_type(config, '$.allowedActors') IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER project_updated AFTER UPDATE ON projects
WHEN NEW.revision != OLD.revision OR NEW.config != OLD.config OR NEW.name != OLD.name
  OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO project_changes (project_id, operation, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'update' END, NEW.updated_by, NEW.updated_at,
    json_set(OLD.config, '$.name', OLD.name),
    CASE WHEN NEW.deleted_at IS NOT NULL THEN NULL ELSE json_set(NEW.config, '$.name', NEW.name) END);
END;
