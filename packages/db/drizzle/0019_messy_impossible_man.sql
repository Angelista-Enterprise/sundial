CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`branch` text NOT NULL,
	`project_id` text,
	`project_name` text,
	`opened_at` text NOT NULL,
	`last_touched_at` text NOT NULL,
	`touches` integer DEFAULT 0 NOT NULL,
	`active_days` integer DEFAULT 1 NOT NULL,
	`closed_at` text,
	`closed_because` text
);
--> statement-breakpoint
CREATE INDEX `idx_commitments_open` ON `commitments` (`closed_at`,`last_touched_at`);--> statement-breakpoint
CREATE INDEX `idx_commitments_project` ON `commitments` (`project_id`);