ALTER TABLE `moments` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `idx_moments_project` ON `moments` (`project_id`);