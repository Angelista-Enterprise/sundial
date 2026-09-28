CREATE TABLE `owner_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`reason` text,
	`asked_at` text NOT NULL,
	`answer` text,
	`answered_at` text,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_owner_asks_asked` ON `owner_asks` (`asked_at`);