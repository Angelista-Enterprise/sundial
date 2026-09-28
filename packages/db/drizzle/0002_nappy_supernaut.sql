CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`organization_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_projects_root_path` ON `projects` (`root_path`);