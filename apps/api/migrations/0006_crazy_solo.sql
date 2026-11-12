CREATE TABLE `issue_notifications` (
	`run_id` text NOT NULL,
	`kind` text DEFAULT 'issue-comment' NOT NULL,
	`session_id` text NOT NULL,
	`target` text NOT NULL,
	`comment_id` integer,
	`desired_state` text DEFAULT 'processing' NOT NULL,
	`applied_state` text,
	`version` integer DEFAULT 1 NOT NULL,
	`applied_version` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease` text,
	`lease_until` integer,
	`error_category` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_notification_due` ON `issue_notifications` (`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_notification_run_kind` ON `issue_notifications` (`run_id`,`kind`);--> statement-breakpoint
CREATE TRIGGER issue_notification_terminal AFTER UPDATE OF status ON runs
WHEN NEW.status IN ('succeeded', 'failed') AND OLD.status != NEW.status
BEGIN
  UPDATE issue_notifications SET desired_state = NEW.status, version = version + 1,
    next_attempt_at = CASE WHEN error_category = 'permission' THEN NULL
      WHEN error_category = 'rate_limit' THEN next_attempt_at ELSE 0 END
  WHERE run_id = NEW.id;
END;
