CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`forecaster` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text NOT NULL,
	`prior_prob` real NOT NULL,
	`features` text,
	`outcome` integer NOT NULL,
	`surprise` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_predictions_kind_resolved` ON `predictions` (`kind`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_predictions_resolved` ON `predictions` (`resolved_at`);