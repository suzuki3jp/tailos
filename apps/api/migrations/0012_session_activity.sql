CREATE TABLE `session_activity_events` (
	`cursor` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`item_id` text,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_events_event_id_unique` ON `session_activity_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `session_activity_event_page` ON `session_activity_events` (`session_id`,`cursor`);--> statement-breakpoint
CREATE TABLE `session_activity_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`text` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`exit_code` integer,
	`revision` integer NOT NULL,
	`first_cursor` integer NOT NULL,
	`input_artifact` text,
	`input_event` text,
	`output_artifact` text,
	`output_event` text,
	`body_expires_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_activity_item_page` ON `session_activity_items` (`session_id`,`first_cursor`);--> statement-breakpoint
CREATE TABLE `session_activity_notifications` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`delivered_version` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Only already-recorded diagnostic facts are imported. No commentary phase,
-- output content, or missing start time is inferred from a successful Run.
INSERT INTO session_activity_events (event_id, session_id, run_id, item_id, kind, expires_at)
SELECT e.event_id, t.session_id, t.run_id, t.run_id || '/' || e.span_id, 'item', t.expires_at
FROM diagnostic_events e JOIN diagnostic_traces t ON t.id = e.trace_id
WHERE t.session_id IS NOT NULL AND t.run_id IS NOT NULL
  AND t.expires_at > unixepoch() * 1000
  AND e.name IN ('span.started', 'span.finished')
  AND json_extract(e.attributes, '$.operation') IN ('command', 'tool', 'file_change', 'checkout', 'agent', 'publication', 'commit', 'pull_request', 'cleanup')
ORDER BY e.ingest_seq;
--> statement-breakpoint
INSERT INTO session_activity_items
  (id, session_id, run_id, kind, label, status, started_at, finished_at, duration_ms, exit_code, revision, first_cursor,
   input_artifact, input_event, output_artifact, output_event, body_expires_at, expires_at)
SELECT a.item_id, a.session_id, a.run_id,
  CASE json_extract(e.attributes, '$.operation') WHEN 'command' THEN 'command' WHEN 'tool' THEN 'tool' WHEN 'file_change' THEN 'file' ELSE 'stage' END,
  CASE WHEN json_extract(e.attributes, '$.operation') IN ('command', 'tool', 'file_change') THEN NULL ELSE json_extract(e.attributes, '$.operation') END,
  CASE WHEN max(e.name = 'span.finished') = 0 THEN 'running'
       WHEN max(e.name = 'span.finished' AND json_extract(e.attributes, '$.outcome') = 'failed') = 1 THEN 'failed'
       WHEN max(e.name = 'span.finished' AND json_extract(e.attributes, '$.outcome') = 'succeeded') = 1 THEN 'succeeded' ELSE 'unknown' END,
  min(e.occurred_at), max(CASE WHEN e.name = 'span.finished' THEN e.occurred_at END),
  max(json_extract(e.attributes, '$.durationMs')), max(json_extract(e.attributes, '$.exitCode')), coalesce(max(e.producer_seq), 0), min(a.cursor),
  max(CASE WHEN e.name = 'span.started' THEN e.artifact_id END), max(CASE WHEN e.name = 'span.started' AND e.artifact_id IS NOT NULL THEN e.event_id END),
  max(CASE WHEN e.name = 'span.finished' THEN e.artifact_id END), max(CASE WHEN e.name = 'span.finished' AND e.artifact_id IS NOT NULL THEN e.event_id END),
  coalesce(min(d.expires_at), min(e.received_at) + 2592000000), max(a.expires_at)
FROM session_activity_events a JOIN diagnostic_events e ON e.event_id = a.event_id
LEFT JOIN diagnostic_artifacts d ON d.id = e.artifact_id
GROUP BY a.item_id;
