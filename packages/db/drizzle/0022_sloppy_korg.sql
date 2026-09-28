CREATE TABLE `gate_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`notice_key` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`reason` text NOT NULL,
	`weight` real NOT NULL,
	`utility` real NOT NULL,
	`surprise` real NOT NULL,
	`precision` real NOT NULL,
	`habituation` real NOT NULL,
	`concern` real NOT NULL,
	`interruption_cost` real NOT NULL,
	`decided_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_gate_decisions_decided` ON `gate_decisions` (`decided_at`);--> statement-breakpoint
CREATE INDEX `idx_gate_decisions_key` ON `gate_decisions` (`notice_key`);