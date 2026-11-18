CREATE TABLE `routine_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`routine_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`before_config` text,
	`after_config` text,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`config` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `routine_project` ON `routines` (`project_id`,`deleted_at`,`id`);--> statement-breakpoint
ALTER TABLE `trigger_events` ADD `routine_id` text REFERENCES routines(id);--> statement-breakpoint
ALTER TABLE `trigger_events` ADD `routine_revision` integer;--> statement-breakpoint
ALTER TABLE `trigger_events` ADD `delivery_id` text;
--> statement-breakpoint
CREATE TRIGGER routine_created AFTER INSERT ON routines
BEGIN
  INSERT INTO routine_changes (routine_id, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, NEW.updated_by, NEW.updated_at, NULL, NEW.config);
END;
--> statement-breakpoint
CREATE TRIGGER routine_updated AFTER UPDATE ON routines
BEGIN
  INSERT INTO routine_changes (routine_id, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, NEW.updated_by, NEW.updated_at, OLD.config,
    CASE WHEN NEW.deleted_at IS NOT NULL THEN NULL ELSE NEW.config END);
END;
--> statement-breakpoint
INSERT INTO routines (id, project_id, config, created_at, updated_at, updated_by)
SELECT id, id, json_object('name', 'Issue implementation', 'enabled', json('true'),
  'trigger', json_object('version', 1, 'type', 'github.issue-label', 'label', json_extract(config, '$.triggerLabel')),
  'allowedActors', json_extract(config, '$.allowedActors'), 'engine', 'codex',
  'prompt', 'Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.'),
  created_at, updated_at, updated_by FROM projects
WHERE deleted_at IS NULL AND json_type(config, '$.triggerLabel') = 'text';
--> statement-breakpoint
UPDATE projects SET config = json_remove(config, '$.triggerLabel') WHERE json_type(config, '$.triggerLabel') IS NOT NULL;
