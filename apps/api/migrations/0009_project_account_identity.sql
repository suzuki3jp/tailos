ALTER TABLE `projects` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `project_owner_name` ON `projects` (`owner_id`,`name`,`id`) WHERE "projects"."deleted_at" is null;
--> statement-breakpoint
DROP TRIGGER project_updated;
--> statement-breakpoint
UPDATE projects SET name = json_extract(config, '$.repository');
--> statement-breakpoint
DROP TRIGGER project_created;
--> statement-breakpoint
CREATE TRIGGER project_created AFTER INSERT ON projects
BEGIN
  INSERT INTO project_changes (project_id, operation, actor_id, created_at, before_config, after_config)
  VALUES (NEW.id, CASE WHEN NEW.legacy_id IS NULL THEN 'create' ELSE 'import' END, NEW.updated_by, NEW.updated_at,
    NULL, json_set(NEW.config, '$.name', NEW.name));
END;
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
