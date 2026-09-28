CREATE TABLE `kernel_state_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`state_json` text NOT NULL,
	`log_offset` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_kernel_state_snapshots_created` ON `kernel_state_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `moments` (
	`id` text PRIMARY KEY NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`process_name` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_moments_start` ON `moments` (`start_time`);