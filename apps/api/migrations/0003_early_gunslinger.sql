CREATE TABLE `diagnostic_artifacts` (
	`ingest_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`object_key` text NOT NULL,
	`digest` text NOT NULL,
	`bytes` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`trace_id`) REFERENCES `diagnostic_traces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_artifacts_id_unique` ON `diagnostic_artifacts` (`id`);--> statement-breakpoint
CREATE INDEX `diagnostic_artifact_trace` ON `diagnostic_artifacts` (`trace_id`);--> statement-breakpoint
CREATE INDEX `diagnostic_artifact_expiry` ON `diagnostic_artifacts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `diagnostic_events` (
	`ingest_seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`producer_id` text NOT NULL,
	`producer_seq` integer,
	`request_id` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`name` text NOT NULL,
	`attributes` text NOT NULL,
	`fingerprint` text DEFAULT '' NOT NULL,
	`artifact_id` text,
	FOREIGN KEY (`trace_id`) REFERENCES `diagnostic_traces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_events_event_id_unique` ON `diagnostic_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `diagnostic_trace_cursor` ON `diagnostic_events` (`trace_id`,`ingest_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_producer_sequence` ON `diagnostic_events` (`trace_id`,`producer_id`,`producer_seq`);--> statement-breakpoint
CREATE TABLE `diagnostic_links` (
	`from_trace` text NOT NULL,
	`to_trace` text NOT NULL,
	`relation` text NOT NULL,
	FOREIGN KEY (`from_trace`) REFERENCES `diagnostic_traces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_trace`) REFERENCES `diagnostic_traces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_link` ON `diagnostic_links` (`from_trace`,`to_trace`,`relation`);--> statement-breakpoint
CREATE TABLE `diagnostic_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`session_id` text,
	`run_id` text,
	`source` text NOT NULL,
	`delivery_id` text,
	`request_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`capture_state` text DEFAULT 'unknown' NOT NULL,
	`producer_id` text,
	`last_seq` integer,
	`dropped` integer DEFAULT 0 NOT NULL,
	`body_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_traces_run_id_unique` ON `diagnostic_traces` (`run_id`);--> statement-breakpoint
CREATE INDEX `diagnostic_owner_time` ON `diagnostic_traces` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `diagnostic_delivery` ON `diagnostic_traces` (`source`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `diagnostic_expiry` ON `diagnostic_traces` (`expires_at`);--> statement-breakpoint
-- Old runs get a snapshot, not invented intermediate events or start times.
INSERT INTO diagnostic_traces (id, owner_id, session_id, run_id, source, created_at, expires_at)
  SELECT 'run/' || r.id, s.owner_id, r.session_id, r.id, 'run', r.created_at, r.created_at + 7776000000
  FROM runs r JOIN sessions s ON s.id = r.session_id;
--> statement-breakpoint
INSERT INTO diagnostic_events (event_id, trace_id, span_id, producer_id, occurred_at, received_at, name, attributes)
  SELECT 'snapshot/' || id, 'run/' || id, 'run/' || id, 'database',
    coalesce(finished_at, created_at), cast((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    'run.snapshot', json_object('evidence', 'state_snapshot', 'outcome', status, 'errorCode', error_code) FROM runs;
