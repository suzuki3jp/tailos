DROP INDEX `run_next_action`;--> statement-breakpoint
CREATE INDEX `run_next_action` ON `runs` (`next_action_at`,`id`) WHERE "runs"."status" in ('queued', 'running');