CREATE TABLE `applied_effects` (
	`event_id` text NOT NULL,
	`effect_index` integer NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`event_id`, `effect_index`)
);
