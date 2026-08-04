PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_skills` (
	`agent_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_skills`("agent_id", "skill_id") SELECT "agent_id", "skill_id" FROM `agent_skills`;--> statement-breakpoint
DROP TABLE `agent_skills`;--> statement-breakpoint
ALTER TABLE `__new_agent_skills` RENAME TO `agent_skills`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_workspace_members`("workspace_id", "user_id", "role") SELECT "workspace_id", "user_id", "role" FROM `workspace_members`;--> statement-breakpoint
DROP TABLE `workspace_members`;--> statement-breakpoint
ALTER TABLE `__new_workspace_members` RENAME TO `workspace_members`;--> statement-breakpoint
CREATE INDEX `agents_ws` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `daemon_tokens_ws` ON `daemon_tokens` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `skill_files_skill` ON `skill_files` (`skill_id`);