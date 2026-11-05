CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`start_message_id` text NOT NULL,
	`status` text NOT NULL,
	`concurrency_key` text,
	`execution_context` text NOT NULL,
	`step_state` text,
	`result` text,
	`error_code` text,
	`deadline_at` integer NOT NULL,
	`next_action_at` integer,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`start_message_id`) REFERENCES `session_messages`(`session_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_status" CHECK("runs"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_start_message_id_unique` ON `runs` (`start_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_run_per_session` ON `runs` (`session_id`) WHERE "runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_run_per_target` ON `runs` (`concurrency_key`) WHERE "runs"."status" in ('queued', 'running') and "runs"."concurrency_key" is not null;--> statement-breakpoint
CREATE INDEX `run_next_action` ON `runs` (`next_action_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_session_id` ON `runs` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `session_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author_kind` text NOT NULL,
	`body` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`,`run_id`) REFERENCES `runs`(`session_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_author" CHECK("session_messages"."author_kind" in ('user', 'automation', 'agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_session_sequence` ON `session_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_session_id` ON `session_messages` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`project_id` text,
	`target` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trigger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`disposition` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_disposition" CHECK("trigger_events"."disposition" in ('started', 'coalesced'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_start_event_per_run` ON `trigger_events` (`run_id`) WHERE "trigger_events"."disposition" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX `unique_trigger_delivery` ON `trigger_events` (`source`,`idempotency_key`);