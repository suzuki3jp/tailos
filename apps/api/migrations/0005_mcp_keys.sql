CREATE TABLE `mcp_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_keys_sha256_unique` ON `mcp_keys` (`sha256`);--> statement-breakpoint
CREATE INDEX `mcp_key_owner` ON `mcp_keys` (`owner_id`,`created_at`);
