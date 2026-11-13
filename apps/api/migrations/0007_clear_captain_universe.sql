CREATE TABLE `planning_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`input_id` integer NOT NULL,
	FOREIGN KEY (`input_id`) REFERENCES `planning_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `planning_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`comment_id` integer NOT NULL,
	`actor` text NOT NULL,
	`url` text NOT NULL,
	`body` text NOT NULL,
	`execution_context` text NOT NULL,
	`timeout_ms` integer NOT NULL,
	`received_at` integer NOT NULL,
	`state` text NOT NULL,
	`run_id` text,
	FOREIGN KEY (`scope`) REFERENCES `planning_issues`(`scope`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_inbox_run_id_unique` ON `planning_inbox` (`run_id`);--> statement-breakpoint
CREATE INDEX `planning_pending` ON `planning_inbox` (`state`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `planning_comment` ON `planning_inbox` (`scope`,`comment_id`);--> statement-breakpoint
CREATE TABLE `planning_issues` (
	`scope` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`started` integer DEFAULT 0 NOT NULL,
	`latest_run_id` text,
	`latest_plan_run_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latest_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latest_plan_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_issues_session_id_unique` ON `planning_issues` (`session_id`);--> statement-breakpoint
CREATE TABLE `planning_replies` (
	`input_id` integer PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`comment_id` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease` text,
	`lease_until` integer,
	`error_category` text,
	FOREIGN KEY (`input_id`) REFERENCES `planning_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `planning_reply_due` ON `planning_replies` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `planning_snapshots` (
	`run_id` text PRIMARY KEY NOT NULL,
	`input_id` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`base_sha` text NOT NULL,
	`conversation` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_id`) REFERENCES `planning_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER planning_terminal AFTER UPDATE OF status ON runs
WHEN NEW.status IN ('succeeded', 'failed') AND OLD.status != NEW.status
BEGIN
  INSERT INTO planning_replies (input_id, body, next_attempt_at)
  SELECT i.id, CASE WHEN NEW.status = 'succeeded' THEN
    (SELECT body FROM session_messages WHERE run_id = NEW.id AND author_kind = 'agent')
    WHEN NEW.error_code = 'planning_input_too_large' THEN '計画入力が Runner の上限を超えました (planning_input_too_large)。本文と会話は保存されています。Session で入力を確認してください。同じ履歴の再送では解消しません。'
    ELSE '計画の更新に失敗しました (' || coalesce(NEW.error_code, 'unknown') || ')。入力は保存されています。新しい @tailos plan コメントで再調査できます。' END, 0
  FROM planning_inbox i WHERE i.run_id = NEW.id;
  UPDATE planning_inbox SET state = 'completed' WHERE run_id = NEW.id;
  UPDATE planning_issues SET latest_run_id = NEW.id,
    latest_plan_run_id = CASE WHEN NEW.status = 'succeeded' AND json_extract(NEW.result, '$.kind') = 'plan'
      AND json_extract(NEW.result, '$.planPresented') = 1 THEN NEW.id ELSE latest_plan_run_id END
  WHERE scope = (SELECT scope FROM planning_inbox WHERE run_id = NEW.id);
END;
