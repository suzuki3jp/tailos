CREATE INDEX `run_session_created` ON `runs` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `session_owner_created` ON `sessions` (`owner_id`,`created_at`,`id`);
