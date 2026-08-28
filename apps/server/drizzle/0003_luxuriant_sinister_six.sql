CREATE TABLE `review_measurements` (
	`task_id` text PRIMARY KEY NOT NULL,
	`ui_version` text NOT NULL,
	`review_started_at` text,
	`active_review_ms` integer,
	`opened_transcript` integer NOT NULL,
	`opened_full_diff` integer NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_delivery_reports` (
	`task_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`report_head_commit` text NOT NULL,
	`problem_understanding` text NOT NULL,
	`solution_summary` text NOT NULL,
	`changed_areas_json` text NOT NULL,
	`risks_json` text NOT NULL,
	`unresolved_json` text NOT NULL,
	`submitted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verification_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`verification_run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`check_id` text NOT NULL,
	`label` text NOT NULL,
	`command` text NOT NULL,
	`required` integer NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer NOT NULL,
	`output_excerpt` text,
	FOREIGN KEY (`verification_run_id`) REFERENCES `verification_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_checks_run_id_seq_unique` ON `verification_checks` (`verification_run_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_checks_run_id_check_id_unique` ON `verification_checks` (`verification_run_id`,`check_id`);--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`policy_source` text NOT NULL,
	`policy_hash` text,
	`base_commit` text NOT NULL,
	`verification_sha` text,
	`status` text NOT NULL,
	`started_at` text,
	`completed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verification_runs_task_id_created_at` ON `verification_runs` (`task_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `delivery_contract_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `task_branch` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `target_branch` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `base_commit` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `head_commit` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `worktree_clean` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `verification_status` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `verification_run_id` text REFERENCES verification_runs(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `start_payload_hash` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `start_response_json` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `complete_payload_hash` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `complete_response_json` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `fail_payload_hash` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `fail_response_json` text;--> statement-breakpoint
CREATE INDEX `tasks_issue_contract_created` ON `tasks` (`issue_id`,`delivery_contract_version`,`created_at`);