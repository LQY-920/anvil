CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`executable` text NOT NULL,
	`sandbox` text NOT NULL,
	`model` text,
	`config_version` integer NOT NULL DEFAULT 1,
	`capabilities_json` text NOT NULL,
	`auth_state` text NOT NULL,
	`cli_version` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `profile_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `profile_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `profile_config_version` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_snapshot_json` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `cli_version` text;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD `capabilities_json` text;
--> statement-breakpoint
CREATE TABLE `provider_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_ref` text NOT NULL,
	`provider` text NOT NULL,
	`runtime_id` text,
	`task_id` text NOT NULL,
	`profile_id` text,
	`work_dir` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
