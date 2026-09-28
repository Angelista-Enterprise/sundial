CREATE TABLE `signals` (
	`id` text PRIMARY KEY NOT NULL,
	`signal_type` text NOT NULL,
	`event_type` text NOT NULL,
	`session_id` text,
	`data` text NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_signals_type` ON `signals` (`signal_type`);--> statement-breakpoint
CREATE INDEX `idx_signals_captured` ON `signals` (`captured_at`);--> statement-breakpoint
CREATE INDEX `idx_signals_session` ON `signals` (`session_id`);