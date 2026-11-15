CREATE TABLE `project_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`before_config` text,
	`after_config` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`change_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` integer NOT NULL,
	`config` text NOT NULL,
	`legacy_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_legacy_id_unique` ON `projects` (`legacy_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_active_repository` ON `projects` (`repository_id`) WHERE "projects"."deleted_at" is null;
--> statement-breakpoint
CREATE TRIGGER project_limit BEFORE INSERT ON projects
WHEN NEW.deleted_at IS NULL AND (SELECT count(*) FROM projects WHERE deleted_at IS NULL) >= 100
BEGIN SELECT RAISE(ABORT, 'project_limit'); END;
--> statement-breakpoint
CREATE TRIGGER project_created AFTER INSERT ON projects
BEGIN
  INSERT INTO project_changes (project_id, operation, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, CASE WHEN NEW.legacy_id IS NULL THEN 'create' ELSE 'import' END, NEW.updated_by, NEW.updated_at, NULL, NEW.config);
END;
--> statement-breakpoint
CREATE TRIGGER project_updated AFTER UPDATE ON projects
BEGIN
  INSERT INTO project_changes (project_id, operation, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'update' END, NEW.updated_by, NEW.updated_at, OLD.config,
    CASE WHEN NEW.deleted_at IS NOT NULL THEN NULL ELSE NEW.config END);
END;
